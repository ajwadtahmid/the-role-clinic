// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { serve } from '@hono/node-server'
import { fetch as nodeFetch, Request as NodeRequest, Response as NodeResponse, Headers as NodeHeaders } from 'undici'
import { createApp } from '../../server/src/app.js'
import { createDatabase } from '../../server/src/db.js'
import { saveMaster } from '../../server/src/master.js'
import { emptyMaster, type TaskName } from '../../../packages/shared/src/index.js'
import { randomUUID } from 'node:crypto'
import type { ModelRequest, ModelRouter } from '../../server/src/model-adapters.js'
import { Workspace } from './workspace.js'

const temporaryDirectories: string[] = []
const servers: Array<ReturnType<typeof serve>> = []
afterEach(async () => {
  cleanup()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function setup(modelRouter?: Pick<ModelRouter, 'complete'>) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'role-clinic-workspace-'))
  temporaryDirectories.push(dataDirectory)
  const { sqlite, db } = createDatabase(dataDirectory)
  const reservation = createServer()
  const port = await new Promise<number>((resolve) => reservation.listen(0, '127.0.0.1', () => resolve((reservation.address() as { port: number }).port)))
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  vi.stubGlobal('Request', NodeRequest)
  vi.stubGlobal('Response', NodeResponse)
  vi.stubGlobal('Headers', NodeHeaders)
  const app = createApp({ dataDirectory, sqlite, db, port, webPort: 5173, development: true, modelRouter })
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port })
  servers.push(server)
  await new Promise<void>((resolve) => server.on('listening', () => resolve()))
  ;(window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(`http://127.0.0.1:${port}/`)
  vi.stubGlobal('fetch', (input: string, init: RequestInit = {}) => nodeFetch(`http://127.0.0.1:${port}${input}`, {
    ...init,
    headers: { ...(init.method && init.method !== 'GET' ? { origin: `http://127.0.0.1:${port}` } : {}), ...init.headers },
  } as Parameters<typeof nodeFetch>[1]))
  render(<Workspace />)
  await screen.findByText('No new jobs. Paste a posting to start your Inbox.')
  return { user: userEvent.setup(), sqlite }
}

describe('job workspace flow', () => {
  it('saves a pasted job, records Q&A and application status, and finds the answer again', async () => {
    const { user, sqlite } = await setup()
    await user.type(screen.getByRole('textbox', { name: 'Company' }), 'Acme')
    await user.type(screen.getByRole('textbox', { name: 'Role title' }), 'Software Engineer')
    await user.type(screen.getByRole('textbox', { name: 'Job description' }), 'Build reliable software systems with the engineering team. TypeScript, testing, and cloud experience are useful for this role.')
    await user.click(screen.getByRole('button', { name: 'Save to Inbox' }))
    await screen.findByText('Job saved to your Inbox.')
    expect(sqlite.prepare('SELECT count(*) AS count FROM jobs').get()).toEqual({ count: 1 })

    await user.type(screen.getByRole('textbox', { name: 'Question' }), 'Why Acme?')
    await user.type(screen.getByRole('textbox', { name: 'Answer' }), 'I like building reliable systems.')
    await user.click(screen.getByRole('button', { name: 'Save answer' }))
    await screen.findAllByText('Answer saved for this job.')

    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'applied')
    await user.type(await screen.findByRole('textbox', { name: 'Submitted résumé text (optional)' }), 'Submitted résumé text')
    await user.click(screen.getByRole('checkbox', { name: 'I confirm this résumé and the current answers were submitted.' }))
    await user.click(screen.getByRole('button', { name: 'Confirm application submitted' }))
    await screen.findByText('Status updated to applied.')
    const answer = sqlite.prepare('SELECT answer,submitted_answer AS submittedAnswer FROM job_answers').get()
    expect(answer).toEqual({ answer: 'I like building reliable systems.', submittedAnswer: 'I like building reliable systems.' })
    expect(sqlite.prepare('SELECT submitted_text AS submittedText FROM applications').get()).toEqual({ submittedText: 'Submitted résumé text' })

    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.clear(screen.getByRole('textbox', { name: 'Answer' }))
    await user.type(screen.getByRole('textbox', { name: 'Answer' }), 'I like solving difficult systems problems.')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(sqlite.prepare('SELECT answer,submitted_answer AS submittedAnswer FROM job_answers').get()).toEqual({ answer: 'I like solving difficult systems problems.', submittedAnswer: 'I like building reliable systems.' }))
    await user.click(screen.getByRole('button', { name: /^Tracker/ }))
    await waitFor(() => expect(screen.getByText('Acme', { selector: '.job-card span' })).toBeTruthy())

    await user.type(screen.getByPlaceholderText('Search questions and answer text'), 'solving')
    const library = await screen.findByText('Acme · Software Engineer')
    expect(within(library.closest('article')!).getByText('Why Acme?')).toBeTruthy()
    sqlite.close()
  })

  it('has one labelled primary navigation that marks the current page, and a skip link to the content', async () => {
    const { user, sqlite } = await setup()
    const nav = screen.getByRole('navigation', { name: 'Primary' })
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(['Inbox', 'Tracker', 'Answers', 'Master résumé', 'Profile', 'Settings'])
    expect(within(nav).getByRole('link', { name: 'Inbox' }).getAttribute('aria-current')).toBe('page')
    expect(within(nav).getByRole('link', { name: 'Tracker' }).getAttribute('aria-current')).toBeNull()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Inbox')
    await user.click(screen.getByRole('link', { name: 'Skip to main content' }))
    expect(document.activeElement).toBe(document.getElementById('main'))
    sqlite.close()
  })

  it('filters the job list by view with counts, sorts it, and moves through it with the arrow keys', async () => {
    const { user, sqlite } = await setup()
    const add = (company: string, status: string | null, captured: string) => {
      const id = randomUUID()
      sqlite.prepare('INSERT INTO jobs(id,company,title,captured_at,raw_snapshot,text) VALUES(?,?,?,?,?,?)').run(id, company, 'Engineer', captured, 'raw', 'A long enough job description for the list to show.')
      if (status) sqlite.prepare('INSERT INTO applications(id,job_id,status,notes) VALUES(?,?,?,?)').run(randomUUID(), id, status, '')
    }
    add('Zeta', null, '2026-10-03T00:00:00.000Z'); add('Alpha', 'saved', '2026-10-02T00:00:00.000Z'); add('Mid', 'new', '2026-10-01T00:00:00.000Z'); add('Gone', 'skipped', '2026-09-30T00:00:00.000Z')
    await user.click(screen.getByRole('button', { name: /^All/ }))
    await screen.findByText('Alpha', { selector: '.job-card span' })
    expect(screen.getByRole('button', { name: 'New 2' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: 'Tracker 1' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Skipped 1' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'All 4' }).getAttribute('aria-pressed')).toBe('true')
    const order = () => [...document.querySelectorAll('.job-card')].map((card) => card.querySelectorAll('span')[2]?.textContent?.split(' · ')[0])
    expect(order()).toEqual(['Zeta', 'Alpha', 'Mid', 'Gone'])
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort' }), 'company')
    expect(order()).toEqual(['Alpha', 'Gone', 'Mid', 'Zeta'])
    const cards = [...document.querySelectorAll<HTMLButtonElement>('.job-card')]
    cards[0].focus()
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(cards[1])
    await user.keyboard('{ArrowUp}{ArrowUp}')
    expect(document.activeElement).toBe(cards[0])
    await user.click(screen.getByRole('button', { name: /^Skipped/ }))
    await waitFor(() => expect(document.querySelectorAll('.job-card')).toHaveLength(1))
    sqlite.close()
  })

  it('reviews a URL capture before saving its original response and cleaned text', async () => {
    const { user, sqlite } = await setup()
    const originalFetch = globalThis.fetch
    vi.stubGlobal('fetch', (input: string, init: RequestInit = {}) => input === '/api/capture/url'
      ? Promise.resolve(Response.json({ company: 'Clear', title: 'Engineer', location: 'Remote', url: 'https://job-boards.greenhouse.io/clear/jobs/123', applyUrl: 'https://job-boards.greenhouse.io/clear/jobs/123', text: 'Build useful software for customers and collaborate across a team of product engineers and designers.', rawSnapshot: '{"original":"API response"}', source: 'greenhouse-api', captureMethod: 'greenhouse-api' }))
      : originalFetch(input, init))
    await user.type(screen.getByRole('textbox', { name: 'Job URL (optional)' }), 'https://job-boards.greenhouse.io/clear/jobs/123')
    await user.click(screen.getByRole('button', { name: 'Fetch from URL' }))
    await screen.findByText('Captured via greenhouse-api. Review the fields, then save the job.')
    expect((screen.getByRole('textbox', { name: 'Company' }) as HTMLInputElement).value).toBe('Clear')
    await user.click(screen.getByRole('button', { name: 'Save to Inbox' }))
    await screen.findByText('Job saved to your Inbox.')
    expect(sqlite.prepare('SELECT text,raw_snapshot AS rawSnapshot FROM jobs').get()).toEqual({ text: 'Build useful software for customers and collaborate across a team of product engineers and designers.', rawSnapshot: '{"original":"API response"}' })
    await waitFor(() => expect(screen.getByText('Download original capture')).toBeTruthy())
    sqlite.close()
  })
})

describe('job analysis view', () => {
  it('shows exact JD highlights, knockout basis, gaps, and a tailoring estimate', async () => {
    const modelRouter = { async complete(task: TaskName, _request: ModelRequest) {
      if (task !== 'requirementExtraction') throw new Error('Only extraction should run in this test.')
      return { text: JSON.stringify({ requirements: [
        { quote: 'TypeScript experience is required', kind: 'hard', category: 'skill', skill: 'TypeScript', years: null },
        { quote: '5+ years of experience', kind: 'knockout', category: 'years', skill: '', years: 5 },
      ], seniority: '', vocabulary: ['TypeScript'] }), provider: 'ollama' as const, model: 'fake-local' }
    } }
    const { user, sqlite } = await setup(modelRouter)
    const master = emptyMaster()
    master.roles.push({ id: randomUUID(), company: 'Acme', title: 'Engineer', start: 'January 2025', end: 'Present', bullets: [{ id: randomUUID(), rev: 1, text: 'Built TypeScript APIs for customers', skills: ['TypeScript'], metrics: [], verbs: [], sourceRef: '' }] })
    saveMaster(sqlite, master)
    await user.type(screen.getByRole('textbox', { name: 'Company' }), 'Example')
    await user.type(screen.getByRole('textbox', { name: 'Role title' }), 'Software Engineer')
    await user.type(screen.getByRole('textbox', { name: 'Job description' }), 'TypeScript experience is required. Candidates need 5+ years of experience building software for customers.')
    await user.click(screen.getByRole('button', { name: 'Save to Inbox' }))
    await screen.findByText('Job saved to your Inbox.')
    await user.click(await screen.findByRole('button', { name: 'Extract requirements' }))
    await waitFor(() => expect((sqlite.prepare("SELECT status FROM runs WHERE kind='extract' ORDER BY rowid DESC LIMIT 1").get() as { status: string })?.status).toBe('done'))
    cleanup()
    render(<Workspace />)
    const jobTitle = await screen.findByText('Software Engineer', { selector: '.job-card strong' })
    await user.click(jobTitle.closest('button')!)
    expect(await screen.findByText('TypeScript experience is required', { selector: 'mark' })).toBeTruthy()
    expect((await screen.findAllByText(/years across dated employment roles/)).length).toBeGreaterThan(0)
    expect(await screen.findByText(/Estimated API cost: \$0\.0000/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Tailor résumé' })).toBeTruthy()
    sqlite.close()
  })
})

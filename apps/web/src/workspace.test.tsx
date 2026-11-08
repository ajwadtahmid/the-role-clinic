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
  await screen.findByRole('heading', { name: 'Quickstart' })
  return { user: userEvent.setup(), sqlite }
}

async function addJob(user: ReturnType<typeof userEvent.setup>, company: string, title: string, description: string) {
  await user.click(screen.getByRole('button', { name: 'Add job' }))
  await user.type(screen.getByRole('textbox', { name: 'Company' }), company)
  await user.type(screen.getByRole('textbox', { name: 'Role title' }), title)
  await user.type(screen.getByRole('textbox', { name: 'Job description' }), description)
  await user.click(screen.getByRole('button', { name: 'Save job' }))
  await screen.findByText('Job saved.')
}

describe('job workspace flow', () => {
  it('saves a pasted job, adds it to the Tracker, and records it as applied with the exact text sent', async () => {
    const { user, sqlite } = await setup()
    await addJob(user, 'Acme', 'Software Engineer', 'Build reliable software systems with the engineering team. TypeScript, testing, and cloud experience are useful for this role.')
    expect(sqlite.prepare('SELECT count(*) AS count FROM jobs').get()).toEqual({ count: 1 })
    expect(screen.queryByRole('tab', { name: 'Answers' })).toBeNull()

    await user.selectOptions(await screen.findByRole('combobox', { name: 'Exact status' }), 'saved')
    await screen.findByText('Job saved.')
    expect(sqlite.prepare('SELECT status FROM applications').get()).toEqual({ status: 'saved' })
    // A saved job leaves To review and is listed under Saved.
    await waitFor(() => expect(screen.getByRole('button', { name: 'To review 0' })).toBeTruthy())
    await user.click(screen.getByRole('button', { name: 'Saved 1' }))
    await user.click((await screen.findByText('Acme', { selector: '.job-card span' })).closest('button')!)

    await user.selectOptions(await screen.findByRole('combobox', { name: 'Exact status' }), 'applied')
    await user.type(await screen.findByRole('textbox', { name: 'Submitted résumé text (optional)' }), 'Submitted résumé text')
    await user.click(screen.getByRole('checkbox', { name: 'I confirm this résumé and the current answers were submitted.' }))
    await user.click(screen.getByRole('button', { name: 'Confirm application submitted' }))
    await screen.findByText(/Status updated to applied\./)
    expect(sqlite.prepare('SELECT submitted_text AS submittedText FROM applications').get()).toEqual({ submittedText: 'Submitted résumé text' })
    // An applied job moves to the Tracker: the page says so, links to it, and no longer lists the job.
    expect(screen.getByRole('link', { name: 'View in Tracker' }).getAttribute('href')).toMatch(/^#tracker\?job=/)
    expect(await screen.findByRole('button', { name: 'Saved 0' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Applied/ })).toBeNull()
    expect(screen.getByText(/Applied jobs are in the/).textContent).toContain('(1)')
    sqlite.close()
  })

  it('has one labelled primary navigation that marks the current page, and a skip link to the content', async () => {
    const { user, sqlite } = await setup()
    const nav = screen.getByRole('navigation', { name: 'Primary' })
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(['Jobs', 'Tracker', 'Résumé', 'Settings'])
    expect(within(nav).getByRole('link', { name: 'Jobs' }).getAttribute('aria-current')).toBe('page')
    expect(within(nav).getByRole('link', { name: 'Tracker' }).getAttribute('aria-current')).toBeNull()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Jobs')
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
    add('Zeta', null, '2026-10-03T00:00:00.000Z'); add('Alpha', 'saved', '2026-10-02T00:00:00.000Z'); add('Mid', 'new', '2026-10-01T00:00:00.000Z'); add('Gone', 'skipped', '2026-09-30T00:00:00.000Z'); add('Done', 'applied', '2026-09-29T00:00:00.000Z')
    // The jobs were added behind the page's back, so open it again to list them.
    cleanup(); render(<Workspace />)
    await user.click(await screen.findByRole('button', { name: /^Saved/ })); await user.click(screen.getByRole('button', { name: /^To review/ }))
    await screen.findByText('Zeta', { selector: '.job-card span' })
    expect(screen.getByRole('button', { name: 'To review 2' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Saved 1' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Skipped 1' })).toBeTruthy()
    // Applied jobs are in the Tracker, so Jobs has no chip for them.
    expect(screen.queryByRole('button', { name: /^Applied/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^All/ })).toBeNull()
    const order = () => [...document.querySelectorAll('.job-card')].map((card) => card.querySelectorAll('span')[1]?.textContent?.split(' · ')[0])
    expect(order()).toEqual(['Zeta', 'Mid'])
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort' }), 'company')
    expect(order()).toEqual(['Mid', 'Zeta'])
    const cards = [...document.querySelectorAll<HTMLButtonElement>('.job-card')]
    cards[0].focus()
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(cards[1])
    await user.keyboard('{ArrowUp}{ArrowUp}')
    expect(document.activeElement).toBe(cards[0])
    await user.click(screen.getByRole('button', { name: /^Saved/ }))
    await waitFor(() => expect(order()).toEqual(['Alpha']))
    await user.click(screen.getByRole('button', { name: /^Skipped/ }))
    await waitFor(() => expect(order()).toEqual(['Gone']))
    sqlite.close()
  })

  it('opens a job from its address, keeps the older #job/ form working, and shows one primary step for it', async () => {
    const { user, sqlite } = await setup()
    const id = randomUUID()
    sqlite.prepare('INSERT INTO jobs(id,company,title,captured_at,raw_snapshot,text) VALUES(?,?,?,?,?,?)').run(id, 'Orbit', 'Platform Engineer', '2026-10-03T00:00:00.000Z', 'raw', 'A long enough job description for the list to show.')
    sqlite.prepare('INSERT INTO applications(id,job_id,status,notes) VALUES(?,?,?,?)').run(randomUUID(), id, 'saved', '')
    cleanup()
    window.location.hash = `#job/${id}`
    render(<Workspace />)
    expect(await screen.findByRole('heading', { level: 2, name: 'Platform Engineer' })).toBeTruthy()
    expect(window.location.hash).toBe(`#jobs/${id}`)
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Overview', 'Résumé'])
    await waitFor(() => expect(screen.getByRole('button', { name: /^Saved/ }).getAttribute('aria-pressed')).toBe('true'))
    // Before a fit check, both choices are offered: tailor straight away, or only check the fit.
    expect(screen.getByRole('button', { name: 'Check fit' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Tailor résumé' })).toBeTruthy()
    await user.click(screen.getByRole('tab', { name: 'Résumé' }))
    expect(screen.getByText(/Check the fit first/)).toBeTruthy()
    await user.keyboard('{ArrowLeft}')
    expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true')
    await user.click(screen.getByRole('button', { name: '← All jobs' }))
    expect(window.location.hash).toBe('#jobs')
    await screen.findByRole('heading', { name: 'Select a job' })
    window.location.hash = ''
    sqlite.close()
  })

  it('shows a waiting, running or failed fit check on the job card, under the header and on the main button', async () => {
    const { user, sqlite } = await setup()
    const add = (company: string, status: string, error: string | null) => {
      const id = randomUUID()
      sqlite.prepare('INSERT INTO jobs(id,company,title,captured_at,raw_snapshot,text) VALUES(?,?,?,?,?,?)').run(id, company, 'Engineer', new Date().toISOString(), 'raw', 'A long enough job description for the list to show.')
      sqlite.prepare("INSERT INTO runs(id,job_id,kind,status,step,prompt_versions,created_at,error) VALUES(?,?,'extract',?,?,'{}',?,?)").run(randomUUID(), id, status, status === 'failed' ? 'extracting' : 'queued', new Date().toISOString(), error)
    }
    add('Wait', 'running', null); add('Broke', 'failed', 'The model did not answer.')
    cleanup()
    render(<Workspace />)
    await screen.findByText('Checking…', { selector: '.run-badge' })
    expect(screen.getByText('Check failed', { selector: '.run-badge' })).toBeTruthy()
    await user.click(screen.getByText('Broke', { selector: '.job-card span' }).closest('button')!)
    expect((await screen.findByText(/Fit check failed: The model did not answer\./)).textContent).toContain('failed')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    await user.click(screen.getByText('Wait', { selector: '.job-card span' }).closest('button')!)
    const button = await screen.findByRole('button', { name: 'Checking…', hidden: false })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/Fit check is running/)).toBeTruthy()
    window.location.hash = ''
    sqlite.close()
  })

  it('sends an old #jobs/<id>?answers address to the job in the Tracker', async () => {
    const { sqlite } = await setup()
    cleanup()
    window.location.hash = '#jobs/abc123?answers'
    render(<Workspace />)
    await waitFor(() => expect(window.location.hash).toBe('#tracker?job=abc123'))
    window.location.hash = ''
    sqlite.close()
  })

  it('shows the Quickstart only while there are no jobs, and the dialog closes with Escape', async () => {
    const { user, sqlite } = await setup()
    expect(screen.getByRole('link', { name: /Add your résumé/ })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Add your first job' }))
    expect(screen.getByRole('dialog', { name: 'Add a job' })).toBeTruthy()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    sqlite.prepare('INSERT INTO jobs(id,company,title,captured_at,raw_snapshot,text) VALUES(?,?,?,?,?,?)').run(randomUUID(), 'Acme', 'Engineer', new Date().toISOString(), 'raw', 'A long enough job description for the list to show.')
    cleanup()
    render(<Workspace />)
    await screen.findByText('Engineer', { selector: '.job-card strong' })
    expect(screen.queryByRole('heading', { name: 'Quickstart' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Hide quickstart' })).toBeNull()
    sqlite.close()
  })

  it('lists a long stage 50 at a time and shows an applied job on its own with a way back to the Tracker', async () => {
    const { sqlite } = await setup()
    const now = new Date().toISOString()
    for (let i = 0; i < 60; i++) sqlite.prepare('INSERT INTO jobs(id,company,title,captured_at,raw_snapshot,text) VALUES(?,?,?,?,?,?)').run(randomUUID(), `Company ${i}`, 'Engineer', now, 'raw', 'A long enough job description for the list to show.')
    const applied = randomUUID()
    sqlite.prepare('INSERT INTO jobs(id,company,title,captured_at,raw_snapshot,text) VALUES(?,?,?,?,?,?)').run(applied, 'Orbit', 'Platform Engineer', now, 'raw', 'A long enough job description for the list to show.')
    sqlite.prepare('INSERT INTO applications(id,job_id,status,applied_at,notes) VALUES(?,?,?,?,?)').run(randomUUID(), applied, 'applied', now, '')
    cleanup()
    render(<Workspace />)
    await screen.findByText('Company 0', { selector: '.job-card span' })
    await waitFor(() => expect(document.querySelectorAll('.job-card')).toHaveLength(50))
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Show 10 more (10 left)' }))
    expect(document.querySelectorAll('.job-card')).toHaveLength(60)
    cleanup()
    window.location.hash = `#jobs/${applied}`
    render(<Workspace />)
    expect(await screen.findByRole('heading', { level: 2, name: 'Platform Engineer' })).toBeTruthy()
    expect(screen.getByRole('link', { name: '← Back to Tracker' }).getAttribute('href')).toBe(`#tracker?job=${applied}`)
    expect(document.querySelector('.jobs-layout.detail-only')).toBeTruthy()
    window.location.hash = ''
    sqlite.close()
  })

  it('reviews a URL capture before saving its original response and cleaned text', async () => {
    const { user, sqlite } = await setup()
    const originalFetch = globalThis.fetch
    vi.stubGlobal('fetch', (input: string, init: RequestInit = {}) => input === '/api/capture/url'
      ? Promise.resolve(Response.json({ company: 'Clear', title: 'Engineer', location: 'Remote', url: 'https://job-boards.greenhouse.io/clear/jobs/123', applyUrl: 'https://job-boards.greenhouse.io/clear/jobs/123', text: 'Build useful software for customers and collaborate across a team of product engineers and designers.', rawSnapshot: '{"original":"API response"}', source: 'greenhouse-api', captureMethod: 'greenhouse-api' }))
      : originalFetch(input, init))
    await user.click(screen.getByRole('button', { name: 'Add job' }))
    await user.click(screen.getByRole('button', { name: 'From a link' }))
    await user.type(screen.getByRole('textbox', { name: 'Job link' }), 'https://job-boards.greenhouse.io/clear/jobs/123')
    await user.click(screen.getByRole('button', { name: 'Fetch details' }))
    await screen.findByText('Captured via greenhouse-api. Review the fields, then save the job.')
    expect((screen.getByRole('textbox', { name: 'Company' }) as HTMLInputElement).value).toBe('Clear')
    await user.click(screen.getByRole('button', { name: 'Save job' }))
    await screen.findByText('Job saved.')
    expect(sqlite.prepare('SELECT text,raw_snapshot AS rawSnapshot FROM jobs').get()).toEqual({ text: 'Build useful software for customers and collaborate across a team of product engineers and designers.', rawSnapshot: '{"original":"API response"}' })
    await waitFor(() => expect(screen.getByText('Download original capture')).toBeTruthy())
    sqlite.close()
  })
})

describe('job analysis view', () => {
  it('runs the fit check first when Tailor résumé is chosen before one exists', async () => {
    const modelRouter = { async complete(task: TaskName, _request: ModelRequest) {
      if (task !== 'requirementExtraction') throw new Error('Only extraction should run in this test.')
      return { text: JSON.stringify({ requirements: [{ quote: 'TypeScript experience is required', kind: 'hard', category: 'skill', skill: 'TypeScript', years: null }], seniority: '', vocabulary: ['TypeScript'] }), provider: 'ollama' as const, model: 'fake-local' }
    } }
    const { user, sqlite } = await setup(modelRouter)
    const master = emptyMaster()
    master.roles.push({ id: randomUUID(), company: 'Acme', title: 'Engineer', start: 'January 2025', end: 'Present', bullets: [{ id: randomUUID(), rev: 1, text: 'Built TypeScript APIs for customers', skills: ['TypeScript'], metrics: [], verbs: [], sourceRef: '' }] })
    saveMaster(sqlite, master)
    await addJob(user, 'Example', 'Software Engineer', 'TypeScript experience is required. Candidates build software for customers.')
    await user.click(await screen.findByRole('button', { name: 'Tailor résumé' }))
    await waitFor(() => expect((sqlite.prepare("SELECT status FROM runs WHERE kind='extract' ORDER BY rowid DESC LIMIT 1").get() as { status: string })?.status).toBe('done'))
    sqlite.close()
  })

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
    await addJob(user, 'Example', 'Software Engineer', 'TypeScript experience is required. Candidates need 5+ years of experience building software for customers.')
    await user.click(await screen.findByRole('button', { name: 'Check fit' }))
    await waitFor(() => expect((sqlite.prepare("SELECT status FROM runs WHERE kind='extract' ORDER BY rowid DESC LIMIT 1").get() as { status: string })?.status).toBe('done'))
    cleanup()
    window.location.hash = ''
    render(<Workspace />)
    const jobTitle = await screen.findByText('Software Engineer', { selector: '.job-card strong' })
    await user.click(jobTitle.closest('button')!)
    expect(await screen.findByText('TypeScript experience is required', { selector: 'mark' })).toBeTruthy()
    expect((await screen.findAllByText(/years across dated employment roles/)).length).toBeGreaterThan(0)
    await user.click(await screen.findByRole('button', { name: 'Save job' }))
    await user.click(await screen.findByRole('button', { name: /^Saved/ }))
    await user.click((await screen.findByText('Software Engineer', { selector: '.job-card strong' })).closest('button')!)
    expect(await screen.findByText(/Estimated API cost: \$0\.0000/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Tailor résumé' })).toBeTruthy()
    sqlite.close()
  })
})

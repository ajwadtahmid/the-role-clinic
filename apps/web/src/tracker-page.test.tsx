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
import { TrackerPage } from './tracker-page.js'
import { AnswerLibrary } from './answers.js'

const resources: Array<{ server: ReturnType<typeof serve>; sqlite: ReturnType<typeof createDatabase>['sqlite']; directory: string }> = []
afterEach(async () => {
  cleanup()
  for (const { server, sqlite, directory } of resources.splice(0)) { await new Promise<void>((resolve) => server.close(() => resolve())); sqlite.close(); await rm(directory, { recursive: true, force: true }) }
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'clinic-tracker-ui-')), { sqlite, db } = createDatabase(directory)
  const reservation = createServer()
  const port = await new Promise<number>((resolve, reject) => { reservation.on('error', reject); reservation.listen(0, '127.0.0.1', () => resolve((reservation.address() as { port: number }).port)) })
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  vi.stubGlobal('Request', NodeRequest); vi.stubGlobal('Response', NodeResponse); vi.stubGlobal('Headers', NodeHeaders)
  const app = createApp({ dataDirectory: directory, sqlite, db, port, modelRouter: { async complete() { throw new Error('No inference permitted') } } })
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }); resources.push({ server, sqlite, directory })
  await new Promise<void>((resolve, reject) => { server.on('error', reject); server.on('listening', resolve) })
  ;(window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(`http://127.0.0.1:${port}/`)
  vi.stubGlobal('fetch', (input: string, init: RequestInit = {}) => nodeFetch(`http://127.0.0.1:${port}${input}`, { ...init, headers: { origin: `http://127.0.0.1:${port}`, ...init.headers } } as Parameters<typeof nodeFetch>[1]))
  async function send(path: string, value: unknown, method = 'POST') { const response = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }); if (!response.ok) throw new Error(await response.text()); return response.json() }
  async function job(company: string) { return (await send('/api/jobs', { company, title: 'Software Engineer', text: 'Build reliable TypeScript software systems and application APIs with our engineering team.' })).id as string }
  const acme = await job('Acme'), globex = await job('Globex'), initech = await job('Initech')
  const answer = await send(`/api/jobs/${acme}/answers`, { question: 'Why join our company?', answer: 'I want to join Acme to build reliable systems.', category: 'why-us' })
  await send(`/api/jobs/${acme}/status`, { status: 'applied', submittedText: 'Original résumé text, frozen at submission.' }, 'PUT')
  await send(`/api/jobs/${acme}/status`, { status: 'interviewing' }, 'PUT')
  await send(`/api/jobs/${globex}/status`, { status: 'saved' }, 'PUT')
  await send(`/api/jobs/${initech}/status`, { status: 'applied', submittedText: 'Initech résumé text.' }, 'PUT')
  await send(`/api/jobs/${acme}/tracker`, { followUpDate: '2026-01-01', lastContactAt: null, contacts: '', notes: '' }, 'PUT')
  return { sqlite, acme, globex, initech, send, sourceAnswerId: answer.id as string, user: userEvent.setup() }
}
describe('tracker browser flows', () => {
  it('shows a tracker table, records a follow-up, opens the exact submitted record and filters exports', async () => {
    const { sqlite, acme, user } = await setup()
    render(<TrackerPage />)
    const table = await screen.findByRole('table')
    expect(within(table).getByRole('button', { name: 'Acme Software Engineer' })).toBeTruthy()
    await user.click(within(table).getByRole('button', { name: 'Acme Software Engineer' }))
    await user.type(screen.getByRole('textbox', { name: 'Contacts' }), 'Recruiter Jane')
    await user.type(screen.getByRole('textbox', { name: 'Application notes' }), 'Ask about interview timing.')
    await user.click(screen.getByRole('button', { name: 'Save tracker details' }))
    await screen.findByText('Tracker details saved.')
    expect((sqlite.prepare('SELECT contacts,notes FROM applications WHERE job_id=?').get(acme))).toEqual({ contacts: 'Recruiter Jane', notes: 'Ask about interview timing.' })
    await user.click(screen.getByRole('button', { name: 'Mark follow-up done today' }))
    await screen.findByText('Follow-up completed; last contact recorded today.')
    expect((sqlite.prepare('SELECT follow_up_date FROM applications WHERE job_id=?').get(acme))).toEqual({ follow_up_date: null })
    await user.click(within(within(table).getByRole('button', { name: 'Acme Software Engineer' }).closest('tr')!).getByRole('button', { name: 'Recorded résumé text' }))
    await screen.findByText('Original résumé text, frozen at submission.')
    expect((await screen.findAllByText('I want to join Acme to build reliable systems.')).length).toBeGreaterThan(0)
    // A job that is only saved belongs to Jobs, so the Tracker never lists it.
    expect(within(table).queryByRole('button', { name: 'Globex Software Engineer' })).toBeNull()
    expect(within(screen.getByRole('combobox', { name: 'Filter company' })).queryByRole('option', { name: 'Globex' })).toBeNull()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter company' }), 'Initech')
    expect(within(table).queryByRole('button', { name: 'Acme Software Engineer' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Export XLSX' }).getAttribute('href')).toContain('company=Initech')
    expect(within(table).getByRole('button', { name: /^No answers yet/ })).toBeTruthy()
  })
  it('opens a job’s questions and answers from the Q&A column, edits the working copy, and keeps the submitted snapshot', async () => {
    const { sqlite, acme, user } = await setup()
    render(<TrackerPage />)
    const table = await screen.findByRole('table')
    await user.click(within(table).getByRole('button', { name: /^1 question/ }))
    expect(await screen.findByText('Questions and answers (1)')).toBeTruthy()
    expect(screen.getAllByText('I want to join Acme to build reliable systems.').length).toBeGreaterThan(0)
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const answer = screen.getByRole('textbox', { name: 'Answer' })
    await user.clear(answer); await user.type(answer, 'I want to build dependable systems at Acme.')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(sqlite.prepare('SELECT answer,submitted_answer AS submitted FROM job_answers WHERE job_id=?').get(acme)).toEqual({ answer: 'I want to build dependable systems at Acme.', submitted: 'I want to join Acme to build reliable systems.' }))
    await user.click(screen.getByText('Status history'))
    expect(await screen.findByText('Interviewing', { selector: '.history-list strong' })).toBeTruthy()
  })
  it('adapts a library answer, flags source-company text, enforces limits, and preserves provenance and submitted text', async () => {
    const { sqlite, acme, globex, sourceAnswerId, user } = await setup()
    render(<AnswerLibrary />)
    await user.click(await screen.findByRole('button', { name: 'Reuse answer' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Target application' }), globex)
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Mentions Acme — this application is for Globex.')
    const answer = screen.getByRole('textbox', { name: 'Answer' })
    await user.clear(answer); await user.type(answer, 'I want to join Globex to build reliable systems.')
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    await user.type(screen.getByRole('spinbutton', { name: 'Character limit (optional)' }), '10')
    expect((screen.getByRole('button', { name: 'Save answer' }) as HTMLButtonElement).disabled).toBe(true)
    await user.clear(screen.getByRole('spinbutton', { name: 'Character limit (optional)' }))
    await user.click(screen.getByRole('button', { name: 'Save answer' }))
    await screen.findByText('Answer saved for this job.')
    expect(sqlite.prepare('SELECT answer,reused_from FROM job_answers WHERE job_id=?').get(globex)).toEqual({ answer: 'I want to join Globex to build reliable systems.', reused_from: sourceAnswerId })
    expect((sqlite.prepare('SELECT submitted_answer FROM job_answers WHERE job_id=?').get(acme) as { submitted_answer: string }).submitted_answer).toBe('I want to join Acme to build reliable systems.')
    await user.type(screen.getByRole('textbox', { name: 'Search answers' }), 'Globex')
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Reuse answer' })).toHaveLength(1))
  })

  it('shows stage tabs with counts, a one-line funnel and follow-ups only when something is due', async () => {
    const { sqlite, user } = await setup()
    render(<TrackerPage />)
    const table = await screen.findByRole('table')
    const tab = (name: string) => screen.getByRole('button', { name })
    expect(tab('All 2').getAttribute('aria-pressed')).toBe('true')
    expect(tab('Applied 1')).toBeTruthy(); expect(tab('Interviewing 1')).toBeTruthy(); expect(tab('Offer 0')).toBeTruthy(); expect(tab('Closed 0')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Saved/ })).toBeNull()
    expect(within(screen.getByLabelText(/Application funnel/)).getByText('Interviewing')).toBeTruthy()
    await user.click(tab('Interviewing 1'))
    expect(within(table).getByRole('button', { name: 'Acme Software Engineer' })).toBeTruthy()
    expect(within(table).queryByRole('button', { name: 'Initech Software Engineer' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Export XLSX' }).getAttribute('href')).toContain('status=interviewing')
    cleanup()
    sqlite.prepare('UPDATE applications SET follow_up_date=NULL').run()
    render(<TrackerPage />)
    await screen.findByRole('table')
    expect(screen.queryByRole('region', { name: 'Follow-ups' })).toBeNull()
  })

  it('opens a job’s details beside the table, closes them with Escape, and shows long lists 50 at a time', async () => {
    const { sqlite, user } = await setup()
    const now = new Date().toISOString()
    for (let i = 0; i < 60; i++) {
      const id = `bulk-${String(i).padStart(2, '0')}`
      sqlite.prepare('INSERT INTO jobs(id,company,title,captured_at,raw_snapshot,text) VALUES(?,?,?,?,?,?)').run(id, `Bulk ${String(i).padStart(2, '0')}`, 'Engineer', now, 'raw', 'A long enough job description for the table to show.')
      sqlite.prepare('INSERT INTO applications(id,job_id,status,applied_at,notes,contacts) VALUES(?,?,?,?,?,?)').run(`app-${id}`, id, 'applied', now, '', '')
    }
    render(<TrackerPage />)
    const table = await screen.findByRole('table')
    expect(within(table).getAllByRole('row')).toHaveLength(51) // header and 50 rows
    expect(screen.getByText('1 to 50 of 62')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('51 to 62 of 62')).toBeTruthy()
    expect(within(table).getAllByRole('row')).toHaveLength(13)
    await user.type(screen.getByLabelText('Search applications'), 'Acme')
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull()
    await user.click(within(table).getByRole('button', { name: 'Acme Software Engineer' }))
    const panel = screen.getByRole('complementary', { name: 'Details for Acme' })
    expect(within(panel).getByRole('link', { name: 'Open job and résumé' }).getAttribute('href')).toMatch(/^#jobs\//)
    expect(screen.getByRole('table')).toBeTruthy()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('complementary', { name: 'Details for Acme' })).toBeNull()
  })
})

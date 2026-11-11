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
import { setAiFeatures } from './ai-features.js'
import { Workspace } from './workspace.js'

const directories: string[] = []
const servers: Array<ReturnType<typeof serve>> = []
const databases: Array<{ close(): unknown }> = []
afterEach(async () => {
  cleanup()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  // Windows will not delete a database file that is still open.
  for (const database of databases.splice(0)) database.close()
  vi.unstubAllGlobals()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

// A real server with one saved job, and the page not yet rendered.
async function setup() {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'role-clinic-modes-')); directories.push(dataDirectory)
  const { sqlite, db } = createDatabase(dataDirectory); databases.push(sqlite)
  const reservation = createServer()
  const port = await new Promise<number>((resolve) => reservation.listen(0, '127.0.0.1', () => resolve((reservation.address() as { port: number }).port)))
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  vi.stubGlobal('Request', NodeRequest); vi.stubGlobal('Response', NodeResponse); vi.stubGlobal('Headers', NodeHeaders)
  const server = serve({ fetch: createApp({ dataDirectory, sqlite, db, port, webPort: 5173, development: true }).fetch, hostname: '127.0.0.1', port })
  servers.push(server)
  await new Promise<void>((resolve) => server.on('listening', () => resolve()))
  ;(window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(`http://127.0.0.1:${port}/`)
  vi.stubGlobal('fetch', (input: string, init: RequestInit = {}) => nodeFetch(`http://127.0.0.1:${port}${input}`, { ...init, headers: { ...(init.method && init.method !== 'GET' ? { origin: `http://127.0.0.1:${port}` } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers } } as Parameters<typeof nodeFetch>[1]))
  const created = await (await fetch('/api/jobs', { method: 'POST', body: JSON.stringify({ company: 'Acme Robotics', title: 'Platform Engineer', text: 'Build internal tooling for the platform team. SQL and a collaborative mindset are needed.' }) })).json() as { id: string }
  return { user: userEvent.setup(), sqlite, jobId: created.id, status: async () => ((await (await fetch(`/api/jobs/${created.id}`)).json()) as { job: { status: string; appliedAt: string | null } }).job }
}

describe('tracker mode (AI features off)', () => {
  it('shows no fit meters, batch checks, Fit tab or Résumé link, and marks a job applied in one click with an Undo that puts it back', async () => {
    const { user, jobId, status, sqlite } = await setup()
    await setAiFeatures({ enabled: false })
    window.location.hash = `#jobs/${jobId}`
    render(<Workspace />)
    const apply = await screen.findByRole('button', { name: 'Mark as applied' })
    expect(screen.queryByRole('button', { name: 'Check fits' })).toBeNull()
    expect(screen.queryByRole('tab', { name: /Fit check/ })).toBeNull()
    expect(screen.queryByText('Not checked')).toBeNull()
    expect(screen.queryByRole('button', { name: /Tailor résumé/ })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Résumé' })).toBeNull()
    expect(within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', { name: 'Tracker' })).toBeTruthy()
    await user.click(apply)
    // One click: no "Record what you submitted" form, and the job description is kept with the application.
    await waitFor(async () => expect((await status()).status).toBe('applied'))
    expect(screen.queryByText('Record what you submitted')).toBeNull()
    expect((sqlite.prepare('SELECT submitted_job_text AS t FROM applications').get() as { t: string }).t).toContain('Build internal tooling')
    await user.click(await screen.findByRole('button', { name: 'Undo' }))
    await waitFor(async () => expect(await status()).toMatchObject({ status: 'new', appliedAt: null }))
    window.location.hash = ''
  })

  it('brings the AI parts back when AI features are on, and hides them again with one switch', async () => {
    const { jobId } = await setup()
    await setAiFeatures({ enabled: true })
    window.location.hash = `#jobs/${jobId}`
    render(<Workspace />)
    expect(await screen.findByRole('tab', { name: /Fit check/ })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Résumé' })).toBeTruthy()
    await setAiFeatures({ hidden: true })
    await waitFor(() => expect(screen.queryByRole('tab', { name: /Fit check/ })).toBeNull())
    expect(screen.queryByRole('link', { name: 'Résumé' })).toBeNull()
    await setAiFeatures({ hidden: false })
    expect(await screen.findByRole('tab', { name: /Fit check/ })).toBeTruthy()
    window.location.hash = ''
  })

  it('saves jobs with only a company and a title, one after another, and can record one as already applied', async () => {
    const { user, sqlite } = await setup()
    await setAiFeatures({ enabled: false })
    render(<Workspace />)
    await user.click(await screen.findByRole('button', { name: 'Add job' }))
    await user.type(screen.getByRole('textbox', { name: 'Company' }), 'Globex')
    await user.type(screen.getByRole('textbox', { name: 'Role title' }), 'Analyst')
    await user.click(screen.getByRole('button', { name: 'Save and add another' }))
    expect((await screen.findByRole('status')).textContent).toContain('Saved Analyst at Globex. Add the next one.')
    // The form is empty again and still open for the next job.
    expect((screen.getByRole('textbox', { name: 'Company' }) as HTMLInputElement).value).toBe('')
    await user.type(screen.getByRole('textbox', { name: 'Company' }), 'Initech')
    await user.type(screen.getByRole('textbox', { name: 'Role title' }), 'Data Analyst')
    await user.click(screen.getByRole('checkbox', { name: 'I already applied to this job' }))
    await user.click(screen.getByRole('button', { name: 'Save job' }))
    await waitFor(() => expect(sqlite.prepare("SELECT COUNT(*) AS n FROM jobs WHERE company IN ('Globex','Initech')").get()).toEqual({ n: 2 }))
    await waitFor(() => expect(sqlite.prepare("SELECT a.status FROM applications a JOIN jobs j ON j.id=a.job_id WHERE j.company='Initech'").get()).toEqual({ status: 'applied' }))
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM applications a JOIN jobs j ON j.id=a.job_id WHERE j.company='Globex'").get()).toEqual({ n: 0 })
  })
})

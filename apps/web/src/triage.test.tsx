// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { serve } from '@hono/node-server'
import { fetch as nodeFetch, Request as NodeRequest, Response as NodeResponse, Headers as NodeHeaders } from 'undici'
import { createApp } from '../../server/src/app.js'
import { createDatabase } from '../../server/src/db.js'
import { defaultSettings, writeSettings } from '../../server/src/settings.js'
import { Workspace } from './workspace.js'

const directories: string[] = []
const servers: Array<ReturnType<typeof serve>> = []
afterEach(async () => {
  cleanup()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const HEADER = 'Job Title,Company,Apply Link,Date Found,Priority,Location,Work Arrangement,Required Qualifications,Missing Skills / Flags,Why It Fits,Source'
const csv = [HEADER,
  'Platform Engineer,Acme,https://acme.test/jobs/1,2026-11-05,Medium,Austin,Hybrid,Python and Go,Citizenship; On-site,FINDER_WHY_TEXT,Careers page',
  'Data Analyst,Beta,https://beta.test/jobs/2,2026-11-06,High,Remote,Remote,SQL,,Strong SQL match,Careers page'].join('\n') + '\n'

async function setup(withFeed = true) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'role-clinic-triage-')); directories.push(dataDirectory)
  const { sqlite, db } = createDatabase(dataDirectory)
  if (withFeed) {
    const path = join(dataDirectory, 'jobs.csv')
    await writeFile(path, csv)
    await writeSettings(dataDirectory, { ...defaultSettings(), jobFeed: { path } })
  }
  const reservation = createServer()
  const port = await new Promise<number>((resolve) => reservation.listen(0, '127.0.0.1', () => resolve((reservation.address() as { port: number }).port)))
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  vi.stubGlobal('Request', NodeRequest); vi.stubGlobal('Response', NodeResponse); vi.stubGlobal('Headers', NodeHeaders)
  const postingCapture = async (url: string) => ({ text: `Full posting for ${url}. ${'Build and run services. '.repeat(4)}`, rawSnapshot: 'x', url, applyUrl: url })
  const app = createApp({ dataDirectory, sqlite, db, port, webPort: 5173, development: true, postingCapture, feedSpacingMs: 0 })
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port })
  servers.push(server)
  await new Promise<void>((resolve) => server.on('listening', () => resolve()))
  ;(window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(`http://127.0.0.1:${port}/`)
  vi.stubGlobal('fetch', (input: string, init: RequestInit = {}) => nodeFetch(`http://127.0.0.1:${port}${input}`, { ...init, headers: { ...(init.method && init.method !== 'GET' ? { origin: `http://127.0.0.1:${port}` } : {}), ...init.headers } } as Parameters<typeof nodeFetch>[1]))
  if (withFeed) await fetch('/api/feed/refresh', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
  window.location.hash = '#jobs'
  render(<Workspace />)
  return { user: userEvent.setup(), sqlite }
}

describe('Triage', () => {
  it('opens on Triage with prioritized cards, badges and a count, and keeps them out of Active', async () => {
    const { user, sqlite } = await setup()
    const chip = await screen.findByRole('button', { name: /^Triage/ })
    await waitFor(() => expect(chip.getAttribute('aria-pressed')).toBe('true'))
    expect(within(chip).getByText('2')).toBeTruthy()
    await screen.findByText('Platform Engineer', { selector: '.job-card strong' })
    const titles = [...document.querySelectorAll('.job-card strong')].map((node) => node.textContent)
    expect(titles).toEqual(['Data Analyst', 'Platform Engineer']) // High before Medium
    expect(screen.getByText('Flags (2)')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Check for new jobs' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /^Active/ }))
    await waitFor(() => expect(screen.getByText('No jobs in progress here.')).toBeTruthy())
    sqlite.close()
  })

  it('shows the finder notes as unverified and offers Track, Already applied and Skip', async () => {
    const { user, sqlite } = await setup()
    await user.click((await screen.findByText('Platform Engineer', { selector: '.job-card strong' })).closest('button')!)
    const panel = await screen.findByRole('region', { name: 'From your job finder' })
    expect(within(panel).getByText('FINDER_WHY_TEXT')).toBeTruthy()
    expect(within(panel).getByText('Citizenship')).toBeTruthy()
    expect(within(panel).getByText(/has not checked it/)).toBeTruthy()
    const group = screen.getByRole('group', { name: 'Decide about this job' })
    expect(within(group).getByRole('button', { name: 'Track this job' })).toBeTruthy()
    await user.click(within(group).getByRole('button', { name: 'Skip' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /^Skipped/ }).textContent).toContain('1'))
    expect(screen.getByRole('button', { name: /^Triage/ }).textContent).toContain('1')
    sqlite.close()
  })

  it('records an application with no résumé file, as the master résumé', async () => {
    const { user, sqlite } = await setup()
    await user.click((await screen.findByText('Data Analyst', { selector: '.job-card strong' })).closest('button')!)
    await user.click(await screen.findByRole('button', { name: 'Already applied' }))
    expect(await screen.findByRole('option', { name: 'No file: I used my master résumé' })).toBeTruthy()
    await user.click(screen.getByLabelText(/I confirm this résumé/))
    await user.click(screen.getByRole('button', { name: 'Confirm application submitted' }))
    await waitFor(() => expect(sqlite.prepare('SELECT status,submitted_artifact_id AS a FROM applications').get()).toMatchObject({ status: 'applied', a: null }))
    expect((sqlite.prepare('SELECT submitted_job_text AS t FROM applications').get() as { t: string }).t).toContain('Full posting for https://beta.test')
    sqlite.close()
  })

  it('hides Triage and the feed button when no feed is set', async () => {
    const { sqlite } = await setup(false)
    await screen.findByRole('button', { name: 'Add job' })
    expect(screen.queryByRole('button', { name: /^Triage/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Check for new jobs' })).toBeNull()
    sqlite.close()
  })
})

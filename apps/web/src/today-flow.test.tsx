// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { serve } from '@hono/node-server'
import { fetch as nodeFetch, Request as NodeRequest, Response as NodeResponse, Headers as NodeHeaders } from 'undici'
import { createApp } from '../../server/src/app.js'
import { createDatabase } from '../../server/src/db.js'
import { TodayPage } from './today-page.js'
import { ReviewFlow } from './review-flow.js'
import { CommandPalette } from './command-palette.js'
import { QAPage } from './qa-page.js'
import { calendarDate } from '../../../packages/shared/src/index.js'

const directories: string[] = []
const servers: Array<ReturnType<typeof serve>> = []
afterEach(async () => {
  cleanup()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function setup(ui: React.ReactElement, seed?: (db: ReturnType<typeof createDatabase>['sqlite']) => void) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'role-clinic-today-flow-')); directories.push(dataDirectory)
  const { sqlite, db } = createDatabase(dataDirectory)
  seed?.(sqlite)
  const reservation = createServer()
  const port = await new Promise<number>((resolve) => reservation.listen(0, '127.0.0.1', () => resolve((reservation.address() as { port: number }).port)))
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  vi.stubGlobal('Request', NodeRequest); vi.stubGlobal('Response', NodeResponse); vi.stubGlobal('Headers', NodeHeaders)
  const app = createApp({ dataDirectory, sqlite, db, port, webPort: 5173, development: true })
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port })
  servers.push(server)
  await new Promise<void>((resolve) => server.on('listening', () => resolve()))
  ;(window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(`http://127.0.0.1:${port}/`)
  vi.stubGlobal('fetch', (input: string, init: RequestInit = {}) => nodeFetch(`http://127.0.0.1:${port}${input}`, { ...init, headers: { ...(init.method && init.method !== 'GET' ? { origin: `http://127.0.0.1:${port}` } : {}), ...init.headers } } as Parameters<typeof nodeFetch>[1]))
  render(ui)
  return { user: userEvent.setup(), sqlite }
}


const setupWith = (seed: (db: ReturnType<typeof createDatabase>['sqlite']) => void, ui: React.ReactElement = <TodayPage />) => setup(ui, seed)
function addJob(sqlite: ReturnType<typeof createDatabase>['sqlite'], company: string, title: string, status: string | null, extra: { applied?: string; follow?: string } = {}) {
  const id = randomUUID()
  sqlite.prepare('INSERT INTO jobs(id,company,title,captured_at,raw_snapshot,text) VALUES(?,?,?,?,?,?)').run(id, company, title, '2026-11-01T12:00:00.000Z', 'raw', `${title} at ${company}. ${'Build things. '.repeat(5)}`)
  if (status) sqlite.prepare('INSERT INTO applications(id,job_id,status,applied_at,follow_up_date) VALUES(?,?,?,?,?)').run(randomUUID(), id, status, extra.applied ?? null, extra.follow ?? null)
  return id
}

describe('Today', () => {
  it('lists due follow-ups, counts the week, and keeps the weekly goal off until one is set', async () => {
    const { sqlite } = await setup(<TodayPage />)
    // The page loaded with no jobs: the empty state, with no goal shown.
    expect(await screen.findByText('Nothing here yet. Add your first job to get started.')).toBeTruthy()
    expect(screen.queryByText(/applications this week/)).toBeNull()
    sqlite.close()
  })
  it('shows what is due and the numbers, and a goal can be set and turned off', async () => {
    cleanup()
    const user = userEvent.setup()
    const now = new Date().toISOString()
    const { sqlite } = await setupWith((db) => {
      addJob(db, 'Acme', 'Engineer', 'applied', { applied: now, follow: '2020-01-01' })
      addJob(db, 'Beta', 'Analyst', 'interviewing', { applied: '2020-01-01T12:00:00.000Z' })
      addJob(db, 'Gamma', 'Designer', null)
    })
    expect((await screen.findAllByText('Acme · Engineer')).length).toBeGreaterThan(0)
    expect(screen.getByText(/Overdue 2020-01-01/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Start reviewing' })).toBeTruthy()
    const week = within(screen.getByRole('region', { name: 'This week' }))
    expect(week.getByText('Replies').nextElementSibling?.textContent).toBe('0')
    expect(week.getByText('Interviewing now').nextElementSibling?.textContent).toBe('1')
    expect(week.getByText('Applied').nextElementSibling?.textContent).toBe('1')
    await user.type(screen.getByLabelText('Weekly goal (optional)'), '5')
    await user.click(screen.getByRole('button', { name: 'Set goal' }))
    expect(await screen.findByText('1 of 5 applications this week')).toBeTruthy()
    expect(await (await fetch('/api/weekly-goal')).json()).toEqual({ goal: 5 })
    await user.click(screen.getByRole('button', { name: 'Turn off goal' }))
    expect(await screen.findByLabelText('Weekly goal (optional)')).toBeTruthy()
    expect(calendarDate()).toBeTruthy()
    sqlite.close()
  })
})

describe('Review flow', () => {
  it('saves and skips with the buttons and the keys, can undo, and ends with a summary', async () => {
    const user = userEvent.setup()
    const { sqlite } = await setupWith((db) => { addJob(db, 'Acme', 'First role', null); addJob(db, 'Beta', 'Second role', null) }, <ReviewFlow />)
    expect(await screen.findByRole('heading', { name: 'First role' })).toBeTruthy()
    await user.keyboard('s')
    expect(await screen.findByRole('heading', { name: 'Second role' })).toBeTruthy()
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM applications WHERE status='saved'").get()).toEqual({ n: 1 })
    await user.click(screen.getByRole('button', { name: /^Skip/ }))
    expect(await screen.findByText('All reviewed')).toBeTruthy()
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM applications WHERE status='skipped'").get()).toEqual({ n: 1 })
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    expect(await screen.findByRole('heading', { name: 'Second role' })).toBeTruthy()
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM applications WHERE status='skipped'").get()).toEqual({ n: 0 })
    sqlite.close()
  })
})

describe('Command palette and Q&A page', () => {
  it('opens with Ctrl+K, finds a page and a job by typing, and goes there', async () => {
    const user = userEvent.setup()
    const { sqlite } = await setupWith((db) => { addJob(db, 'Initech', 'Platform Engineer', 'saved') }, <CommandPalette />)
    window.location.hash = ''
    await user.keyboard('{Control>}k{/Control}')
    const box = await screen.findByRole('combobox', { name: 'Search and commands' })
    await user.type(box, 'platf')
    expect(await screen.findByText('Platform Engineer · Initech')).toBeTruthy()
    await user.keyboard('{Enter}')
    expect(window.location.hash).toMatch(/^#jobs\//)
    await user.keyboard('{Control>}k{/Control}')
    await user.type(await screen.findByRole('combobox', { name: 'Search and commands' }), 'q&a{Enter}')
    expect(window.location.hash).toBe('#qa')
    await user.keyboard('{Escape}')
    sqlite.close()
  })
  it('shows the Q&A page with its Question and Answer Bank', async () => {
    const { sqlite } = await setup(<QAPage />)
    expect(await screen.findByRole('heading', { name: 'Question and Answer Bank' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Q&A' }).getAttribute('aria-current')).toBe('page')
    sqlite.close()
  })
})

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { serve } from '@hono/node-server'
import { fetch as nodeFetch, Request as NodeRequest, Response as NodeResponse, Headers as NodeHeaders } from 'undici'
import { createApp } from '../../server/src/app.js'
import { createDatabase } from '../../server/src/db.js'
import { SettingsPage } from './settings-page.js'

const directories: string[] = []
const servers: Array<ReturnType<typeof serve>> = []
afterEach(async () => {
  cleanup()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const csv = 'Job Title,Company,Apply Link,Date Found\nOld role,Acme,https://acme.test/jobs/1,2020-01-01\nNew role,Beta,https://beta.test/jobs/2,2030-01-01\n'

async function setup() {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'role-clinic-feed-settings-')); directories.push(dataDirectory)
  const { sqlite, db } = createDatabase(dataDirectory)
  const path = join(dataDirectory, 'jobs.csv')
  await writeFile(path, csv)
  const reservation = createServer()
  const port = await new Promise<number>((resolve) => reservation.listen(0, '127.0.0.1', () => resolve((reservation.address() as { port: number }).port)))
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  vi.stubGlobal('Request', NodeRequest); vi.stubGlobal('Response', NodeResponse); vi.stubGlobal('Headers', NodeHeaders)
  const postingCapture = async (url: string) => ({ text: `Full posting ${url} ${'x'.repeat(60)}`, rawSnapshot: 'x', url, applyUrl: url })
  const app = createApp({ dataDirectory, sqlite, db, port, webPort: 5173, development: true, postingCapture, feedSpacingMs: 0 })
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port })
  servers.push(server)
  await new Promise<void>((resolve) => server.on('listening', () => resolve()))
  ;(window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(`http://127.0.0.1:${port}/`)
  vi.stubGlobal('fetch', (input: string, init: RequestInit = {}) => nodeFetch(`http://127.0.0.1:${port}${input}`, { ...init, headers: { ...(init.method && init.method !== 'GET' ? { origin: `http://127.0.0.1:${port}` } : {}), ...init.headers } } as Parameters<typeof nodeFetch>[1]))
  render(<SettingsPage />)
  return { user: userEvent.setup(), sqlite, path }
}

describe('Job feed settings', () => {
  it('saves a path, tests the file without changing it, imports, then previews and applies a clean up', async () => {
    const { user, sqlite, path } = await setup()
    const input = await screen.findByLabelText('Path to a different CSV file')
    await user.type(input, 'relative.csv')
    await user.click(screen.getByRole('button', { name: 'Save settings' }))
    expect(await screen.findByText(/full path of a \.csv file/)).toBeTruthy()
    await user.clear(input); await user.type(input, path)
    await user.click(screen.getByRole('button', { name: 'Test file' }))
    expect(await screen.findByText(/2 rows: 2 usable, 0 skipped.*2 new\. Nothing was changed\./)).toBeTruthy()
    expect(await readFile(path, 'utf8')).toBe(csv)
    await user.click(screen.getByRole('button', { name: 'Save settings' }))
    await screen.findByText('Settings saved locally.')
    await user.click(screen.getByRole('button', { name: 'Check now' }))
    await screen.findByText(/2 new jobs added to To review/)
    await user.clear(screen.getByLabelText('Older than (days)')); await user.type(screen.getByLabelText('Older than (days)'), '60')
    await user.click(screen.getByRole('button', { name: 'Preview' }))
    expect(await screen.findByText(/1 row in the file and 1 undecided feed job older than/)).toBeTruthy()
    expect(sqlite.prepare('SELECT COUNT(*) n FROM jobs').get()).toEqual({ n: 2 })
    await user.click(screen.getByRole('button', { name: 'Remove these' }))
    await screen.findByText(/Removed 1 row from the file and 1 undecided job/)
    await waitFor(() => expect(sqlite.prepare('SELECT COUNT(*) n FROM jobs').get()).toEqual({ n: 1 }))
    expect(await readFile(path, 'utf8')).not.toContain('Old role')
    sqlite.close()
  })
})

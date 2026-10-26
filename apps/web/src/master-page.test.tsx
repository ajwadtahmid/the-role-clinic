// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { serve } from '@hono/node-server'
import { fetch as nodeFetch, Request as NodeRequest, Response as NodeResponse, Headers as NodeHeaders } from 'undici'
import { createApp } from '../../server/src/app.js'
import { createDatabase } from '../../server/src/db.js'
import { MasterPage, ProfilePage } from './master-page.js'

const dirs: string[] = [], servers: Array<ReturnType<typeof serve>> = []
afterEach(async () => {
  cleanup()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function setup() {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'clinic-master-ui-')); dirs.push(dataDirectory)
  const { sqlite, db } = createDatabase(dataDirectory)
  const reservation = createServer()
  const port = await new Promise<number>((resolve) => reservation.listen(0, '127.0.0.1', () => resolve((reservation.address() as { port: number }).port)))
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  vi.stubGlobal('Request', NodeRequest); vi.stubGlobal('Response', NodeResponse); vi.stubGlobal('Headers', NodeHeaders)
  const app = createApp({ dataDirectory, sqlite, db, port, webPort: 5173, development: true })
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }); servers.push(server)
  await new Promise<void>((resolve) => server.on('listening', resolve))
  ;(window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(`http://127.0.0.1:${port}/`)
  vi.stubGlobal('fetch', (input: string, init: RequestInit = {}) => nodeFetch(`http://127.0.0.1:${port}${input}`, { ...init, headers: { ...(init.method && init.method !== 'GET' ? { origin: `http://127.0.0.1:${port}` } : {}), ...init.headers } } as Parameters<typeof nodeFetch>[1]))
  return { sqlite, user: userEvent.setup() }
}

describe('Phase 3 editor flow', () => {
  it('saves a reviewed role and keeps profile contact separate from master evidence', async () => {
    const { sqlite, user } = await setup()
    const rendered = render(<MasterPage />)
    await user.click(await screen.findByRole('button', { name: 'Add role' }))
    await user.type(screen.getByRole('textbox', { name: 'Company' }), 'Acme')
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Engineer')
    await user.click(screen.getByRole('button', { name: 'Add evidence bullet' }))
    await user.type(screen.getByRole('textbox', { name: /Bullet · revision/ }), 'Reduced API latency by 15%')
    await user.click(screen.getByRole('button', { name: 'Save master résumé' }))
    await screen.findByText('Master résumé saved locally.')
    const master = JSON.parse((sqlite.prepare('SELECT document FROM master').get() as { document: string }).document)
    expect(master.roles[0].bullets[0]).toMatchObject({ rev: 1, text: 'Reduced API latency by 15%' })
    rendered.unmount()
    render(<ProfilePage />)
    await user.type(await screen.findByRole('textbox', { name: 'Name' }), 'Jane Example')
    await user.type(screen.getByRole('textbox', { name: 'Email' }), 'jane@example.test')
    await user.type(screen.getByRole('textbox', { name: 'Links (one per line)' }), 'https://example.test\nhttps://github.com/example')
    await user.click(screen.getByRole('button', { name: 'Save profile' }))
    await screen.findByText('Profile saved locally.')
    const profile = JSON.parse((sqlite.prepare('SELECT document FROM profile').get() as { document: string }).document)
    expect(profile.links).toHaveLength(2)
    expect(JSON.stringify(master)).not.toContain('jane@example.test')
    await waitFor(() => expect(screen.getByText('Kubernetes ↔ k8s')).toBeTruthy())
    sqlite.close()
  })
})

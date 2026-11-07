// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Request as NodeRequest, Response as NodeResponse, Headers as NodeHeaders } from 'undici'
import { createDatabase } from '../../server/src/db.js'
import { createApp } from '../../server/src/app.js'
import { FirstRun, MaintenancePanel } from './runtime.js'

const resources: Array<{ directory: string; sqlite: ReturnType<typeof createDatabase>['sqlite'] }> = []
afterEach(async () => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const r of resources.splice(0)) { r.sqlite.close(); await rm(r.directory, { recursive: true, force: true }) } })
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'clinic-runtime-ui-')), { sqlite, db } = createDatabase(directory); resources.push({ directory, sqlite })
  const shutdown = vi.fn(async () => {})
  vi.stubGlobal('Request', NodeRequest); vi.stubGlobal('Response', NodeResponse); vi.stubGlobal('Headers', NodeHeaders)
  const app = createApp({ dataDirectory: directory, sqlite, db, port: 3000, runtime: { version: '0.1.0-preview.1', instanceId: 'test-instance', managed: true, shutdown } })
  vi.stubGlobal('fetch', (input: string, init: RequestInit = {}) => app.request(`http://127.0.0.1:3000${input}`, { ...init, headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', ...init.headers } }))
  return { sqlite, shutdown, user: userEvent.setup() }
}
describe('first run and maintenance UI', () => {
  it('walks through résumé, model and first job, lets every step be skipped, persists completion, and can be shown again', async () => {
    const { user } = await setup()
    window.location.hash = ''
    const view = render(<FirstRun><p>Workspace ready</p></FirstRun>)
    expect(await screen.findByRole('heading', { name: 'Add your résumé' })).toBeTruthy()
    expect(screen.getByText('Step 1 of 3')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByRole('heading', { name: 'Choose a model' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByRole('heading', { name: 'Add your first job' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('heading', { name: 'Choose a model' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Skip for now' }))
    await screen.findByText('Workspace ready')
    expect(window.location.hash).toBe('#jobs')
    view.unmount()
    render(<FirstRun><p>Workspace reopened</p></FirstRun>)
    await screen.findByText('Workspace reopened')
    expect(screen.queryByRole('heading', { name: 'Add your résumé' })).toBeNull()
    window.location.hash = '#welcome'
    expect(await screen.findByRole('heading', { name: 'Add your résumé' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Skip for now' }))
    await screen.findByText('Workspace reopened')
    window.location.hash = ''
  })
  it('creates a downloadable database backup and requires explicit confirmation before stopping', async () => {
    const { user, shutdown } = await setup()
    render(<MaintenancePanel />)
    await screen.findByText(/0.1.0-preview.1/)
    await user.click(screen.getByRole('button', { name: 'Create database backup' }))
    await screen.findByText(/Database backup created:/)
    await user.click(screen.getByText(/Database backup history/))
    const link = screen.getByRole('link', { name: /clinic-.*\.sqlite/ })
    expect(link.getAttribute('href')).toMatch(/^\/api\/backups\//)
    const stop = screen.getByRole('button', { name: 'Stop local app' }) as HTMLButtonElement
    expect(stop.disabled).toBe(true)
    await user.click(screen.getByRole('checkbox', { name: 'I’m ready to stop the local app.' }))
    await user.click(stop)
    await screen.findByText('The local app is stopping. You can close this tab.')
    await waitFor(() => expect(shutdown).toHaveBeenCalledWith(false))
  })
})

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Request as NodeRequest, Response as NodeResponse, Headers as NodeHeaders } from 'undici'
import { createDatabase } from '../../server/src/db.js'
import { createApp } from '../../server/src/app.js'
import { AboutPanel, BackupsPanel, ClearDataPanel, FirstRun } from './runtime.js'

const resources: Array<{ directory: string; sqlite: ReturnType<typeof createDatabase>['sqlite'] }> = []
afterEach(async () => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const r of resources.splice(0)) { r.sqlite.close(); await rm(r.directory, { recursive: true, force: true }) } })
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'clinic-runtime-ui-')), { sqlite, db } = createDatabase(directory); resources.push({ directory, sqlite })
  const shutdown = vi.fn(async () => {})
  vi.stubGlobal('Request', NodeRequest); vi.stubGlobal('Response', NodeResponse); vi.stubGlobal('Headers', NodeHeaders)
  const app = createApp({ dataDirectory: directory, sqlite, db, port: 3000, runtime: { version: '0.1.0-preview.1', instanceId: 'test-instance', managed: true, shutdown } })
  vi.stubGlobal('fetch', (input: string, init: RequestInit = {}) => app.request(`http://127.0.0.1:3000${input}`, { ...init, headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', ...init.headers } }))
  return { sqlite, shutdown, directory, user: userEvent.setup() }
}
describe('first run and maintenance UI', () => {
  it('asks a new install once how it will be used, and records the choice either way', async () => {
    for (const [name, target, enabled] of [['Just track my applications', '#jobs', false], ['Also tailor résumés with AI', '#settings?setup', false]] as const) {
      const { user, sqlite } = await setup()
      window.location.hash = ''
      const view = render(<FirstRun><p>Workspace ready</p></FirstRun>)
      expect(await screen.findByRole('heading', { name: 'How do you want to start?' })).toBeTruthy()
      await user.click(screen.getByRole('button', { name: new RegExp(name) }))
      await screen.findByText('Workspace ready')
      expect(window.location.hash).toBe(target)
      const saved = (await (await fetch('/api/settings')).json()) as { aiFeatures: { chosen: boolean; enabled: boolean } }
      // Choosing AI only says the person wants it; it turns on once setup has passed.
      expect(saved.aiFeatures).toMatchObject({ chosen: true, enabled })
      view.unmount(); cleanup(); sqlite.close()
    }
    window.location.hash = ''
  })
  it('walks through résumé, model and first job, lets every step be skipped, persists completion, and can be shown again', async () => {
    const { user } = await setup()
    // An install that already uses AI features (the walkthrough is about setting those up).
    await fetch('/api/ai-features', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) })
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
  it('makes a backup, shows the newest three and the rest on request, and labels how each was made', async () => {
    const { user, directory } = await setup()
    await mkdir(join(directory, 'backups'), { recursive: true })
    for (const name of ['auto-20261101T000000Z', 'auto-20261102T000000Z', 'auto-20261103T000000Z', 'auto-20261104T000000Z', 'pre-migration-v8-20261031T000000Z']) await writeFile(join(directory, 'backups', `${name}.sqlite`), 'x')
    render(<BackupsPanel />)
    await screen.findByText(/Your data folder/)
    await waitFor(() => expect(document.querySelectorAll('.backup-list .row')).toHaveLength(3))
    await user.click(screen.getByRole('button', { name: 'Back up now' }))
    await screen.findByText(/Backup made: clinic-/)
    // Four more exist now (three automatic, one before an update), behind one button.
    await user.click(await screen.findByRole('button', { name: 'Show 3 more' }))
    expect(document.querySelectorAll('.backup-list .row')).toHaveLength(6)
    expect(screen.getAllByText('Automatic backup').length).toBe(4)
    expect(screen.getByText('Before an update backup')).toBeTruthy()
    const link = screen.getByRole('link', { name: /Download clinic-.*\.sqlite/ })
    expect(link.getAttribute('href')).toMatch(/^\/api\/backups\//)
    await user.click(screen.getByRole('button', { name: 'Show fewer' }))
    expect(document.querySelectorAll('.backup-list .row')).toHaveLength(3)
  })
  it('clears the data folder only after two confirmations, and keeps the job search folder', async () => {
    const { user, sqlite, directory } = await setup()
    await fetch('/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ company: 'Acme', title: 'Engineer', text: 'A job description that is long enough to be saved as a job.' }) })
    await mkdir(join(directory, 'backups'), { recursive: true }); await mkdir(join(directory, 'artifacts'), { recursive: true }); await mkdir(join(directory, 'job-search', 'data'), { recursive: true })
    await writeFile(join(directory, 'backups', 'clinic-2026-01-01T00-00-00Z.sqlite'), 'x'); await writeFile(join(directory, 'artifacts', 'a.pdf'), 'x'); await writeFile(join(directory, 'welcome.json'), '{}'); await writeFile(join(directory, 'job-search', 'data', 'jobs.csv'), 'keep')
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {})
    // A request without the typed word is refused, even with everything else right.
    expect((await fetch('/api/app/clear-data', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }) })).status).toBe(400)
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n).toBe(1)
    render(<ClearDataPanel />)
    await user.click(screen.getByRole('button', { name: 'Clear all data…' }))
    // First confirmation lists what is lost; the destructive button is not there yet.
    expect(screen.getByText(/permanently deletes/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Erase everything' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    const erase = screen.getByRole('button', { name: 'Erase everything' }) as HTMLButtonElement
    expect(erase.disabled).toBe(true)
    await user.type(screen.getByRole('textbox'), 'delete')
    expect(erase.disabled).toBe(true)
    await user.clear(screen.getByRole('textbox')); await user.type(screen.getByRole('textbox'), 'DELETE')
    await user.click(erase)
    await waitFor(() => expect(reload).toHaveBeenCalled())
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n).toBe(0)
    expect((sqlite.prepare('SELECT ghosted_days AS d FROM tracker_preferences WHERE id=1').get() as { d: number }).d).toBe(14)
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM synonyms').get() as { n: number }).n).toBe(3)
    const { existsSync } = await import('node:fs')
    for (const gone of ['backups', 'artifacts', 'welcome.json']) expect(existsSync(join(directory, gone))).toBe(false)
    expect(existsSync(join(directory, 'job-search', 'data', 'jobs.csv'))).toBe(true)
    // It is a new install again: the app asks how it will be used.
    const status = (await (await fetch('/api/settings')).json()) as { aiFeatures: { chosen: boolean } }
    expect(status.aiFeatures.chosen).toBe(false)
  })
  it('says so when there are no backups yet', async () => {
    await setup()
    render(<BackupsPanel />)
    expect(await screen.findByText(/No backups yet/)).toBeTruthy()
  })
  it('shows what the app is and asks once, inline, before stopping it', async () => {
    const { user, shutdown } = await setup()
    render(<AboutPanel />)
    await screen.findByText(/0.1.0-preview.1/)
    expect(screen.getByText(/never sent to a model/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Show the welcome guide again' }).getAttribute('href')).toBe('#welcome')
    await user.click(screen.getByRole('button', { name: 'Stop local app…' }))
    expect(screen.getByRole('alertdialog', { name: 'Stop Role Clinic' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Keep running' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(shutdown).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Stop local app…' }))
    await user.click(screen.getByRole('button', { name: 'Yes, stop it' }))
    await screen.findByText('The local app is stopping. You can close this tab.')
    await waitFor(() => expect(shutdown).toHaveBeenCalledWith(false))
  })
})

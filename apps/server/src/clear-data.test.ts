import { afterEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from './db.js'
import { registerRuntimeRoutes } from './runtime-routes.js'

const directories: string[] = []
const open: Array<{ close(): unknown }> = []
afterEach(async () => { for (const database of open.splice(0)) database.close(); await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })

async function fixture(otherWorkRunning: () => boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'role-clinic-clear-')); directories.push(directory)
  const { sqlite } = createDatabase(directory); open.push(sqlite)
  sqlite.prepare('INSERT INTO jobs(id,company,title,captured_at) VALUES(?,?,?,?)').run('j1', 'Acme', 'Engineer', new Date().toISOString())
  await writeFile(join(directory, 'settings.json'), '{}')
  const app = new Hono(); registerRuntimeRoutes(app, sqlite, directory, undefined, otherWorkRunning)
  const clear = (body: unknown) => app.request('/api/app/clear-data', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { sqlite, directory, clear }
}

describe('clear data', () => {
  it('refuses without the typed word, and while a batch of fit checks is working between its runs', async () => {
    let batch = true
    const f = await fixture(() => batch)
    expect((await f.clear({ confirm: true })).status).toBe(400)
    // No model run is recorded, yet the batch is between two jobs: the data must stay.
    expect((await f.clear({ confirm: 'DELETE' })).status).toBe(409)
    expect((f.sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n).toBe(1)
    expect(existsSync(join(f.directory, 'settings.json'))).toBe(true)
    batch = false
    expect((await f.clear({ confirm: 'DELETE' })).status).toBe(200)
    expect((f.sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n).toBe(0)
    expect(existsSync(join(f.directory, 'settings.json'))).toBe(false)
  })
})

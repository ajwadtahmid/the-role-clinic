import type { Hono } from 'hono'
import type Database from 'better-sqlite3'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CURRENT_SCHEMA_VERSION } from './db.js'
import { clearAppData } from './clear-data.js'

export interface RuntimeInfo { version: string; instanceId: string; managed: boolean; desktop?: boolean; shutdown(force: boolean): Promise<void> }
export function registerRuntimeRoutes(app: Hono, sqlite: Database.Database, dataDirectory: string, runtime?: RuntimeInfo) {
  app.get('/api/app/status', (context) => context.json({
    app: 'the-role-clinic', version: runtime?.version ?? 'development', platform: process.platform, arch: process.arch,
    nodeVersion: process.version, schemaVersion: CURRENT_SCHEMA_VERSION, dataDirectory,
    instanceId: runtime?.instanceId ?? null, managed: runtime?.managed ?? false,
    desktop: runtime?.desktop ?? false,
    canShutdown: Boolean(runtime), welcomeComplete: existsSync(join(dataDirectory, 'welcome.json')),
    activeRuns: (sqlite.prepare("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued','running')").get() as { n: number }).n,
  }))
  app.post('/api/app/welcome', async (context) => {
    const value = await context.req.json().catch(() => null)
    if (!value || value.acknowledged !== true) return context.json({ error: 'Confirm the local-data introduction.' }, 400)
    await writeFile(join(dataDirectory, 'welcome.json'), JSON.stringify({ version: 1, acknowledgedAt: new Date().toISOString() }), { mode: 0o600 })
    return context.json({ ok: true })
  })
  // Irreversible: the typed word is the second confirmation, so a stray request cannot erase everything.
  app.post('/api/app/clear-data', async (context) => {
    const value = await context.req.json().catch(() => null)
    if (value?.confirm !== 'DELETE') return context.json({ error: 'Type DELETE to confirm.' }, 400)
    if (sqlite.prepare("SELECT 1 FROM runs WHERE status IN ('queued','running')").get()) return context.json({ error: 'A model run is active. Wait for it to finish before clearing your data.' }, 409)
    await clearAppData(sqlite, dataDirectory)
    return context.json({ ok: true })
  })
  app.post('/api/app/quit', async (context) => {
    const value = await context.req.json().catch(() => null)
    if (!runtime) return context.json({ error: 'Stop this development server from its terminal.' }, 409)
    if (value?.confirm !== true || value.instanceId !== runtime.instanceId) return context.json({ error: 'Confirm which running app to stop.' }, 400)
    if (value.force !== true && sqlite.prepare("SELECT 1 FROM runs WHERE status IN ('queued','running')").get()) return context.json({ error: 'A model run is active. Wait for it to finish, or explicitly force stop from the launcher.' }, 409)
    setTimeout(() => { void runtime.shutdown(value.force === true) }, 100).unref()
    return context.json({ ok: true, message: 'The local app is stopping. You can close this tab.' })
  })
  app.get('/api/backups/:filename', async (context) => {
    const filename = context.req.param('filename')
    if (!/^(?:clinic|auto|pre-migration-v\d+)-[\dTZ-]+(?:-[a-f0-9-]+)?\.sqlite$/.test(filename)) return context.json({ error: 'Choose a database backup from the list.' }, 400)
    try {
      const bytes = await readFile(join(dataDirectory, 'backups', filename))
      context.header('Content-Type', 'application/vnd.sqlite3'); context.header('Cache-Control', 'no-store')
      context.header('Content-Disposition', `attachment; filename="${filename}"`)
      return context.body(new Uint8Array(bytes))
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return context.json({ error: 'Backup not found.' }, 404); throw error }
  })
}

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { getRequestListener } from '@hono/node-server'
import { createApp } from './app.js'
import { createDatabase } from './db.js'
import { getDataDirectory } from './data-dir.js'
import { acquireProcessLock } from './process-lock.js'
import { databaseBackup } from './database-backups.js'

export async function startServer() {
  process.umask(0o077)
  const dataDirectory = resolve(getDataDirectory()), managed = process.env.ROLE_CLINIC_MANAGED === '1'
  const port = Number(process.env.PORT ?? (managed ? '0' : '3000')), webPort = Number(process.env.WEB_PORT ?? '5173')
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer between 0 and 65535.')
  await mkdir(dirname(dataDirectory), { recursive: true, mode: 0o700 }); await mkdir(dataDirectory, { recursive: true, mode: 0o700 })
  const releaseOperation = managed ? async () => {} : await acquireProcessLock(`${dataDirectory}.operation.lock`)
  let releaseServer: (() => Promise<void>) | undefined
  let sqlite: ReturnType<typeof createDatabase>['sqlite'] | undefined
  let app: ReturnType<typeof createApp> | undefined
  const server = createServer(getRequestListener((request, env) => app ? app.fetch(request, env) : new Response('Starting the local app.', { status: 503 })))
  const instanceId = randomUUID()
  const statePath = join(dataDirectory, 'instance.json')
  let daily: NodeJS.Timeout | undefined, stopping = false
  async function shutdown(force = false) {
    if (stopping) return
    if (!force && sqlite?.open && sqlite.prepare("SELECT 1 FROM runs WHERE status IN ('queued','running')").get()) return
    stopping = true; if (daily) clearInterval(daily)
    const closed = new Promise<void>((resolve) => server.close(() => resolve()))
    server.closeIdleConnections()
    const timeout = setTimeout(() => server.closeAllConnections(), 1000); timeout.unref()
    await closed; clearTimeout(timeout)
    if (sqlite?.open) { sqlite.pragma('wal_checkpoint(TRUNCATE)'); sqlite.close() }
    try { if (JSON.parse(await readFile(statePath, 'utf8')).instanceId === instanceId) await rm(statePath) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('Could not remove the app instance record.') }
    await releaseServer?.()
    process.exit(0)
  }
  try {
    releaseServer = await acquireProcessLock(join(dataDirectory, 'server.lock'), managed ? 2000 : 15000)
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve()) })
    const actualPort = (server.address() as { port: number }).port
    const database = createDatabase(dataDirectory); sqlite = database.sqlite
    databaseBackup(sqlite, dataDirectory, 'auto')
    let version = 'development'
    if (process.env.ROLE_CLINIC_RELEASE_PATH) version = JSON.parse(await readFile(join(process.env.ROLE_CLINIC_RELEASE_PATH, 'manifest.json'), 'utf8')).version
    app = createApp({ dataDirectory, sqlite, db: database.db, port: actualPort, webPort, runtime: { version, instanceId, managed, desktop: process.env.ROLE_CLINIC_DESKTOP === '1', shutdown } })
    const state = { app: 'the-role-clinic', pid: process.pid, port: actualPort, instanceId, version, managed, ...(process.env.ROLE_CLINIC_DESKTOP === '1' ? { shell: 'desktop' } : {}) }
    const temporary = `${statePath}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 }); await rename(temporary, statePath)
    daily = setInterval(() => { try { if (sqlite?.open) databaseBackup(sqlite, dataDirectory, 'auto') } catch (error) { console.error(`Automatic database backup failed: ${(error as Error).message}`) } }, 86400000); daily.unref()
    process.on('SIGTERM', () => { void shutdown(true) }); process.on('SIGINT', () => { void shutdown(true) })
    console.log(`The Role Clinic: http://127.0.0.1:${actualPort}`)
    console.log(`Local data: ${dataDirectory}`)
    if (process.send) { process.send(state); process.disconnect?.() }
    return { server, shutdown }
  } catch (error) {
    server.close(); if (sqlite?.open) sqlite.close(); await releaseServer?.(); throw error
  } finally { await releaseOperation() }
}

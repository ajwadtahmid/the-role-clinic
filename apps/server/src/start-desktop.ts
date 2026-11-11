// The desktop owns this process. EOF on the private stdin pipe also stops it after a shell crash.
import { mkdir, readFile } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { getDataDirectory } from './data-dir.js'
import { acquireProcessLock, lockOwnerAlive } from './process-lock.js'
import { startServer } from './server.js'
import { appendFileSync, statSync, renameSync, rmSync } from 'node:fs'

process.env.ROLE_CLINIC_MANAGED = '1'
process.env.ROLE_CLINIC_DESKTOP = '1'
let stop: ((force?: boolean) => Promise<void>) | undefined
let parentGone = false
process.stdin.on('end', () => { parentGone = true; if (stop) void stop(true); else process.exit(0) })
process.stdin.resume()
try {
  const data = resolve(getDataDirectory())
  await mkdir(dirname(data), { recursive: true, mode: 0o700 }); await mkdir(data, { recursive: true, mode: 0o700 })
  const logfile = join(data, 'app.log')
  try { if (statSync(logfile).size > 2 * 1024 * 1024) { rmSync(`${logfile}.previous`, { force: true }); renameSync(logfile, `${logfile}.previous`) } } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  for (const method of ['log', 'error'] as const) {
    const original = console[method].bind(console)
    console[method] = (...values: unknown[]) => { appendFileSync(logfile, `${new Date().toISOString()} ${values.map(String).join(' ')}\n`, { mode: 0o600 }); original(...values) }
  }
  const unlock = await acquireProcessLock(`${data}.operation.lock`)
  try {
    try {
      const owner = JSON.parse(await readFile(join(data, 'server.lock'), 'utf8'))
      if (lockOwnerAlive(owner)) throw new Error('This data folder is already in use. Close the running browser version or desktop app before opening this version. No running process was stopped.')
    } catch (error) { if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const started = await startServer(); stop = started.shutdown
    if (parentGone) await stop(true)
    else console.log(`ROLE_CLINIC_DESKTOP_READY=${await readFile(join(data, 'instance.json'), 'utf8')}`)
  } finally { await unlock() }
} catch (error) {
  console.log(`ROLE_CLINIC_DESKTOP_ERROR=${(error as Error).message}`)
  process.exitCode = 1; process.stdin.pause()
}

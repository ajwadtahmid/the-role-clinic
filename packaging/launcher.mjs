import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

process.umask(0o077)
const root = dirname(fileURLToPath(import.meta.url)), appRoot = join(root, 'app')
const { getDataDirectory } = await import(new URL('./app/apps/server/src/data-dir.js', import.meta.url))
const { acquireProcessLock, processAlive } = await import(new URL('./app/apps/server/src/process-lock.js', import.meta.url))
const data = resolve(getDataDirectory()), command = process.argv[2] ?? 'start', args = process.argv.slice(3)
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
const exec = promisify(execFile)
const usage = `The Role Clinic ${manifest.version}
  ./role-clinic                         Start or reopen the browser workspace
  ./role-clinic start --no-browser      Start and print its local URL
  ./role-clinic status                  Show the running instance
  ./role-clinic stop [--force]          Stop the local server
  ./role-clinic backup /path/data.tar.gz Create a full backup (stop the app first)
  ./role-clinic restore /path/data.tar.gz            Validate and inspect a backup
  ./role-clinic restore /path/data.tar.gz --confirm  Restore, preserving a recovery folder
  ./role-clinic verify                  Check installed package files
  ./role-clinic install-desktop         Add an application-menu shortcut
  ./role-clinic uninstall-desktop       Remove that shortcut
  ./role-clinic help                    Show this help
Data: ${data}
Guide: ${join(root, 'USER-GUIDE.md')}`
async function state() {
  try {
    const record = JSON.parse(await readFile(join(data, 'instance.json'), 'utf8'))
    if (record.app !== 'the-role-clinic' || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535 || !processAlive(record.pid)) return null
    const response = await fetch(`http://127.0.0.1:${record.port}/api/app/status`, { signal: AbortSignal.timeout(2000) })
    const result = await response.json()
    if (!response.ok || result.app !== record.app || result.instanceId !== record.instanceId || resolve(result.dataDirectory) !== data) throw new Error('The recorded port is occupied by a different app. No process was stopped.')
    return record
  } catch (error) {
    if (error.code === 'ENOENT') return null
    if (error instanceof SyntaxError) {
      try { const owner = JSON.parse(await readFile(join(data, 'server.lock'), 'utf8')); if (processAlive(owner.pid)) throw new Error('A server may be running with a damaged instance record. Inspect app.log before retrying.'); return null }
      catch (lockError) { if (lockError.code === 'ENOENT') return null; throw lockError }
    }
    if (error.name === 'TimeoutError' || error.cause?.code === 'ECONNREFUSED') throw new Error('A recorded app process is not responding. Inspect the local log before retrying; no process was stopped.')
    throw error
  }
}
async function requireOffline() {
  const running = await state()
  if (running) throw new Error('Stop the app with ./role-clinic stop before creating or restoring a full backup.')
  try { const owner = JSON.parse(await readFile(join(data, 'server.lock'), 'utf8')); if (processAlive(owner.pid)) throw new Error('The data folder is in use by a server. Stop it before maintenance.') } catch (error) { if (error.code !== 'ENOENT') throw error }
}
async function browser(url) {
  if (args.includes('--no-browser') || process.env.ROLE_CLINIC_NO_BROWSER === '1') return
  try { await exec('xdg-open', [url], { timeout: 10000, env: { ...process.env } }) }
  catch { console.log(`Open this URL in your browser: ${url}`) }
}
async function start() {
  const existing = await state()
  if (existing) {
    if (!existing.managed) throw new Error('A development server is using this data folder. Stop it before launching the packaged app.')
    console.log(`Already running ${existing.version}: http://127.0.0.1:${existing.port}`)
    if (existing.version !== manifest.version) console.log('Stop the running version and launch again to use this update. Your data stays in the same folder.')
    await browser(`http://127.0.0.1:${existing.port}`); return
  }
  const logPath = join(data, 'app.log')
  // Keep one previous log so a failed launch cannot grow logs without bounds.
  const { stat, rename } = await import('node:fs/promises')
  try { if ((await stat(logPath)).size > 2 * 1024 * 1024) { await rm(`${logPath}.previous`, { force: true }); await rename(logPath, `${logPath}.previous`) } } catch (error) { if (error.code !== 'ENOENT') throw error }
  const log = await open(logPath, 'a', 0o600)
  let child
  try {
    const env = { ...process.env, ROLE_CLINIC_DATA_DIR: data, ROLE_CLINIC_MANAGED: '1', ROLE_CLINIC_RELEASE_PATH: root, NODE_ENV: 'production', PORT: process.env.PORT ?? '0' }
    // Developer injection flags have no place in a downloaded app's runtime.
    delete env.NODE_OPTIONS; delete env.NODE_PATH
    child = spawn(join(root, 'runtime/node'), [join(appRoot, 'apps/server/src/start-production.js')], { cwd: root, env, detached: true, stdio: ['ignore', log.fd, log.fd, 'ipc'] })
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Startup timed out. See ${logPath}`)), 20000)
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`App startup exited (${code}). See ${logPath}`)) })
      child.once('message', (message) => { clearTimeout(timer); resolve(message) })
    })
    if (ready.app !== 'the-role-clinic' || !ready.port) throw new Error('Unexpected app startup response.')
    child.unref(); console.log(`The Role Clinic ${manifest.version}: http://127.0.0.1:${ready.port}`)
    console.log(`Data: ${data}`); console.log(`Stop: ${join(root, 'role-clinic')} stop`)
    await browser(`http://127.0.0.1:${ready.port}`)
  } catch (error) { child?.kill('SIGTERM'); throw error }
  finally { await log.close() }
}
function desktopQuote(text) { return `"${text.replaceAll('%', '%%').replace(/[\\"`$]/g, '\\$&')}"` }
async function desktop(install) {
  if (/[\r\n\0]/.test(root)) throw new Error('Move the app to a path without line breaks before creating a desktop shortcut.')
  const directory = join(process.env.XDG_DATA_HOME || join(process.env.HOME, '.local/share'), 'applications'), file = join(directory, 'the-role-clinic.desktop')
  if (!install) { await rm(file, { force: true }); console.log('Application-menu shortcut removed. Your app files and data are unchanged.'); return }
  await mkdir(directory, { recursive: true })
  await writeFile(file, `[Desktop Entry]\nType=Application\nName=The Role Clinic\nComment=Local job tracker and resume workspace\nExec=${desktopQuote(join(root, 'role-clinic'))}\nIcon=${join(appRoot, 'apps/web/dist/icon.svg')}\nTerminal=false\nCategories=Office;\n`, { mode: 0o644 })
  console.log(`Shortcut installed: ${file}\nKeep the extracted app at ${root}, or reinstall the shortcut after moving it.`)
}
try {
  if (process.platform !== 'linux' || process.arch !== 'x64' || !process.report.getReport().header.glibcVersionRuntime) throw new Error('This package targets Linux x86_64 with glibc. macOS, Windows, ARM and musl packages are not included.')
  if (['help', '--help', '-h'].includes(command)) { console.log(usage); process.exit(0) }
  if (command === 'verify') {
    for (const file of manifest.files) {
      const path = resolve(root, file.path)
      if (!path.startsWith(`${root}/`)) throw new Error('Invalid package manifest path.')
      const actual = createHash('sha256').update(await readFile(path)).digest('hex')
      if (actual !== file.sha256) throw new Error(`Package file checksum mismatch: ${file.path}`)
    }
    console.log(`Package verified: ${manifest.files.length} files; Linux x86_64; Node ${manifest.nodeVersion}.`)
  } else if (command === 'install-desktop' || command === 'uninstall-desktop') await desktop(command === 'install-desktop')
  else {
    await mkdir(dirname(data), { recursive: true, mode: 0o700 }); await mkdir(data, { recursive: true, mode: 0o700 })
    const unlock = await acquireProcessLock(`${data}.operation.lock`)
    try {
      if (command === 'start' || command === 'open') await start()
      else if (command === 'status') { const current = await state(); console.log(current ? JSON.stringify({ ...current, dataDirectory: data }, null, 2) : 'The Role Clinic is stopped.'); }
      else if (command === 'stop') {
        const current = await state()
        if (!current) console.log('The Role Clinic is already stopped.')
        else {
          const base = `http://127.0.0.1:${current.port}`
          const response = await fetch(`${base}/api/app/quit`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true, instanceId: current.instanceId, force: args.includes('--force') }), signal: AbortSignal.timeout(5000) })
          if (!response.ok) throw new Error((await response.json()).error)
          for (let i = 0; i < 100; i++) {
            try { const value = JSON.parse(await readFile(join(data, 'instance.json'), 'utf8')); if (value.instanceId !== current.instanceId) throw new Error('The instance changed while stopping.') }
            catch (error) { if (error.code === 'ENOENT') { console.log('The Role Clinic stopped. Your data is saved.'); break }; throw error }
            if (i === 99) throw new Error('Shutdown did not finish. Inspect app.log before retrying.')
            await new Promise((resolve) => setTimeout(resolve, 75))
          }
        }
      } else if (command === 'backup' || command === 'restore') {
        if (!args[0] || args[0].startsWith('-')) throw new Error(`Choose a backup archive path.\n${usage}`)
        await requireOffline()
        const maintenance = await import(new URL('./app/apps/server/src/maintenance.js', import.meta.url))
        const file = resolve(args[0])
        const result = command === 'backup' ? await maintenance.createFullBackup(data, file) : args.includes('--confirm') ? await maintenance.restoreFullBackup(file, data) : await maintenance.inspectFullBackup(file, data)
        console.log(JSON.stringify(result, null, 2))
        if (command === 'restore' && !args.includes('--confirm')) console.log('Validated only. Run the same restore command with --confirm to replace current data and retain a recovery folder.')
      } else throw new Error(usage)
    } finally { await unlock() }
  }
} catch (error) { console.error(`The Role Clinic: ${error.message}`); process.exitCode = 1 }

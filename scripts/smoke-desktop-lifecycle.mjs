// Native package startup/ownership checks. This does not qualify webview rendering or dialogs.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const binary = resolve(process.argv[2] || ''), root = await mkdtemp(join(tmpdir(), 'clinic-lifecycle-'))
if (!process.argv[2]) throw new Error('Pass the installed desktop executable path.')
const data = join(root, 'workspace ü with spaces'), env = { ...process.env, ROLE_CLINIC_DATA_DIR: data }
const children = [], checks = []
let state, base
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, label) {
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) { if (await check()) return; await sleep(150) }
  throw new Error(`Timed out: ${label}`)
}
function launch() {
  const child = spawn(binary, [], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  child.on('error', (error) => { child.startError = error })
  child.stdout.on('data', (data) => process.stdout.write(data))
  child.stderr.on('data', (data) => process.stderr.write(data))
  children.push(child); return child
}
async function ready(child) {
  await until(async () => {
    if (child.startError) throw child.startError
    if (child.exitCode !== null) throw new Error(`Desktop exited early (${child.exitCode})`)
    try {
      state = JSON.parse(await readFile(join(data, 'instance.json'), 'utf8'))
      base = `http://127.0.0.1:${state.port}`
      const response = await fetch(`${base}/api/app/status`)
      const status = await response.json()
      return response.ok && status.desktop && status.instanceId === state.instanceId
    } catch { return false }
  }, 'native backend readiness')
}
async function quit(child) {
  const response = await fetch(`${base}/api/app/quit`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true, instanceId: state.instanceId, force: true }) })
  assert.equal(response.ok, true)
  await until(() => child.exitCode !== null || child.signalCode !== null, 'desktop exits with owned backend')
}
try {
  const first = launch(); await ready(first)
  const oldId = state.instanceId
  const response = await fetch(`${base}/api/jobs`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ company: 'Synthetic Example ü', title: 'Engineer', text: 'Build reliable software systems and maintain TypeScript applications with our team.' }) })
  assert.equal(response.ok, true); const job = await response.json()
  const second = launch()
  await until(() => second.exitCode !== null, 'second launch exits')
  assert.equal(second.exitCode, 0)
  assert.equal(JSON.parse(await readFile(join(data, 'instance.json'), 'utf8')).instanceId, oldId)
  checks.push('native package starts backend from resource layout', 'second launch preserves backend identity')
  await quit(first)
  const reopened = launch(); await ready(reopened)
  assert.notEqual(state.instanceId, oldId)
  assert.equal((await (await fetch(`${base}/api/jobs/${job.id}`)).json()).job.company, 'Synthetic Example ü')
  checks.push('quit and reopen preserve data')
  const backendPid = state.pid
  reopened.kill('SIGKILL')
  await until(async () => {
    try { await readFile(join(data, 'instance.json')); return false } catch (error) { return error.code === 'ENOENT' }
  }, 'private stdin EOF stops orphan backend')
  assert.throws(() => process.kill(backendPid, 0))
  checks.push('shell crash stops owned backend')
  console.log(JSON.stringify({ passed: true, platform: process.platform, arch: process.arch, checks, webviewInteractionsQualified: false }, null, 2))
} finally {
  if (base) await fetch(`${base}/api/app/quit`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true, instanceId: state?.instanceId, force: true }), signal: AbortSignal.timeout(2000) }).catch(() => {})
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await sleep(500)
  // Windows can keep a file locked for a moment after its process exits, so retry the cleanup.
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
}

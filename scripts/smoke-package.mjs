import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rename, rm, stat, chmod, cp } from 'node:fs/promises'
import { join, resolve, basename } from 'node:path'
import { tmpdir, release } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:net'
import { request as httpRequest } from 'node:http'
import { randomUUID } from 'node:crypto'

const execFile = promisify(execFileCallback)
// The version is only needed to find the default archive; CI runs this file from a bare mount with no package.json beside it.
const defaultArchive = async () => `dist/the-role-clinic-${JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version}-linux-x64.tar.gz`
const input = resolve(process.argv[2] || await defaultArchive())
const root = await mkdtemp(join(tmpdir(), 'role-clinic-package-'))
let bundle = input, data = join(root, 'private data ü'), running = false
await mkdir(join(root, 'empty-path')); await mkdir(join(root, 'xdg'))
if (input.endsWith('.tar.gz')) {
  await execFile('/usr/bin/tar', ['-xzf', input, '-C', root])
  bundle = join(root, basename(input, '.tar.gz'))
} else {
  bundle = join(root, 'extracted package ü')
  await cp(input, bundle, { recursive: true })
}
const cleanEnv = () => ({ ...process.env, PATH: join(root, 'empty-path'), XDG_DATA_HOME: join(root, 'xdg'), ROLE_CLINIC_DATA_DIR: data, ROLE_CLINIC_NO_BROWSER: '1', NODE_OPTIONS: '', NODE_PATH: '', PORT: '' })
async function cli(args, options = {}) {
  const env = { ...cleanEnv(), ...options.env }; if (!env.PORT) delete env.PORT
  const node = join(bundle, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')
  return execFile(node, [join(bundle, 'launcher.mjs'), ...args], { cwd: root, env, windowsHide: true, timeout: 45000, maxBuffer: 4 * 1024 * 1024 })
}
async function serverState() { return JSON.parse(await readFile(join(data, 'instance.json'), 'utf8')) }
async function api(path, value, method = 'GET', extraHeaders = {}) {
  const current = await serverState(), base = `http://127.0.0.1:${current.port}`
  return fetch(`${base}${path}`, { method, headers: { ...(method !== 'GET' ? { origin: base, 'content-type': 'application/json' } : {}), ...extraHeaders }, ...(value === undefined ? {} : { body: JSON.stringify(value) }), signal: AbortSignal.timeout(15000) })
}
async function json(path, value, method = 'GET') { const response = await api(path, value, method); const result = await response.json(); assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(result)}`); return result }
async function databaseWork(code) {
  const module = pathToFileURL(join(bundle, 'app/node_modules/better-sqlite3/lib/index.js')).href
  const script = `import Database from ${JSON.stringify(module)};const db=new Database(${JSON.stringify(join(data, 'role-clinic.sqlite'))});try{${code}}finally{db.close()}`
  return execFile(join(bundle, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'), ['--input-type=module', '-e', script], { env: cleanEnv(), cwd: root, timeout: 10000 })
}
try {
  await cli(['verify'])
  // The data folder is reported by the app itself, so other tools never need to know the OS layout.
  assert.equal((await cli(['data-dir'])).stdout.trim(), data)
  if (process.platform !== 'win32') await execFile(join(bundle, 'role-clinic'), ['help'], { env: cleanEnv(), timeout: 10000 })
  const launches = await Promise.all([cli(['start', '--no-browser']), cli(['start', '--no-browser'])]); running = true
  assert.ok(launches.some((r) => r.stdout.includes('Already running')))
  const first = await serverState(); assert.ok(first.port > 0)
  if (process.platform === 'linux') {
  const browserDir = join(root, 'mock-browser'), browserLog = join(root, 'opened-url')
  await mkdir(browserDir)
  await writeFile(join(browserDir, 'xdg-open'), '#!/bin/sh\nprintf "%s\\n" "$1" > "$ROLE_CLINIC_BROWSER_LOG"\n')
  await chmod(join(browserDir, 'xdg-open'), 0o755)
  await cli([], { env: { PATH: browserDir, ROLE_CLINIC_NO_BROWSER: '0', ROLE_CLINIC_BROWSER_LOG: browserLog } })
  assert.equal((await readFile(browserLog, 'utf8')).trim(), `http://127.0.0.1:${first.port}`)
  }
  const initial = await json('/api/app/status'); assert.equal(initial.welcomeComplete, false)
  const page = await api('/'); assert.equal(page.status, 200)
  const html = await page.text(), script = html.match(/src="([^"]+\.js)"/)[1]
  assert.equal((await api(script)).status, 200)
  assert.equal((await api('/guide.html')).status, 200)
  assert.equal((await api('/icon.svg')).status, 200)
  assert.equal((await api('/logo.svg')).status, 200)
  assert.equal((await api('/api/not-a-route')).status, 404)
  assert.equal((await api('/api/app/welcome', { acknowledged: true }, 'POST', { origin: 'https://evil.example' })).status, 403)
  // A local controlled Ollama responder exercises connection/configuration without inference.
  const { createServer } = await import('node:http')
  const ollama = createServer((req, res) => { assert.equal(req.url, '/api/tags'); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ models: [{ name: 'controlled-model' }] })) })
  await new Promise((resolve) => ollama.listen(0, '127.0.0.1', resolve))
  try {
    const settings = await json('/api/settings')
    await json('/api/settings', { ...settings, ollamaBaseUrl: `http://127.0.0.1:${ollama.address().port}` }, 'PUT')
    assert.deepEqual((await json('/api/connections/ollama/test', {}, 'POST')).models, ['controlled-model'])
  } finally { await new Promise((resolve) => ollama.close(resolve)) }
  const badHost = await new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: first.port, path: '/api/health', headers: { host: `evil.example:${first.port}` } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)) }); req.on('error', reject); req.end()
  }); assert.equal(badHost, 403)
  await json('/api/app/welcome', { acknowledged: true }, 'POST')
  const job = await json('/api/jobs', { company: 'Smoke Example', title: 'Engineer', text: 'Build reliable TypeScript APIs and maintain software systems with our engineering team.' }, 'POST')
  const answer = await json(`/api/jobs/${job.id}/answers`, { question: 'Why this team?', answer: 'I enjoy building reliable APIs.', category: 'why-us' }, 'POST')
  const profile = await json('/api/profile')
  await json('/api/profile', { document: { ...profile.document, name: 'Sample Candidate', email: 'sample@example.test' }, expectedUpdatedAt: profile.updatedAt }, 'PUT')
  await cli(['stop']); running = false
  // Seed a controlled, reviewed source draft without calling a model.
  const roleId = randomUUID(), bulletId = randomUUID(), runId = randomUUID(), outId = randomUUID()
  const seedModule = pathToFileURL(join(bundle, 'app/apps/server/src/master.js')).href
  const shared = pathToFileURL(join(bundle, 'app/packages/shared/src/index.js')).href
  await databaseWork(`const {saveMaster,snapshotMaster}=await import(${JSON.stringify(seedModule)});const {emptyMaster}=await import(${JSON.stringify(shared)});const master=emptyMaster();master.roles.push({id:${JSON.stringify(roleId)},company:'Source Company',title:'Engineer',start:'2024',end:'Present',bullets:[{id:${JSON.stringify(bulletId)},rev:1,text:'Built reliable TypeScript APIs',skills:['TypeScript'],metrics:[],verbs:[],sourceRef:'synthetic smoke fixture'}]});saveMaster(db,master);const hash=snapshotMaster(db);const now=new Date().toISOString();db.prepare('INSERT INTO runs(id,job_id,kind,status,step,created_at) VALUES(?,?,?,?,?,?)').run(${JSON.stringify(runId)},${JSON.stringify(job.id)},'tailor','done','complete',now);const document={jobId:${JSON.stringify(job.id)},runId:${JSON.stringify(runId)},snapshotHash:hash,summary:null,skillsLine:[],lines:[{outId:${JSON.stringify(outId)},text:'Built reliable TypeScript APIs',sourceIds:[${JSON.stringify(bulletId)}],author:'model',verdict:'grounded',layer1Flags:[],layer2Reason:'Controlled fixture',slopFlags:[]}],scores:[],gaps:[],exportReady:true};db.prepare('INSERT INTO tailored(id,job_id,run_id,snapshot_hash,document,created_at) VALUES(?,?,?,?,?,?)').run(${JSON.stringify(runId)},${JSON.stringify(job.id)},${JSON.stringify(runId)},hash,JSON.stringify(document),now);`)
  await cli(['start', '--no-browser']); running = true
  let review = (await json(`/api/jobs/${job.id}/review`)).review
  review = (await json(`/api/jobs/${job.id}/review`, { runId, revision: review.revision, action: { kind: 'decision', outId, decision: 'accepted' } }, 'PUT')).review
  const pdf = await json(`/api/jobs/${job.id}/review/export`, { runId, revision: review.revision, format: 'pdf' }, 'POST')
  const docx = await json(`/api/jobs/${job.id}/review/export`, { runId, revision: review.revision, format: 'docx' }, 'POST')
  const pdfBytes = Buffer.from(await (await api(pdf.downloadUrl)).arrayBuffer()); assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-')
  assert.equal(Buffer.from(await (await api(docx.downloadUrl)).arrayBuffer()).subarray(0, 2).toString(), 'PK')
  const proof = await json(`/api/jobs/${job.id}/review/preview`, { runId, revision: review.revision }, 'POST'); assert.equal(proof.parseCheck.ok, true); assert.ok(proof.pages > 0)
  await json(`/api/jobs/${job.id}/status`, { status: 'applied', submittedArtifactId: pdf.id }, 'PUT')
  assert.equal((await json(`/api/jobs/${job.id}/submitted`)).answers[0].answer, 'I enjoy building reliable APIs.')
  assert.equal(Buffer.from(await (await api('/api/tracker/export/xlsx')).arrayBuffer()).subarray(0, 2).toString(), 'PK')
  assert.ok((await (await api('/api/tracker/export/qa.csv')).text()).includes('I enjoy building reliable APIs.'))
  const settings = await json('/api/settings')
  await json('/api/settings', { ...settings, anthropicApiKey: 'FAKE_SMOKE_ONLY_KEY' }, 'PUT')
  assert.equal((await json('/api/settings')).anthropicApiKey, undefined)
  const fullBackup = join(root, 'full-backup.tar.gz')
  await assert.rejects(cli(['backup', fullBackup]), /Stop the app/)
  await cli(['stop']); running = false
  await cli(['backup', fullBackup, '--include-api-key']); assert.equal((await stat(fullBackup)).mode & 0o777, 0o600)
  // A previous schema is migrated from a preserved on-disk snapshot during update.
  await databaseWork(`db.exec('ALTER TABLE applications DROP COLUMN outcome; ALTER TABLE status_events DROP COLUMN outcome; DROP TABLE feed_imports; DROP INDEX jobs_origin_idx; ALTER TABLE jobs DROP COLUMN origin; ALTER TABLE jobs DROP COLUMN found_at; ALTER TABLE jobs DROP COLUMN posted_at; ALTER TABLE jobs DROP COLUMN finder_priority; ALTER TABLE jobs DROP COLUMN finder_note; ALTER TABLE jobs DROP COLUMN posting_state; DROP TABLE tracker_preferences; DROP INDEX job_answers_job_idx; ALTER TABLE applications DROP COLUMN follow_up_date; ALTER TABLE applications DROP COLUMN last_contact_at; ALTER TABLE applications DROP COLUMN contacts; ALTER TABLE applications DROP COLUMN submitted_job_text; ALTER TABLE job_answers DROP COLUMN submitted_question; ALTER TABLE job_answers DROP COLUMN submitted_category; PRAGMA user_version=6;')`)
  const updated = join(root, 'updated package with spaces'); await rename(bundle, updated); bundle = updated
  const manifest = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8')); manifest.version += '-update-test'; await writeFile(join(bundle, 'manifest.json'), JSON.stringify(manifest))
  await cli(['start', '--no-browser']); running = true
  const status = await json('/api/app/status'); assert.equal(status.version, manifest.version); assert.equal(status.schemaVersion, 9); assert.equal(status.welcomeComplete, true)
  assert.ok((await readdir(join(data, 'backups'))).some((name) => name.startsWith('pre-migration-v6-')))
  assert.equal((await json(`/api/jobs/${job.id}`)).answers[0].submittedAnswer, 'I enjoy building reliable APIs.')
  await json(`/api/jobs/${job.id}/answers/${answer.id}`, { question: 'Why this team?', answer: 'Changed working answer after backup.', category: 'why-us' }, 'PUT')
  await cli(['stop']); running = false
  await cli(['restore', fullBackup]); assert.ok((await databaseWork(`console.log(db.prepare('SELECT answer FROM job_answers').get().answer)`)).stdout.includes('Changed working answer'))
  const restoredData = join(root, 'restored on another account'); data = restoredData
  await cli(['restore', fullBackup, '--confirm'])
  await cli(['start', '--no-browser']); running = true
  assert.equal((await json(`/api/jobs/${job.id}`)).answers[0].answer, 'I enjoy building reliable APIs.')
  assert.equal((await json('/api/settings')).anthropicApiKeyConfigured, true)
  assert.equal(JSON.parse(await readFile(join(data, 'settings.json'), 'utf8')).anthropicApiKey, 'FAKE_SMOKE_ONLY_KEY')
  assert.ok(Buffer.from(await (await api(pdf.downloadUrl)).arrayBuffer()).equals(pdfBytes))
  await cli(['stop']); running = false
  // A stale record is recovered; an occupied explicit port is never hijacked.
  await writeFile(join(data, 'server.lock'), JSON.stringify({ pid: 2147483647, token: 'stale' }))
  await writeFile(join(data, 'instance.json'), '{interrupted record')
  await cli(['start', '--no-browser']); running = true; await cli(['stop']); running = false
  const blocker = (await import('node:net')).createServer(); await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve))
  try { await assert.rejects(cli(['start', '--no-browser'], { env: { PORT: String(blocker.address().port) } }), /startup exited/) }
  finally { await new Promise((resolve) => blocker.close(resolve)) }
  await databaseWork('db.pragma("user_version=99")')
  const before = await readFile(join(data, 'role-clinic.sqlite'))
  await assert.rejects(cli(['start', '--no-browser']), /startup exited/)
  assert.ok((await readFile(join(data, 'app.log'), 'utf8')).includes('newer version'))
  assert.ok((await readFile(join(data, 'role-clinic.sqlite'))).equals(before))
  if (process.platform === 'linux') {
    await cli(['install-desktop']); assert.ok((await readFile(join(root, 'xdg/applications/the-role-clinic.desktop'), 'utf8')).includes('Exec="'))
    await cli(['uninstall-desktop'])
  }
  console.log(JSON.stringify({ passed: true, platform: process.platform, arch: process.arch, os: release(), glibcRuntime: process.report.getReport().header.glibcVersionRuntime, runtime: manifest.nodeVersion, requirements: manifest.requirements, isolatedData: true, systemNodeOnPath: false, scenarios: ['concurrent launch', 'loopback guards', 'first run', 'controlled Ollama connection', 'capture and Q&A', 'real PDF/DOCX/XLSX', 'submitted records', 'update and migration', 'full backup and relocated restore', 'stale lock', 'port collision', 'newer schema refusal', ...(process.platform === 'linux' ? ['browser opener', 'desktop shortcut'] : [])] }, null, 2))
} catch (error) {
  try { console.error(await readFile(join(data, 'app.log'), 'utf8')) } catch {}
  throw error
} finally {
  if (running) { try { await cli(['stop', '--force']) } catch {} }
  await rm(root, { recursive: true, force: true })
}

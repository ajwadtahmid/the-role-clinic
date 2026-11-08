import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, symlink, stat, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { c, x } from 'tar'
import { createDatabase } from './db.js'
import { databaseBackup } from './database-backups.js'
import { createFullBackup, inspectFullBackup, restoreFullBackup } from './maintenance.js'
import { acquireProcessLock, lockOwnerAlive, processStart } from './process-lock.js'
import { defaultSettings, writeSettings } from './settings.js'
import { createApp } from './app.js'

const directories: string[] = []
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'clinic-recovery-')); directories.push(root)
  const data = join(root, 'original data'), { sqlite } = createDatabase(data)
  const id = randomUUID(), artifactId = randomUUID(), filename = `${artifactId}.pdf`
  sqlite.prepare('INSERT INTO jobs(id,company,title,captured_at,raw_snapshot,text) VALUES(?,?,?,?,?,?)').run(id, 'Example', 'Engineer', new Date().toISOString(), 'Original capture', 'Original captured job description text with enough evidence.')
  await mkdir(join(data, 'artifacts'))
  await writeFile(join(data, 'artifacts', filename), '%PDF-synthetic-preserved-bytes')
  sqlite.prepare('INSERT INTO artifacts(id,job_id,file_path,media_type,created_at,document) VALUES(?,?,?,?,?,?)').run(artifactId, id, join(data, 'artifacts', filename), 'application/pdf', new Date().toISOString(), JSON.stringify({ filename: 'sent.pdf', blocks: [{ text: 'Sent résumé' }] }))
  sqlite.close()
  await writeSettings(data, { ...defaultSettings(), anthropicApiKey: 'FAKE_LOCAL_KEY' })
  await writeFile(join(data, 'welcome.json'), JSON.stringify({ acknowledgedAt: '2026-11-06' }))
  return { root, data, id, artifactId, filename, archive: join(root, 'full.tar.gz') }
}
describe('full-data recovery', () => {
  it('round-trips records, settings, welcome and exact artifacts into a different data directory', async () => {
    const f = await fixture(); expect(await createFullBackup(f.data, f.archive, { includeApiKey: true })).toMatchObject({ apiKeyIncluded: true })
    if (process.platform !== 'win32') expect((await stat(f.archive)).mode & 0o777).toBe(0o600)
    expect(await inspectFullBackup(f.archive, join(f.root, 'relocated'))).toMatchObject({ files: 4, schemaVersion: 8 })
    const moved = join(f.root, 'relocated'); await mkdir(moved); await writeFile(join(moved, 'old-marker'), 'keep this')
    const result = await restoreFullBackup(f.archive, moved)
    expect(await readFile(join(result.recoveryDirectory!, 'old-marker'), 'utf8')).toBe('keep this')
    const database = createDatabase(moved).sqlite
    expect(database.prepare('SELECT company FROM jobs').get()).toEqual({ company: 'Example' })
    expect(database.prepare('SELECT file_path FROM artifacts').get()).toEqual({ file_path: join(moved, 'artifacts', f.filename) })
    expect(database.pragma('integrity_check', { simple: true })).toBe('ok'); database.close()
    expect(await readFile(join(moved, 'artifacts', f.filename), 'utf8')).toBe('%PDF-synthetic-preserved-bytes')
    expect(JSON.parse(await readFile(join(moved, 'settings.json'), 'utf8')).anthropicApiKey).toBe('FAKE_LOCAL_KEY')
    if (process.platform !== 'win32') expect((await stat(join(moved, 'settings.json'))).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(join(moved, 'welcome.json'), 'utf8')).acknowledgedAt).toBe('2026-11-06')
    await expect(createFullBackup(f.data, f.archive)).rejects.toMatchObject({ code: 'EEXIST' })
  })
  it.each(['Windows', 'POSIX'])('relocates artifacts from %s paths into the current OS data folder', async (sourceOS) => {
    const f = await fixture(); await createFullBackup(f.data, f.archive)
    const stage = join(f.root, 'windows-backup'); await mkdir(stage); await x({ file: f.archive, cwd: stage })
    const db = new Database(join(stage, 'role-clinic.sqlite'))
    const sourcePath = sourceOS === 'Windows' ? win32.join('C:\\Users\\Example ü\\AppData\\Roaming\\The Role Clinic\\artifacts', f.filename) : `/Users/example/Library/Application Support/The Role Clinic/artifacts/${f.filename}`
    db.prepare('UPDATE artifacts SET file_path=?').run(sourcePath); db.close()
    const manifest = JSON.parse(await readFile(join(stage, 'backup.json'), 'utf8'))
    const bytes = await readFile(join(stage, 'role-clinic.sqlite'))
    Object.assign(manifest.files.find((file: { path: string }) => file.path === 'role-clinic.sqlite'), { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length })
    await writeFile(join(stage, 'backup.json'), JSON.stringify(manifest))
    const archive = join(f.root, 'windows.tar.gz'); await c({ cwd: stage, file: archive, gzip: true }, ['backup.json', ...manifest.files.map((file: { path: string }) => file.path)])
    const target = join(f.root, 'new account ü'); await restoreFullBackup(archive, target)
    const restored = new Database(join(target, 'role-clinic.sqlite'))
    try { expect(restored.prepare('SELECT file_path FROM artifacts').get()).toEqual({ file_path: join(target, 'artifacts', f.filename) }) } finally { restored.close() }
    expect(await readFile(join(target, 'artifacts', f.filename), 'utf8')).toBe('%PDF-synthetic-preserved-bytes')
  })
  it('restores a backup made before the database file was renamed', async () => {
    const f = await fixture(); await createFullBackup(f.data, f.archive)
    const stage = join(f.root, 'old-name'); await mkdir(stage); await x({ file: f.archive, cwd: stage })
    await rename(join(stage, 'role-clinic.sqlite'), join(stage, 'clinic.sqlite'))
    const manifest = JSON.parse(await readFile(join(stage, 'backup.json'), 'utf8'))
    manifest.files.find((file: { path: string }) => file.path === 'role-clinic.sqlite').path = 'clinic.sqlite'
    await writeFile(join(stage, 'backup.json'), JSON.stringify(manifest))
    const archive = join(f.root, 'old-name.tar.gz'); await c({ cwd: stage, file: archive, gzip: true }, ['backup.json', ...manifest.files.map((file: { path: string }) => file.path)])
    const target = join(f.root, 'restored-old-name'); await restoreFullBackup(archive, target)
    const restored = new Database(join(target, 'role-clinic.sqlite'))
    try { expect(restored.prepare('SELECT company FROM jobs').get()).toEqual({ company: 'Example' }) } finally { restored.close() }
    expect((await readdir(target)).includes('clinic.sqlite')).toBe(false)
  })
  it('leaves the API key out of a full backup unless asked, keeping every other setting', async () => {
    const f = await fixture()
    expect(await createFullBackup(f.data, f.archive)).toMatchObject({ apiKeyIncluded: false })
    const unpacked = join(f.root, 'unpacked'); await mkdir(unpacked); await x({ file: f.archive, cwd: unpacked })
    const saved = JSON.parse(await readFile(join(unpacked, 'settings.json'), 'utf8'))
    expect(saved.anthropicApiKey).toBeUndefined()
    expect(saved.ollamaBaseUrl).toBe(defaultSettings().ollamaBaseUrl)
    expect(await readFile(join(unpacked, 'settings.json'), 'utf8')).not.toContain('FAKE_LOCAL_KEY')
    const restored = join(f.root, 'restored-without-key')
    await expect(inspectFullBackup(f.archive, restored)).resolves.toMatchObject({ schemaVersion: 8 })
  })
  it('does not mistake an unrelated process that reuses a dead lock owner’s id for a live owner', () => {
    expect(lockOwnerAlive({ pid: process.pid })).toBe(true)
    expect(lockOwnerAlive({ pid: 0x7ffffffe })).toBe(false)
    const own = processStart(process.pid)
    if (own === null) return // start times are read from /proc, so only Linux can tell a reused id apart
    expect(lockOwnerAlive({ pid: process.pid, started: own })).toBe(true)
    expect(lockOwnerAlive({ pid: process.pid, started: `${own}0` })).toBe(false)
  })
  it('rejects checksum damage before replacing existing records and retains all original data', async () => {
    const f = await fixture(); await createFullBackup(f.data, f.archive)
    const edited = join(f.root, 'edited'); await mkdir(edited); await x({ file: f.archive, cwd: edited })
    await writeFile(join(edited, 'welcome.json'), 'tampered')
    const damaged = join(f.root, 'damaged.tar.gz'); await c({ cwd: edited, file: damaged, gzip: true }, ['backup.json', 'role-clinic.sqlite', 'settings.json', 'welcome.json', `artifacts/${f.filename}`])
    await expect(restoreFullBackup(damaged, f.data)).rejects.toThrow('checksum')
    const database = createDatabase(f.data).sqlite; expect(database.prepare('SELECT company FROM jobs').get()).toEqual({ company: 'Example' }); database.close()
    expect((await readdir(f.root)).some((name) => name.includes('.before-restore-'))).toBe(false)
    expect((await readdir(f.root)).some((name) => name.startsWith('.clinic-restore-'))).toBe(false)
  })
  it('rejects links and missing artifact bytes instead of making incomplete backups', async () => {
    const f = await fixture(), stage = join(f.root, 'links'); await mkdir(stage); await symlink(f.data, join(stage, 'role-clinic.sqlite'), process.platform === 'win32' ? 'junction' : 'dir')
    const bad = join(f.root, 'links.tar.gz'); await c({ cwd: stage, file: bad, gzip: true }, ['role-clinic.sqlite'])
    await expect(inspectFullBackup(bad, f.data)).rejects.toThrow('unsafe')
    await rm(join(f.data, 'artifacts', f.filename))
    await expect(createFullBackup(f.data, f.archive)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(f.archive)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('backs up before migration and refuses a database created by a newer app', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clinic-version-')); directories.push(root)
    const { sqlite } = createDatabase(root)
    sqlite.pragma('user_version=6')
    // Remove exactly the v7 and v8 additions to simulate an actual previous version.
    sqlite.exec('DROP TABLE feed_imports; DROP INDEX jobs_origin_idx; ALTER TABLE jobs DROP COLUMN origin; ALTER TABLE jobs DROP COLUMN found_at; ALTER TABLE jobs DROP COLUMN posted_at; ALTER TABLE jobs DROP COLUMN finder_priority; ALTER TABLE jobs DROP COLUMN finder_note; ALTER TABLE jobs DROP COLUMN posting_state; DROP TABLE tracker_preferences; DROP INDEX job_answers_job_idx; ALTER TABLE applications DROP COLUMN follow_up_date; ALTER TABLE applications DROP COLUMN last_contact_at; ALTER TABLE applications DROP COLUMN contacts; ALTER TABLE applications DROP COLUMN submitted_job_text; ALTER TABLE job_answers DROP COLUMN submitted_question; ALTER TABLE job_answers DROP COLUMN submitted_category;')
    sqlite.close()
    const upgraded = createDatabase(root).sqlite
    expect(upgraded.pragma('user_version', { simple: true })).toBe(8); upgraded.close()
    const saved = (await readdir(join(root, 'backups'))).find((name) => name.startsWith('pre-migration-v6'))!
    const original = new Database(join(root, 'backups', saved), { readonly: true }); expect(original.pragma('user_version', { simple: true })).toBe(6); original.close()
    const future = new Database(join(root, 'role-clinic.sqlite')); future.pragma('user_version=99'); future.close()
    const before = await readFile(join(root, 'role-clinic.sqlite'))
    expect(() => createDatabase(root)).toThrow('newer version')
    expect((await readFile(join(root, 'role-clinic.sqlite'))).equals(before)).toBe(true)
  })
  it('keeps 14 automatic snapshots while retaining manual backups', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clinic-retention-')); directories.push(root)
    const { sqlite } = createDatabase(root), manual = databaseBackup(sqlite, root)
    for (let i = 0; i < 17; i++) databaseBackup(sqlite, root, 'auto')
    sqlite.close()
    const backups = await readdir(join(root, 'backups'))
    expect(backups.filter((name) => name.startsWith('auto-'))).toHaveLength(14)
    expect(backups).toContain(manual.filename)
  })
  it('serializes maintenance and recovers a lock whose owning process is gone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clinic-lock-')); directories.push(root)
    const path = join(root, 'operation.lock'), release = await acquireProcessLock(path)
    await expect(acquireProcessLock(path, 20)).rejects.toThrow('in use')
    await release(); await writeFile(path, JSON.stringify({ pid: 2147483647, token: 'stale' }))
    const second = await acquireProcessLock(path); await second()
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('requires same-origin first-run confirmation and serves named database backup downloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clinic-runtime-api-')); directories.push(root)
    const { sqlite, db } = createDatabase(root), app = createApp({ dataDirectory: root, sqlite, db, port: 3000 })
    const request = (path: string, init: RequestInit = {}) => app.request(`http://127.0.0.1:3000${path}`, { ...init, headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'content-type': 'application/json', ...init.headers } })
    expect(await (await request('/api/app/status')).json()).toMatchObject({ welcomeComplete: false, version: 'development' })
    expect((await request('/api/app/welcome', { method: 'POST', body: '{}' })).status).toBe(400)
    expect((await request('/api/app/welcome', { method: 'POST', body: '{"acknowledged":true}' })).status).toBe(200)
    expect(await (await request('/api/app/status')).json()).toMatchObject({ welcomeComplete: true })
    const backup = await (await request('/api/backups', { method: 'POST', body: '{}' })).json() as { filename: string }
    expect((await request(`/api/backups/${backup.filename}`)).status).toBe(200)
    expect((await request('/api/backups/settings.json')).status).toBe(400)
    expect((await request('/api/app/quit', { method: 'POST', body: '{}' })).status).toBe(409)
    sqlite.close()
  })
})

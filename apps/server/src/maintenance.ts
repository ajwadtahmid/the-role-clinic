import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join, dirname, basename, resolve, relative, win32, sep, isAbsolute } from 'node:path'
import Database from 'better-sqlite3'
import { c, t, x } from 'tar'
import { z } from 'zod'
import { CURRENT_SCHEMA_VERSION, createDatabase } from './db.js'
import { appSettingsSchema } from '../../../packages/shared/src/index.js'
import { protectPrivateFile } from './private-file.js'

const allowed = /^(backup\.json|clinic\.sqlite|settings\.json|welcome\.json|artifacts\/[a-f0-9-]{36}\.(pdf|docx))$/
const MAX_BYTES = 2 * 1024 * 1024 * 1024
const manifestSchema = z.object({ format: z.literal('the-role-clinic-backup'), version: z.literal(1), createdAt: z.string(), schemaVersion: z.number().int().min(1).max(CURRENT_SCHEMA_VERSION), files: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative() }).strict()).max(20000) }).strict()
const hash = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex')
async function optionalCopy(source: string, target: string) { try { await copyFile(source, target); return true } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return false } }
// settings.json holds the Anthropic API key. A backup omits it unless the caller opts in, so an archive that is
// synced, mailed or moved to another computer does not carry a paid credential by accident.
async function stagedSettings(source: string, target: string, includeApiKey: boolean) {
  let text: string
  try { text = await readFile(source, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  const settings = appSettingsSchema.parse(JSON.parse(text))
  if (!includeApiKey) delete settings.anthropicApiKey
  await writeFile(target, '', { mode: 0o600, flag: 'wx' })
  await protectPrivateFile(target)
  await writeFile(target, JSON.stringify(settings, null, 2))
  return true
}
export async function createFullBackup(dataDirectory: string, destination: string, options: { includeApiKey?: boolean } = {}) {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  const staging = await mkdtemp(join(dirname(dataDirectory), '.clinic-backup-'))
  const temporary = `${destination}.${randomUUID()}.partial`
  try {
    const db = new Database(join(dataDirectory, 'clinic.sqlite'), { readonly: true, fileMustExist: true })
    try {
      db.prepare('VACUUM INTO ?').run(join(staging, 'clinic.sqlite'))
      const paths = db.prepare('SELECT id,file_path FROM artifacts').all() as Array<{ id: string; file_path: string }>
      await mkdir(join(staging, 'artifacts'), { mode: 0o700 })
      for (const artifact of paths) {
        const name = win32.basename(basename(artifact.file_path))
        if (!allowed.test(`artifacts/${name}`) || !name.startsWith(`${artifact.id}.`)) throw new Error('An artifact has an unexpected filename; backup stopped without omitting it.')
        const source = join(dataDirectory, 'artifacts', name)
        if (resolve(artifact.file_path) !== resolve(source) || !(await lstat(source)).isFile()) throw new Error('An artifact is outside this data folder or is not a regular file.')
        await copyFile(source, join(staging, 'artifacts', name))
      }
    } finally { db.close() }
    await stagedSettings(join(dataDirectory, 'settings.json'), join(staging, 'settings.json'), options.includeApiKey === true)
    await optionalCopy(join(dataDirectory, 'welcome.json'), join(staging, 'welcome.json'))
    const names = ['clinic.sqlite', ...await readdir(staging).then((names) => names.filter((name) => name.endsWith('.json'))), ...(await readdir(join(staging, 'artifacts'))).map((name) => `artifacts/${name}`)]
    const files = []
    let total = 0
    for (const path of names) { const buffer = await readFile(join(staging, path)); total += buffer.length; if (total > MAX_BYTES) throw new Error('This backup exceeds the 2 GiB archive limit.'); files.push({ path, size: buffer.length, sha256: hash(buffer) }) }
    const database = new Database(join(staging, 'clinic.sqlite'), { readonly: true })
    const schemaVersion = Number(database.pragma('user_version', { simple: true })); database.close()
    const manifest = manifestSchema.parse({ format: 'the-role-clinic-backup', version: 1, createdAt: new Date().toISOString(), schemaVersion, files })
    await writeFile(join(staging, 'backup.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 })
    await c({ file: temporary, cwd: staging, gzip: true, portable: true, noMtime: true, mode: 0o600 }, ['backup.json', ...names])
    await chmod(temporary, 0o600)
    // An explicit destination never overwrites an existing backup.
    const { link, unlink } = await import('node:fs/promises')
    // A hard link refuses to replace an existing file. Some filesystems (FAT/exFAT, certain network shares)
    // have no hard links, so fall back to an exclusive copy, which also refuses to overwrite.
    try { await link(temporary, destination) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw error
      await copyFile(temporary, destination, constants.COPYFILE_EXCL); await chmod(destination, 0o600)
    }
    await unlink(temporary)
    return { destination, files: files.length, schemaVersion, apiKeyIncluded: options.includeApiKey === true }
  } finally { await rm(staging, { recursive: true, force: true }); await rm(temporary, { force: true }) }
}
async function stageBackup(archive: string, dataDirectory: string) {
  const staging = await mkdtemp(join(dirname(dataDirectory), '.clinic-restore-'))
  const names = new Set<string>()
  try {
    let expanded = 0, problem = ''
    await t({ file: archive, strict: true, onReadEntry: (entry) => {
      if (entry.type !== 'File' || !allowed.test(entry.path) || names.has(entry.path)) problem = 'Backup contains an unsafe, duplicate or unexpected archive entry.'
      names.add(entry.path); expanded += entry.size
      if (expanded > MAX_BYTES || names.size > 20001) problem = 'Backup exceeds the restore size limit.'
    } })
    if (problem) throw new Error(problem)
    await x({ file: archive, cwd: staging, strict: true, noChmod: true, preservePaths: false, filter: (path, entry) => 'type' in entry && entry.type === 'File' && allowed.test(path) })
    const manifest = manifestSchema.parse(JSON.parse(await readFile(join(staging, 'backup.json'), 'utf8')))
    if (manifest.files.length !== names.size - 1 || !manifest.files.some((file) => file.path === 'clinic.sqlite')) throw new Error('Backup manifest does not match its contents.')
    const seen = new Set<string>()
    for (const file of manifest.files) {
      if (!allowed.test(file.path) || file.path === 'backup.json' || !names.has(file.path) || seen.has(file.path)) throw new Error('Backup manifest contains an unexpected or duplicate file.')
      seen.add(file.path)
      const bytes = await readFile(join(staging, file.path))
      if (bytes.length !== file.size || hash(bytes) !== file.sha256) throw new Error(`Backup checksum failed: ${file.path}`)
      await chmod(join(staging, file.path), 0o600)
      if (file.path === 'settings.json') await protectPrivateFile(join(staging, file.path))
    }
    if (names.has('settings.json')) appSettingsSchema.parse(JSON.parse(await readFile(join(staging, 'settings.json'), 'utf8')))
    const check = new Database(join(staging, 'clinic.sqlite'), { readonly: true })
    try {
      if (check.pragma('integrity_check', { simple: true }) !== 'ok' || (check.pragma('foreign_key_check') as unknown[]).length) throw new Error('Backup database integrity check failed.')
      if (Number(check.pragma('user_version', { simple: true })) !== manifest.schemaVersion) throw new Error('Backup schema does not match its manifest.')
    } finally { check.close() }
    const { sqlite } = createDatabase(staging)
    try {
      for (const artifact of sqlite.prepare('SELECT id,file_path FROM artifacts').all() as Array<{ id: string; file_path: string }>) {
        // Backup records retain their source OS paths until restored here.
        const name = win32.basename(basename(artifact.file_path))
        if (!allowed.test(`artifacts/${name}`) || !name.startsWith(`${artifact.id}.`) || !seen.has(`artifacts/${name}`)) throw new Error('A recorded artifact is missing from this backup.')
        sqlite.prepare('UPDATE artifacts SET file_path=? WHERE id=?').run(join(dataDirectory, 'artifacts', name), artifact.id)
      }
      sqlite.pragma('wal_checkpoint(TRUNCATE)')
    } finally { sqlite.close() }
    await chmod(staging, 0o700)
    return { staging, manifest }
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error }
}
export async function inspectFullBackup(archive: string, dataDirectory: string) {
  const { staging, manifest } = await stageBackup(archive, dataDirectory)
  await rm(staging, { recursive: true, force: true })
  return { createdAt: manifest.createdAt, files: manifest.files.length, schemaVersion: manifest.schemaVersion }
}
export async function restoreFullBackup(archive: string, dataDirectory: string) {
  const archivePath = resolve(archive), dataPath = resolve(dataDirectory)
  const child = relative(dataPath, archivePath)
  if (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`)) throw new Error('Move the backup archive outside the data folder before restoring.')
  const { staging, manifest } = await stageBackup(archivePath, dataPath)
  const recovery = `${dataPath}.before-restore-${Date.now()}-${randomUUID()}`
  let moved = false
  try {
    try { await rename(dataPath, recovery); moved = true } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    try { await rename(staging, dataPath) } catch (error) { if (moved) await rename(recovery, dataPath); throw error }
    return { restoredAt: new Date().toISOString(), files: manifest.files.length, recoveryDirectory: moved ? recovery : null }
  } finally { await rm(staging, { recursive: true, force: true }) }
}

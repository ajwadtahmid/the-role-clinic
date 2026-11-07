import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'

export function databaseBackup(sqlite: Database.Database, dataDirectory: string, kind: 'manual' | 'auto' | 'migration' = 'manual', schemaVersion?: number) {
  const directory = join(dataDirectory, 'backups')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const filename = `${kind === 'manual' ? 'clinic' : kind === 'auto' ? 'auto' : `pre-migration-v${schemaVersion}`}-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID()}.sqlite`
  const path = join(directory, filename)
  sqlite.prepare('VACUUM INTO ?').run(path)
  chmodSync(path, 0o600)
  if (kind === 'auto') {
    const automatic = readdirSync(directory).filter((name) => /^auto-[\dTZ-]+-[a-f0-9-]+\.sqlite$/.test(name)).sort().reverse()
    for (const name of automatic.slice(14)) unlinkSync(join(directory, name))
  }
  return { filename, createdAt: new Date().toISOString() }
}

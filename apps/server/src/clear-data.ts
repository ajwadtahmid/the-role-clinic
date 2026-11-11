import type Database from 'better-sqlite3'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

// The three starter synonyms that the database creates on a new install (db.ts, step 4).
const starterSynonyms = [['b58fa528-4e72-4ca3-83e9-0ca7a5123d01', 'JavaScript', 'JS'], ['b58fa528-4e72-4ca3-83e9-0ca7a5123d02', 'PostgreSQL', 'Postgres'], ['b58fa528-4e72-4ca3-83e9-0ca7a5123d03', 'Kubernetes', 'k8s']]

// Empties the database and deletes saved files, so the app starts again as a new install. The job-search
// folder belongs to the separate job search tool and is left alone, and the files that keep the app running stay.
export async function clearAppData(sqlite: Database.Database, dataDirectory: string): Promise<void> {
  const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'job_answers_fts_%'").all() as Array<{ name: string }>).map((row) => row.name)
  sqlite.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE')
  try {
    for (const name of tables) sqlite.exec(`DELETE FROM "${name}"`)
    sqlite.prepare('INSERT INTO tracker_preferences(id,ghosted_days) VALUES(1,14)').run()
    const add = sqlite.prepare('INSERT INTO synonyms(id,term,equivalence,created_at) VALUES(?,?,?,?)')
    for (const [id, term, equivalence] of starterSynonyms) add.run(id, term, equivalence, new Date().toISOString())
    sqlite.exec('COMMIT')
  } catch (error) { sqlite.exec('ROLLBACK'); throw error } finally { sqlite.exec('PRAGMA foreign_keys = ON') }
  sqlite.pragma('wal_checkpoint(TRUNCATE)')
  for (const name of ['artifacts', 'backups']) await rm(join(dataDirectory, name), { recursive: true, force: true })
  for (const name of ['settings.json', 'welcome.json', 'clinic.sqlite', 'clinic.sqlite-wal', 'clinic.sqlite-shm']) await rm(join(dataDirectory, name), { force: true })
}

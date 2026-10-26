import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.js'

export type ClinicDatabase = BetterSQLite3Database<typeof schema>

const schemaSql = `
CREATE TABLE IF NOT EXISTS master (
  id INTEGER PRIMARY KEY CHECK (id = 1), document TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS master_snapshots (
  hash TEXT PRIMARY KEY, document TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS profile (
  id INTEGER PRIMARY KEY CHECK (id = 1), document TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS synonyms (
  id TEXT PRIMARY KEY, term TEXT NOT NULL, equivalence TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, company TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',
  captured_at TEXT NOT NULL, source_url TEXT, raw_snapshot TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS requirements (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  document TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  kind TEXT NOT NULL, status TEXT NOT NULL, step TEXT NOT NULL, preset TEXT,
  prompt_versions TEXT NOT NULL DEFAULT '{}', usage TEXT, cost_estimate REAL,
  error TEXT, started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tailored (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, snapshot_hash TEXT NOT NULL,
  document TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  status TEXT NOT NULL, applied_at TEXT, notes TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS status_events (
  id TEXT PRIMARY KEY, application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  status TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS job_answers (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  question TEXT NOT NULL, answer TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS job_answers_fts USING fts5(answer_id UNINDEXED, job_id UNINDEXED, question, answer);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL, file_path TEXT NOT NULL,
  media_type TEXT NOT NULL, parse_check TEXT, created_at TEXT NOT NULL
);
PRAGMA user_version = 1;
`

export function createDatabase(dataDirectory: string): { sqlite: Database.Database; db: ClinicDatabase } {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 })
  const sqlite = new Database(join(dataDirectory, 'clinic.sqlite'))
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('busy_timeout = 5000')
  const schemaVersion = Number(sqlite.pragma('user_version', { simple: true }))
  if (schemaVersion < 1) {
    try {
      sqlite.exec(`BEGIN IMMEDIATE;\n${schemaSql}\nCOMMIT;`)
    } catch (error) {
      sqlite.exec('ROLLBACK;')
      sqlite.close()
      throw error
    }
  }
  if (schemaVersion < 2) {
    try {
      sqlite.exec(`BEGIN IMMEDIATE;
        ALTER TABLE jobs ADD COLUMN canonical_url TEXT;
        ALTER TABLE jobs ADD COLUMN apply_url TEXT;
        ALTER TABLE jobs ADD COLUMN location TEXT NOT NULL DEFAULT '';
        ALTER TABLE jobs ADD COLUMN remote TEXT NOT NULL DEFAULT '';
        ALTER TABLE jobs ADD COLUMN salary TEXT NOT NULL DEFAULT '';
        ALTER TABLE jobs ADD COLUMN source TEXT NOT NULL DEFAULT 'paste';
        ALTER TABLE jobs ADD COLUMN capture_method TEXT NOT NULL DEFAULT 'paste';
        ALTER TABLE applications ADD COLUMN submitted_text TEXT;
        ALTER TABLE job_answers ADD COLUMN category TEXT NOT NULL DEFAULT 'Other';
        ALTER TABLE job_answers ADD COLUMN char_limit INTEGER;
        ALTER TABLE job_answers ADD COLUMN submitted_answer TEXT;
        ALTER TABLE job_answers ADD COLUMN reused_from TEXT;
        CREATE INDEX IF NOT EXISTS jobs_canonical_url_idx ON jobs(canonical_url);
        CREATE INDEX IF NOT EXISTS applications_status_idx ON applications(status);
        PRAGMA user_version = 2;
      COMMIT;`)
    } catch (error) {
      sqlite.exec('ROLLBACK;')
      sqlite.close()
      throw error
    }
  }
  if (schemaVersion < 3) {
    try {
      sqlite.exec(`BEGIN IMMEDIATE;
        ALTER TABLE jobs ADD COLUMN text TEXT NOT NULL DEFAULT '';
        UPDATE jobs SET text = raw_snapshot;
        ALTER TABLE job_answers ADD COLUMN submitted_at TEXT;
        ALTER TABLE job_answers ADD COLUMN updated_at TEXT;
        UPDATE job_answers SET updated_at = created_at;
        PRAGMA user_version = 3;
      COMMIT;`)
    } catch (error) {
      sqlite.exec('ROLLBACK;')
      sqlite.close()
      throw error
    }
  }
  return { sqlite, db: drizzle(sqlite, { schema }) }
}

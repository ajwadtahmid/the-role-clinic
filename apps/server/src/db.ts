import Database from 'better-sqlite3'
import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { databaseBackup } from './database-backups.js'
import * as schema from './schema.js'

export const CURRENT_SCHEMA_VERSION = 9

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

// If BEGIN itself failed (for example the database is busy) there is nothing to roll back, and a failing
// ROLLBACK would hide the error that actually matters.
function rollbackQuietly(sqlite: Database.Database) {
  if (sqlite.inTransaction) sqlite.exec('ROLLBACK;')
}

export const DATABASE_FILE = 'role-clinic.sqlite'

export function createDatabase(dataDirectory: string): { sqlite: Database.Database; db: ClinicDatabase } {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 })
  const sqlite = new Database(join(dataDirectory, DATABASE_FILE))
  const existingVersion = Number(sqlite.pragma('user_version', { simple: true }))
  if (existingVersion > CURRENT_SCHEMA_VERSION) { sqlite.close(); throw new Error(`This database needs a newer version of The Role Clinic (schema ${existingVersion}). No downgrade was performed.`) }
  if (existingVersion > 0 && existingVersion < CURRENT_SCHEMA_VERSION) {
    try { databaseBackup(sqlite, dataDirectory, 'migration', existingVersion) } catch (error) { sqlite.close(); throw error }
  }
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('busy_timeout = 5000')
  const schemaVersion = Number(sqlite.pragma('user_version', { simple: true }))
  if (schemaVersion < 1) {
    try {
      sqlite.exec(`BEGIN IMMEDIATE;\n${schemaSql}\nCOMMIT;`)
    } catch (error) {
      rollbackQuietly(sqlite)
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
      rollbackQuietly(sqlite)
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
      rollbackQuietly(sqlite)
      sqlite.close()
      throw error
    }
  }
  if (schemaVersion < 4) {
    try {
      sqlite.exec(`BEGIN IMMEDIATE;
        INSERT OR IGNORE INTO synonyms(id,term,equivalence,created_at) VALUES
          ('b58fa528-4e72-4ca3-83e9-0ca7a5123d01','JavaScript','JS',CURRENT_TIMESTAMP),
          ('b58fa528-4e72-4ca3-83e9-0ca7a5123d02','PostgreSQL','Postgres',CURRENT_TIMESTAMP),
          ('b58fa528-4e72-4ca3-83e9-0ca7a5123d03','Kubernetes','k8s',CURRENT_TIMESTAMP);
        PRAGMA user_version = 4;
      COMMIT;`)
    } catch (error) {
      rollbackQuietly(sqlite)
      sqlite.close()
      throw error
    }
  }
  if (schemaVersion < 5) {
    try {
      sqlite.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS run_checkpoints (
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          step TEXT NOT NULL,
          document TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (run_id,step)
        );
        CREATE INDEX IF NOT EXISTS requirements_job_created_idx ON requirements(job_id,created_at);
        CREATE INDEX IF NOT EXISTS tailored_job_created_idx ON tailored(job_id,created_at);
        PRAGMA user_version = 5;
      COMMIT;`)
    } catch (error) {
      rollbackQuietly(sqlite)
      sqlite.close()
      throw error
    }
  }
  if (schemaVersion < 6) {
    try {
      sqlite.exec(`BEGIN IMMEDIATE;
      CREATE TABLE review_drafts (
        run_id TEXT PRIMARY KEY REFERENCES tailored(id) ON DELETE CASCADE,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, document TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      ALTER TABLE artifacts ADD COLUMN document TEXT;
      ALTER TABLE applications ADD COLUMN submitted_artifact_id TEXT REFERENCES artifacts(id);
      PRAGMA user_version = 6;
      COMMIT;`)
    } catch (error) {
      rollbackQuietly(sqlite)
      sqlite.close()
      throw error
    }
  }
  if (schemaVersion < 7) {
    try {
      sqlite.exec(`BEGIN IMMEDIATE;
        ALTER TABLE applications ADD COLUMN follow_up_date TEXT;
        ALTER TABLE applications ADD COLUMN last_contact_at TEXT;
        ALTER TABLE applications ADD COLUMN contacts TEXT NOT NULL DEFAULT '';
        ALTER TABLE applications ADD COLUMN submitted_job_text TEXT;
        ALTER TABLE job_answers ADD COLUMN submitted_question TEXT;
        ALTER TABLE job_answers ADD COLUMN submitted_category TEXT;
        UPDATE job_answers SET submitted_question=question,submitted_category=category WHERE submitted_at IS NOT NULL;
        UPDATE applications SET submitted_job_text=(SELECT text FROM jobs WHERE jobs.id=applications.job_id) WHERE applied_at IS NOT NULL;
        CREATE TABLE tracker_preferences (id INTEGER PRIMARY KEY CHECK(id=1),ghosted_days INTEGER NOT NULL DEFAULT 14);
        INSERT INTO tracker_preferences(id,ghosted_days) VALUES(1,14);
        CREATE INDEX job_answers_job_idx ON job_answers(job_id);
        PRAGMA user_version = 7;
      COMMIT;`)
    } catch (error) { rollbackQuietly(sqlite); sqlite.close(); throw error }
  }
  if (schemaVersion < 8) {
    try {
      sqlite.exec(`BEGIN IMMEDIATE;
        ALTER TABLE jobs ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual';
        ALTER TABLE jobs ADD COLUMN found_at TEXT;
        ALTER TABLE jobs ADD COLUMN posted_at TEXT;
        ALTER TABLE jobs ADD COLUMN finder_priority TEXT;
        ALTER TABLE jobs ADD COLUMN finder_note TEXT;
        ALTER TABLE jobs ADD COLUMN posting_state TEXT;
        CREATE TABLE feed_imports (
          url_key TEXT PRIMARY KEY, first_seen_at TEXT NOT NULL, found_date TEXT, job_id TEXT
        );
        CREATE INDEX jobs_origin_idx ON jobs(origin);
        PRAGMA user_version = 8;
      COMMIT;`)
    } catch (error) { rollbackQuietly(sqlite); sqlite.close(); throw error }
  }
  if (schemaVersion < 9) {
    // Seven stored statuses: screening joins interviewing, and the four ways an application ends become closed plus an outcome.
    // status_events is a log of what happened, so its old rows keep their values; new rows carry an outcome.
    try {
      sqlite.exec(`BEGIN IMMEDIATE;
        ALTER TABLE applications ADD COLUMN outcome TEXT;
        ALTER TABLE status_events ADD COLUMN outcome TEXT;
        UPDATE applications SET
          outcome=CASE status WHEN 'rejected' THEN 'rejected' WHEN 'ghosted' THEN 'no_reply' WHEN 'withdrawn' THEN 'withdrawn' WHEN 'accepted' THEN 'accepted' END,
          status='closed' WHERE status IN ('rejected','ghosted','withdrawn','accepted');
        UPDATE applications SET status='interviewing' WHERE status='screening';
        PRAGMA user_version = 9;
      COMMIT;`)
    } catch (error) { rollbackQuietly(sqlite); sqlite.close(); throw error }
  }
  chmodSync(join(dataDirectory, DATABASE_FILE), 0o600)
  return { sqlite, db: drizzle(sqlite, { schema }) }
}

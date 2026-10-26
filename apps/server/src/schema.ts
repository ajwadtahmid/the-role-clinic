import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const master = sqliteTable('master', {
  id: integer('id').primaryKey(), document: text('document').notNull(), updatedAt: text('updated_at').notNull(),
})
export const masterSnapshots = sqliteTable('master_snapshots', {
  hash: text('hash').primaryKey(), document: text('document').notNull(), createdAt: text('created_at').notNull(),
})
export const profile = sqliteTable('profile', {
  id: integer('id').primaryKey(), document: text('document').notNull(), updatedAt: text('updated_at').notNull(),
})
export const synonyms = sqliteTable('synonyms', {
  id: text('id').primaryKey(), term: text('term').notNull(), equivalence: text('equivalence').notNull(), createdAt: text('created_at').notNull(),
})
export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(), company: text('company').notNull(), title: text('title').notNull(), capturedAt: text('captured_at').notNull(), sourceUrl: text('source_url'), rawSnapshot: text('raw_snapshot').notNull(), text: text('text').notNull(), canonicalUrl: text('canonical_url'), applyUrl: text('apply_url'), location: text('location').notNull(), remote: text('remote').notNull(), salary: text('salary').notNull(), source: text('source').notNull(), captureMethod: text('capture_method').notNull(),
})
export const requirements = sqliteTable('requirements', {
  id: text('id').primaryKey(), jobId: text('job_id').notNull(), document: text('document').notNull(), createdAt: text('created_at').notNull(),
})
export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(), jobId: text('job_id'), kind: text('kind').notNull(), status: text('status').notNull(), step: text('step').notNull(), preset: text('preset'), promptVersions: text('prompt_versions').notNull(), usage: text('usage'), costEstimate: real('cost_estimate'), error: text('error'), startedAt: text('started_at'), finishedAt: text('finished_at'), createdAt: text('created_at').notNull(),
})
export const tailored = sqliteTable('tailored', {
  id: text('id').primaryKey(), jobId: text('job_id').notNull(), runId: text('run_id').notNull(), snapshotHash: text('snapshot_hash').notNull(), document: text('document').notNull(), createdAt: text('created_at').notNull(),
})
export const applications = sqliteTable('applications', {
  id: text('id').primaryKey(), jobId: text('job_id').notNull(), status: text('status').notNull(), appliedAt: text('applied_at'), notes: text('notes').notNull(), submittedText: text('submitted_text'),
})
export const statusEvents = sqliteTable('status_events', {
  id: text('id').primaryKey(), applicationId: text('application_id').notNull(), status: text('status').notNull(), createdAt: text('created_at').notNull(),
})
export const jobAnswers = sqliteTable('job_answers', {
  id: text('id').primaryKey(), jobId: text('job_id').notNull(), question: text('question').notNull(), answer: text('answer').notNull(), createdAt: text('created_at').notNull(), updatedAt: text('updated_at'), category: text('category').notNull(), charLimit: integer('char_limit'), submittedAnswer: text('submitted_answer'), submittedAt: text('submitted_at'), reusedFrom: text('reused_from'),
})
export const artifacts = sqliteTable('artifacts', {
  id: text('id').primaryKey(), jobId: text('job_id').notNull(), runId: text('run_id'), filePath: text('file_path').notNull(), mediaType: text('media_type').notNull(), parseCheck: text('parse_check'), createdAt: text('created_at').notNull(),
})

# Local server

The Hono API binds to `127.0.0.1` only. It owns SQLite storage, local settings,
provider connection checks, backups, a serial run queue with server-sent events,
job capture (ATS APIs and HTML), the extraction and tailoring pipeline, the review
and export workspace, the master résumé, and application and Q&A tracking. Runtime
data is kept in the user's OS data directory (override with `ROLE_CLINIC_DATA_DIR`
for development and tests). The API never returns the Anthropic key to the browser.

Run `npm run dev:server` from the repository root. See the root README for the full
development workflow.

## Routes

- **Jobs and capture:** `/api/jobs`, `/api/capture/url`, per-job status, answers,
  snapshot download, and `/api/answers/search` for the job workspace.
- **Pipeline:** per-job analysis, cost estimates, extract and tailor runs, run retry,
  and `/api/runs/events` (SSE).
- **Review and export:** `/api/jobs/:id/review` (GET/PUT), review versions, reverify,
  preview and export, plus `/api/jobs/:id/artifacts` and artifact downloads. Review
  writes require the originating tailoring run ID and the expected revision; a stale
  write returns 409. The original tailoring record and master snapshot stay available
  independently of later review edits.
- **Tracker and answers:** `/api/tracker`, tracker preferences and per-job metadata,
  submitted records and PDF/DOCX attachments, the answer library with similarity and
  reuse checks, and filtered XLSX/CSV exports. Follow-up and quiet-day calculations use
  calendar days on this device. No model is involved in any of these.
- **App and maintenance:** `/api/app/status`, `/api/app/welcome` and `/api/app/quit`
  support the first-run and maintenance screens; named database backups can be
  downloaded.

## Lifecycle and backups

The server takes exclusive ownership of its data folder, picks a free loopback port,
writes an instance record, shuts down gracefully, snapshots the database at start-up and
daily, saves a snapshot before any migration, and refuses a database from a newer
version. `maintenance.ts` provides validated full backups and staged, recoverable
restores for the offline launcher. Full backups include settings but leave out the
Anthropic API key unless `--include-api-key` is passed; archives are not encrypted, so
keep them private.

## Models and spending

Model prompts and their version labels live in `src/prompts.ts`; a test locks each
version to a hash of its text. Unusable model output gets one repair attempt. Paid calls
are checked against a per-run and a monthly spending cap, and a local model's context
window is sized from each prompt.

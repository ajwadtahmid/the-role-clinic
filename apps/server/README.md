# Local server

The Hono API binds to `127.0.0.1` only. It owns SQLite storage, local settings,
provider connection checks, backups, a serial run/SSE infrastructure, ATS and
HTML job capture, and application/Q&A tracking. Runtime
data is kept in the user's OS data directory (override with
`ROLE_CLINIC_DATA_DIR` for development and tests). The API never returns the
Anthropic key to the browser.

Run `npm run dev:server` from the repository root. See the root README for the
full development workflow. The API exposes `/api/jobs`, `/api/capture/url`, and
`/api/answers/search` for the Phase 2 workspace, in addition to settings and
backup routes.

Phase 5 adds `/api/jobs/:id/review` (GET/PUT), review versions, reverify, preview,
and export subroutes, plus `/api/jobs/:id/artifacts` and artifact downloads.
Review writes require the originating tailoring run ID and expected revision;
stale writes return 409. Schema v6 adds review drafts, immutable artifact
snapshots, and a submitted-artifact reference. The original tailoring record
and master snapshot remain available independently of later review edits.

Phase 6 adds `/api/tracker`, tracker preferences and per-job metadata, submitted
records and PDF/DOCX attachments, answer-library/similarity/reuse-check routes,
and filtered XLSX/CSV exports. Schema v7 preserves submitted question/category
and JD text alongside the previously frozen answers and résumé artifacts.
Follow-up and quiet-day calculations use calendar days on this device. No model
adapter is involved in tracker, answer reuse, or spreadsheet exports.

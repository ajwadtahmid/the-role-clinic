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

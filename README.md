# The Role Clinic

A local-first workspace for saving jobs, tracking applications, and tailoring résumés from a grounded master résumé.

The local build plan and other reference material live in the gitignored `extra/` folder. Phase 1 provides the initial runnable local app foundation.

The intended public release is a downloadable app that runs on each user's computer. Its local server will bind to `127.0.0.1` and open the user's existing browser. There are no hosted accounts or shared data. Job tracking will work without an AI provider; résumé tailoring will use either the user's Claude API key or an optional local Ollama installation.

## Layout

| Path | Purpose |
| --- | --- |
| `apps/server/` | Local Node API, storage, capture, and exports |
| `apps/web/` | Browser UI |
| `packages/shared/` | Types and validation shared by server and UI |
| `extra/` | Local build plan, references, and AI working files (gitignored) |

Phase 0 feasibility work is complete and documented in `extra/`. Model selection is configurable per AI task; evaluation has not established a best model for every task.

## Run locally

Requires Node.js 22.12 or newer and npm.

```sh
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. The API listens on `127.0.0.1:3000`. Use
`PORT`, `WEB_PORT`, or `ROLE_CLINIC_DATA_DIR` to change the development ports or
data directory. The database, settings, and backups live in the current user's
OS data folder. An Anthropic API key, if configured, is written with
owner-only file permissions and never returned to the browser.

The Settings screen configures providers and models independently for
requirement extraction, eligibility analysis, evidence selection, résumé
drafting, claim verification, and writing review. Local model calls use one
serial queue. Provider checks do not send résumé content. The queue demo only
tests run events and SSE; extraction, tailoring, and the application workflow
belong to later phases.

Useful checks: `npm run typecheck`, `npm test`, and `npm run build`.
To serve the built UI and API from one loopback port, run `npm run build` then
`npm start` (defaults to `http://127.0.0.1:3000`).

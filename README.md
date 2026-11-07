# The Role Clinic

A local-first workspace for saving jobs, tracking applications, and tailoring résumés from a grounded master résumé.

The local build plan and other reference material live in the gitignored `extra/` folder. Capture, tracking, master résumé management, and the extraction/tailoring pipeline are implemented. The saved review workspace includes document preview and DOCX/PDF exports. Phase 6 adds a tracker table, follow-ups, submitted-version records, an answer library, and XLSX/CSV exports. Live-model quality evaluation remains deferred until feature work is complete.

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

The Inbox accepts pasted job descriptions or captures supported public job
pages. Jobs can be tracked through application statuses, and per-job Q&A can be
saved, searched, copied, and snapshotted when marked applied. The Settings screen
configures providers and models independently for requirement extraction,
eligibility analysis, evidence selection, résumé drafting, claim verification,
and writing review. Local model calls use one serial queue. Provider checks do
not send résumé content. The queue demo tests run events and SSE. Saved jobs can extract requirements and generate cited drafts after you configure a model and add master evidence.

Useful checks: `npm run typecheck`, `npm test`, and `npm run build`.
To serve the built UI and API from one loopback port, run `npm run build` then
`npm start` (defaults to `http://127.0.0.1:3000`).

## Review and export

Open a job with a generated draft to review it. Accept, reject, or edit individual
lines; only accepted lines enter the document. Source citations, revisioned master
evidence, factual warnings, and writing flags remain visible. Rejecting a line
offers unused source bullets from the same role or project. On a focused card,
use A/R/E/C to accept, reject, edit, or copy.

Edits save locally, run deterministic checks immediately, and queue semantic
verification using the configured claim verifier and spending guard. The screen
shows an estimated verification cost. A failed model call leaves edits intact.
Unsupported model wording blocks export; accepted user wording keeps warnings
visible and can be exported after your review. True new claims can be explicitly
added to the master as new evidence bullets.

The interactive preview follows accepted content; **View rendered PDF** shows the
actual output. The page meter is measured from that PDF. DOCX uses embedded Roboto
fonts and the same content/order; pagination can vary between document editors.
Every export is parsed back to check the presence and order of all headings and
lines. Successful exports are saved locally with their exact review snapshot.

The profile/Q&A drawer supplies plain-text copy controls. Exporting does not mark
an application submitted. In **Export history & mark as applied**, choose the file
you actually sent and confirm it; the app freezes that version's text and the
current answers. Existing submitted records remain unchanged by subsequent edits.

See [Phase 5 validation](extra/phase5-validation.md) for verification and limits.

## Tracker and answer library

Use **Tracker** for the application table, company/status/date filters, follow-up
dates, contacts, notes, and submitted versions. Due reminders appear in the
**Needs follow-up** strip. Marking a follow-up done records today's last-contact
date and clears the reminder. Quiet applications suggest `ghosted` after the
configured interval; statuses change only after your confirmation. The funnel
counts jobs that reached each stage or later across recorded status history.

**Gap trends** uses only the latest tailored draft per tracked job, counting each
job once per recorded evidence gap. It does not run a model or reassess skills.

**Answers** searches working questions/answers by text or category, shows the
source company, role, date and application outcome, and supports editing or
adapting an answer into another saved job. The same editor appears beside job
Q&A and in the review drawer. Categories are suggested by keyword rules and
remain editable. Similar-answer suggestions prefer matching categories, then
text matches. Reused answers preserve their source link and flag references to
other captured companies; character limits remain enforced.

From the tracker, **XLSX** exports Applications and Q&A worksheets; CSV links
export each separately. Exports follow the current filters. The submitted-answer
column uses the frozen answer for applied jobs, including an empty value for
answers added only after submission. A separate column preserves the working
answer. Very long fields that exceed XLSX's cell limit can be exported in CSV.

Validation notes remain local in [extra/phase6-validation.md](extra/phase6-validation.md).

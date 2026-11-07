# The Role Clinic

A local-first job search workspace. Save a job, check it against your profile, tailor a
résumé from a master résumé you control, export it, and keep a record of exactly what you
sent. Everything runs on your own computer: no accounts, no hosted service, no shared data.

## Status

**Pre-release.** The current desktop preview is `0.5.0`; the first public release is
planned as `1.0.0`.

| Area | State |
| --- | --- |
| Job capture, Jobs list, tracker (with answers and answer library) | Working |
| Master résumé, profile, tailoring pipeline, review workspace, DOCX/PDF export | Working |
| Linux x86_64 package (bundled Node runtime, launcher, backup/restore) | Working preview |
| Linux Tauri desktop window, native downloads/clipboard, PDF proof | Implemented; owner acceptance pending |
| macOS Apple Silicon and Windows x64 desktop packages | Native packaging and CI implemented; native builds/acceptance pending |
| AI output quality | Initial local-model validation recorded; quality fixes and release qualification deferred to Phase 10 |
| Desktop workflow checks | Automated Linux webview checks; owner visual/scaling review remains open |

Job tracking and application answers work with no AI provider at all. Résumé tailoring
needs either your own Anthropic API key or a local Ollama installation.

## What it does

1. **Capture** a job by pasting its description or fetching a public posting
   (Greenhouse, Lever, Ashby, SmartRecruiters, Workday, JSON-LD pages, other readable
   pages). LinkedIn, Indeed and Glassdoor are not fetched; paste those. The original page
   is kept next to the cleaned text. Duplicates are caught by URL and by similar
   company and title in the last 60 days.
2. **Triage** on the Jobs screen, with one main button for each job's next step and a status
   strip for fit checks and tailoring runs. When a model is configured, requirements are extracted, each
   tied to an exact span of the posting, and knockouts (years, work authorization,
   education, location) are compared with your private profile and master résumé. They
   are warnings with their basis shown, never blocks.
3. **Tailor** from your master résumé: bullets are ranked, gaps reported, and a draft
   written in which every line cites the source bullets it came from.
4. **Review** each line (accept, reject, edit, copy), see an interactive preview and the
   real PDF with a page meter, and export DOCX or PDF.
5. **Track** the job from the moment you commit to it: the application, the exact file you
   sent, and the questions and answers for it (opened from the tracker), and reuse those
   answers later. A short welcome walkthrough covers first-time setup and can be shown
   again from Settings.

## Privacy

- The server listens on `127.0.0.1` only, rejects requests for any other host, and checks
  the origin of every change.
- Your profile (contact details, work authorization) and your application answers are used
  in local checks and inserted into documents. They are never sent to a model.
- With Claude, the relevant master-résumé evidence and job text are sent to Anthropic and
  billed to your key. With Ollama, model processing stays on your computer.
- Your API key uses owner-only POSIX permissions or a current-account Windows DACL, is never returned to the
  browser, and is left out of full backups unless you ask for it.
- Merely launching the app makes no model or API call.

Desktop builds target Linux x86_64 (AppImage/DEB/RPM), macOS Apple Silicon (DMG/app)
and Windows x64 (per-user setup EXE with WebView2 provisioning). macOS and Windows
still need native CI results and clean-machine workflow checks. See
[installation and build guidance](packaging/DESKTOP.md) and the
[acceptance checklist](packaging/DESKTOP-ACCEPTANCE.md). No public release or automatic updater is configured.

## Run from source

Requires Node.js 22.12 or newer (the package build pins 24.18.1, see `.node-version`) and npm.

```sh
npm install
npm run dev
```

Open `http://127.0.0.1:5173`; the API listens on `127.0.0.1:3000`. `PORT`, `WEB_PORT` and
`ROLE_CLINIC_DATA_DIR` change the ports and the data folder (use a temporary folder for
experiments). By default data lives in your OS's per-user data folder, apart from the app.

```sh
npm run typecheck   # types
npm test            # all tests, no network, no real models
npm run build       # typecheck, build the guide and the UI
npm start           # serve the built UI and API on one port, http://127.0.0.1:3000
```

## AI providers and spending

**Settings** chooses a provider and model separately for each task: requirement
extraction, evidence selection (bullet scoring), résumé drafting, claim verification and
writing review. Eligibility checks are local rules, not a model. A local Ollama model and
Claude can be mixed. Local calls run one at a time, and the previous model is unloaded
before a different one starts.

- Model output is treated as untrusted: it is parsed and validated, and if it is unusable
  the model gets one repair attempt that shows it what was wrong.
- For Ollama, the context window is sized from each prompt (up to 32,768 tokens). A prompt
  that would not fit is refused instead of being silently truncated.
- Claude steps need you to enter current prices. Before queuing, the app shows an
  estimate and refuses a run above the **per-run cap** (default $1) or one that would pass
  the **monthly cap** (default $20, summed from recorded runs). Anthropic input is
  token-counted before each paid call. Local models are never blocked by a cap.
- Every prompt has a version label recorded with each run; a test fails if a prompt's
  wording changes without a new version.

## Review and export

Open a job with a draft to review it. On a focused card, **A / R / E / C** accept, reject,
edit or copy. Only accepted lines enter the document; rejecting a line offers unused
bullets from the same role or project.

- **Checks.** Edits are saved locally and checked immediately for changed numbers and
  dates, tools or companies with no cited evidence, and project work presented as
  employment. A semantic check by the configured verifier is queued and shows its
  estimated cost. A failed model call leaves your edits intact.
- **What blocks export.** Model-written text marked unsupported. Your own edits keep their
  warnings visible and can be exported after your review; a genuinely new claim can be
  added to the master as a new evidence bullet.
- **Preview and files.** The interactive preview follows accepted content; **View rendered
  PDF** shows the real output and drives the page meter. DOCX embeds Roboto; pagination
  can differ between editors. Every export is read back to confirm every heading and line
  is present and in order, then saved with its exact review snapshot.
- **Mark as applied.** Choose the file you actually sent and confirm it. The app freezes
  that file's text, the job description and the current answers. Later edits change the
  working copy only.

## Tracker and answer library

- **Tracker:** filters by company, status and date; follow-up dates, contacts and notes;
  **Needs follow-up** reminders (one click records today as the last contact); quiet
  applications suggest `ghosted` after a configurable number of days and change only when
  you confirm; a funnel across recorded status history; and a view of the exact version
  sent. Spreadsheet export: XLSX (Applications and Q&A sheets) or separate CSV files,
  following the current filters.
- **Gap trends:** skills that keep showing up as evidence gaps, from the latest draft of
  each tracked job. It runs no model.
- **Answers:** each tracked job's questions and answers open from the Q&A column of the
  tracker. An answer library on the same page searches every saved answer by text or
  category, with similar past answers and their outcomes, explicit reuse links, a warning
  when a reused answer names a different company, and enforced character limits.

## Desktop preview

The Tauri preview wraps the existing UI and bundled Node backend. Linux `.deb` and `.rpm`
packages register an application-menu entry; an `.AppImage` provides a portable
alternative. Ordinary users do not need Node, Rust, npm or a developer setup.
Closing the desktop window stops its backend, active runs require confirmation, exports
use native Save dialogs, and the exact PDF proof renders inside the app.

See [desktop installation, building and validation](packaging/DESKTOP.md). The Linux
owner acceptance gate is still open; the browser launcher remains the default fallback.
The preview is unsigned and has no automatic updater. macOS/Windows qualification is
Phase 9; AI quality work remains deferred to Phase 10.

## Linux x86_64 browser package

A self-contained preview: bundled Node runtime and production dependencies, an executable
launcher, a first-run introduction, a local user guide, an optional application-menu
shortcut, and full-data backup and restore. macOS, Windows, ARM and musl are not
included.

```sh
npm ci --ignore-scripts
npm test
npm run build
npm run package:linux
npm run test:package -- dist/the-role-clinic-0.5.0-linux-x64.tar.gz
```

Needs Node 24.18.1, `tar` and `readelf` on Linux x86_64. The archive and its checksum
appear in the ignored `dist/`. Only the locked production dependencies, compiled code, the
built UI, the runtime and the guide are packaged; the manifest lists every file with its
checksum.

Extract the archive and run `./role-clinic`. It reopens a running instance or starts a
loopback server on a free port and opens your browser. `./role-clinic stop` stops it;
closing the tab leaves it running. Your data stays in the per-user data folder, so
replacing the app folder keeps it.

**Compatibility:** Linux x86_64 with glibc 2.34+ and GLIBCXX 3.4.29+. When the preview was
built it was smoke-tested on Fedora 44 and in a clean Ubuntu 22.04 container with no
network, no system Node and no developer tools.

**Backups.** The server saves a database snapshot before any migration, at startup and
daily (14 automatic snapshots are kept), and refuses a database from a newer version.
`./role-clinic backup /path/data.tar.gz` makes a full backup (database, exported files,
attachments, settings, first-run state) with the app stopped; the Anthropic key is left
out unless you add `--include-api-key`. `./role-clinic restore` validates paths,
checksums, settings and database integrity before replacing anything, and keeps the
previous folder for recovery. See [the user guide](packaging/USER-GUIDE.md) for launch,
update, backup, restore and removal.

## Layout

| Path | Purpose |
| --- | --- |
| `apps/server/` | Local Node API (Hono), SQLite storage, capture, pipeline, exports |
| `apps/web/` | Browser UI (Vite and React) |
| `packages/shared/` | Schemas and types shared by server and UI |
| `packaging/`, `scripts/` | Linux launcher, user guide, package build and smoke test |
| `src-tauri/` | Desktop shell, platform package configs, owned backend lifecycle and restricted native commands |

## Roadmap

1. **Tauri on Linux x86_64:** complete owner acceptance of the desktop preview and
   its lifecycle, PDF preview, import/export, clipboard and data compatibility.
2. **Tauri on Linux, macOS and Windows:** installers, signing, updates, recovery, and
   clean-machine checks on all three.
3. **AI quality evaluation and release:** score real models and per-task defaults in the
   finished app, then the platform release checks, ending in version `1.0.0`.

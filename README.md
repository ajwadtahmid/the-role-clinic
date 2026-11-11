# The Role Clinic

A local-first job search workspace. Keep track of the jobs you apply to, and, if you want
to, check how well you fit each one and tailor a résumé from facts you control.
Everything runs on your own computer: no accounts, no hosted service, no shared data.

## Features

- **Job tracker.** Save a job with just a company and a title, or paste its description or
  fetch a public posting. Mark it applied in one click, set follow-up dates, keep contacts
  and notes, and see a funnel of where your applications stand. Export to XLSX or CSV.
- **Answer library.** Record the questions an application asked and the answers you gave,
  then search and reuse them later.
- **Fit check** (optional). Reads a job's requirements, compares them with your master
  résumé and shows what is covered, what is a gap and what needs a look from you.
  Location, work authorization and similar conditions are flagged, never used to block.
- **Résumé tailoring** (optional). Writes a draft from your master résumé in which every
  line cites the bullets it came from. You accept, edit, reject or copy each line, then
  export DOCX or PDF. The exact file you send is kept with the application.
- **Job feed** (optional). Reads a CSV file that a separate search tool fills, and holds
  new rows for you to decide on. See [Finding jobs](#finding-jobs-optional).

You can use the app only as a tracker and never set up AI. The fit check and tailoring are
turned on separately, and can be hidden again at any time without deleting anything.

## Install

**Desktop app.** Download the package for your system from the Releases page. There is no macOS build yet.

| System | Package |
| --- | --- |
| Linux x86_64 | `.AppImage` |
| Windows x64 | setup `.exe` |

The builds are not code-signed, so your operating system may show a warning the first
time you open the app. On Linux, allow the AppImage to run (file Properties → Permissions)
and double-click it; it needs WebKitGTK 4.1 and FUSE 2, which some systems do not install
by default. If it will not start, use the browser package below. More detail is in
[packaging/DESKTOP.md](packaging/DESKTOP.md).

**Linux browser package.** A `.tar.gz` that bundles its own Node runtime and opens in your
browser, so it also works where the AppImage will not. Extract it, then run
`./role-clinic`. `./role-clinic stop` stops it. It needs a 64-bit Linux with glibc 2.34 or
newer (Ubuntu 22.04, Fedora 36 and later) and nothing else installed.

**From source.** Requires Node.js 22.12 or newer and npm.

```sh
git clone https://github.com/ajwadtahmid/the-role-clinic.git
cd the-role-clinic
npm install
npm run build
npm start
```

Open `http://127.0.0.1:3000`. For development, `npm run dev` serves the UI on
`http://127.0.0.1:5173` and the API on `127.0.0.1:3000`.

## Getting started

The first time you open the app it asks how you want to use it:

- **Just track my applications.** Nothing else to set up. The fit check and résumé pages
  are hidden, so the app stays small.
- **Also tailor résumés with AI.** Opens a short guided setup (below).

You can change your mind later in **Settings → AI features**.

### Tracking jobs

1. On **Jobs**, choose **Add job**. A company and a title are enough. Add the description
   now, or later when you open the job.
2. Choose **Save and add another** to enter several in a row, or tick **I already applied
   to this job** if you are catching up on past applications.
3. Press **Mark as applied** on a job when you apply. It is one click, and **Undo** puts it
   back. The job description is kept with the application, so you still have it after the
   posting disappears.
4. Open **Tracker** to filter by company, status or date, add follow-up dates, contacts
   and notes, and export a spreadsheet. Quiet applications can be marked as ghosted after
   a number of days you choose.

LinkedIn, Indeed and Glassdoor pages are not fetched. Paste their text instead. Other
postings can be fetched from a link.

### Turning on AI features

Fit checks and tailoring run on a model on your own computer, through
[Ollama](https://ollama.com). **Settings → AI features → Set up AI features** walks you
through three steps and tells you what is wrong at each one:

1. Install Ollama and open it.
2. Download the model: `ollama pull gemma4:12b`.
3. Run a quick test. AI features turn on only after it passes.

Then import your résumé in **Résumé → Master résumé**, review what was read, and keep only
what is true. Add the private details used for knockout checks and for filling documents in
**Résumé → Profile**.

As an advanced alternative, **Settings → AI features → Advanced** lets you use your own
Anthropic API key instead. Claude runs on Anthropic's servers, costs money and sends the
job text and your résumé bullets to Anthropic. You set per-run and monthly spending limits,
and the app shows an estimate before every paid run.

### Checking fit and tailoring

On a job with a description, **Check fit** lists the requirements found in the posting,
each tied to an exact passage, and shows which your résumé covers. Fit is scored from the
required skills and responsibilities, with preferred ones counting for less. Checks run one
at a time on your computer, and **Check fits** on the Jobs page checks several jobs in a
row.

**Tailor résumé** writes a draft. On each line, press **A** to accept, **R** to reject,
**E** to edit or **C** to copy it. Only accepted lines enter the document. Edits are checked
at once for changed numbers and dates, and for tools or companies the cited bullets do not
support. Export to DOCX or PDF; each export is read back to confirm every line is present
and in order. When you apply, choose the file you actually sent, or record that you used
your master résumé.

### Finding jobs (optional)

The app never searches for jobs. `job-search/` holds instructions for an AI coding agent
that does. Start Claude Code or Codex inside that folder and say `run initial scan` or
`run update`:

1. Copy `job-search/profile.example.md` to `job-search/profile.md` and fill it in.
2. Put your résumé in `job-search/` as `resume.pdf` (or any `resume.*`).
3. `cd job-search`, start `claude` or `codex`, and say `run initial scan`.

The agent saves its results to `job-search/data/jobs.csv` inside the app's data folder
(shown in Settings), which the app reads on its own. The new rows wait in **Jobs** behind an
**Only from the job feed** filter until you track, skip or tailor them. Your profile and
résumé stay in `job-search/` and are ignored by git.

## Privacy

- The server listens on `127.0.0.1` only, refuses requests for any other host, and checks
  the origin of every change.
- Your profile (contact details, work authorization) and your application answers are never
  sent to a model. They are used in local checks and inserted into documents.
- With Ollama, model work stays on your computer. With Claude, the job text and the relevant
  résumé bullets are sent to Anthropic and billed to your key.
- Your API key is stored with owner-only permissions, is never returned to the browser, and
  is left out of full backups unless you ask for it.
- Merely launching the app makes no model or API call. The only outgoing requests are the
  ones you ask for, such as fetching a posting from a link.

## Your data and backups

Data lives in your system's per-user data folder, apart from the app, so replacing or
removing the app keeps it. **Settings** shows the folder. Set `ROLE_CLINIC_DATA_DIR` to use
another.

A copy of the database is made automatically once a day (the last 14 are kept) and before
any upgrade. **Settings** downloads one on demand. For a complete backup (database, exported
files, attachments and settings), stop the app and run
`./role-clinic backup /path/data.tar.gz`; `./role-clinic restore` brings it back after
checking it. See the [user guide](packaging/USER-GUIDE.md) for backup, restore, update and
removal. **Settings → Clear data** erases everything in the data folder after two
confirmations and cannot be undone.

## Development

```sh
npm install
npm run dev         # server and UI with reload
npm run typecheck   # types
npm test            # all tests, no network and no real models
npm run build       # typecheck, build the guide and the UI
npm start           # serve the built app on one port
npm run preflight   # every check CI runs that can run here; add -- --desktop for the Linux AppImage in Docker
```

Use a temporary `ROLE_CLINIC_DATA_DIR` for experiments so your real data is not touched. The
`npm run package:linux`, `npm run test:package` and `npm run desktop:build` scripts build and
check the Linux package and the desktop app (the desktop build also needs the Rust
toolchain).

| Path | Purpose |
| --- | --- |
| `apps/server/` | Local Node API (Hono), SQLite storage, capture, pipeline, exports |
| `apps/web/` | Browser UI (Vite and React) |
| `packages/shared/` | Schemas and types shared by the server and the UI |
| `packaging/`, `scripts/` | Launcher, user guide, package and desktop builds |
| `src-tauri/` | Tauri desktop shell |
| `job-search/` | Instructions and profile template for the optional job search agent |

## License

[GNU General Public License v3.0](LICENSE).

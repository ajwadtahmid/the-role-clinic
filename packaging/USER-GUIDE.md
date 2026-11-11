# The Role Clinic — user guide

The Role Clinic keeps track of the jobs you apply to. If you want, it can also check how
well you fit a job and help you tailor a résumé for it. Everything stays on your own
computer. Nothing is uploaded, and you need no account.

This part of the guide is about using the app. Installation details, backups, command-line
options and other technical topics are in the [Advanced](#advanced) section at the end.

## Getting started

Install the app for your system and open **The Role Clinic**. On Linux, use the `.AppImage`
(or the `.tar.gz` browser version if it will not start). On Windows, run the setup file. If your system warns you the first time
you open it, that is because the app is not code-signed; follow the system's prompts. The
[Advanced](#desktop) section has every detail, including the browser version for Linux.

The first screen asks how you want to use the app:

- **Just track my applications.** Nothing else to set up. This is all you need if you only
  want to keep a list of your applications. The fit check and résumé pages stay out of
  the way.
- **Also tailor résumés with AI.** Takes you to a short setup, explained in
  [Using AI features](#using).

You can change your mind at any time in **Settings → AI features**.

## Adding jobs

On **Jobs**, choose **Add job**.

- A company and a title are enough. Add the description now, or later when you open the
  job.
- To keep the description, paste it, or fetch it from a link to a public posting.
  LinkedIn, Indeed and Glassdoor pages cannot be fetched, so paste their text instead.
- **Save and add another** keeps the form open so you can enter several jobs in a row.
- Tick **I already applied to this job** to record a job you applied to earlier.

The app warns you if a job looks like one you already saved.

## Tracking your applications

When you apply, open the job and press **Mark as applied**. It takes one click, and
**Undo** puts the job back if you pressed it by mistake. The job description is saved with
the application, so you still have it after the posting is taken down.

Open **Tracker** to see everything you have applied to. There you can:

- Filter by company, status or date.
- Set a follow-up date, and add contacts and notes. **Needs follow-up** reminds you of the
  ones that are due, and one click records that you followed up today.
- Move an application along as it progresses, for example to interviewing or rejected.
  Applications that have been quiet for a while are suggested as ghosted; nothing changes
  until you confirm.
- Keep the questions an application asked and your answers. Open them from the Q&A column.
  The answer library on the same page lets you search every answer you have written and
  reuse one later.
- Download a spreadsheet (XLSX or CSV) of what you see.

## Using AI features

These are optional. Without them the app works fully as a tracker.

**Turn them on.** Go to **Settings → AI features → Set up AI features**. The app runs the
AI on your own computer using a free program called Ollama, so your résumé and the jobs
never leave it. The setup has three short steps and tells you what is wrong if one fails:

1. Install Ollama from ollama.com and open it.
2. Download the model by running `ollama pull gemma4:12b` in a terminal. It is downloaded
   once and can take a while.
3. Run a quick test. AI features turn on only after the test passes.

You can stop at any step and come back later. If you would rather use Anthropic's Claude,
see [Claude as an alternative](#claude).

**Add your résumé.** Open **Résumé** and import your résumé as a PDF or Word file. Check
what the app read, and keep only what is true: it only ever writes from what you keep here.
Your private details (contact information, work authorization) go in **Profile**. They
are filled into documents but never given to the AI.

**Check fit.** Open a job that has a description and choose **Check fit**. The app lists
what the job asks for, shows what your résumé covers and what it does not, and gives a
fit percentage. The required skills and duties count most; "nice to have" items count for
less. Things it cannot judge, such as location or work authorization, are flagged for
you to look at but never block you. **Check fits** on the Jobs page checks several jobs one
after another.

**Tailor a résumé.** Choose **Tailor résumé** on a job. The app writes a draft in which
every line points to the part of your résumé it came from. Go through the lines in the
review page: **A** accepts, **R** rejects, **E** edits and **C** copies a line. Only
accepted lines go into the résumé. You can also click a line in the preview to copy it.
Switch the preview to **PDF page** to see the real page, then export a Word or PDF file.

**When you apply,** choose the file you actually sent so the app keeps an exact copy. If
you used your master résumé without saving a file, choose **No file: I used my master
résumé**.

**Hide it again.** **Settings → AI features → Hide AI features** takes the AI parts off
the screen without deleting anything. **Show AI features** brings them back.

## Claude as an alternative

Claude is a paid service run by Anthropic, and it is separate from the free local setup.
In **Settings → AI features**, open **Advanced: use your own Claude key**, then save your
key. Be aware that:

- The job text and the résumé bullets you keep are sent to Anthropic. Your contact details
  and answers never are.
- It costs money. You set a limit per run and a monthly limit, and the app shows an
  estimate before each paid run.

Saving a key does not turn AI features on by itself. Use **Turn on AI features with
Claude** when you are ready. More details are in [Advanced](#privacy).

## Finding jobs automatically

The app does not search for jobs. If you use an AI coding tool such as Claude Code or
Codex to find them, the repository's `job-search` folder has instructions for it. The
jobs it finds appear in **Jobs** under **To review**, behind an **Only from the job feed**
filter, and nothing is tracked until you decide: **Save**, **Skip**, **I applied**, or start
tailoring. Details are in [Advanced](#job-feed).

## Keeping your data safe

Your data is stored on your computer, outside the app, so updating or removing the app
does not delete it. **Settings** shows where. The app saves a copy of your database every
day, and **Settings** can download one for you. To move to a new computer or keep a
complete backup, see [Backups](#backups) in the Advanced section.

To start over, **Settings → Clear data** deletes everything in the data folder: your jobs,
tracker, résumé, answers, exported files, settings and the backups kept there. It asks twice
(you type DELETE the second time), and it cannot be undone, so download a backup first if you
might want anything back. Files from the job search tool are left alone.

## Common questions

**The Fit check and Résumé pages are missing.** AI features are off or hidden. Turn them
on or show them in **Settings → AI features**.

**The setup says Ollama was not found.** Install it from ollama.com and open it, then
choose **Check again**. Tracking keeps working in the meantime.

**A job is not fetched from its link.** Some sites cannot be fetched. Open the posting,
copy its text and paste it into the job.

**I pressed Mark as applied by mistake.** Press **Undo** right away. Later, change the
status on the Tracker.

**Can I use it on two computers?** The data lives on each computer separately. Make a
full backup on one and restore it on the other; see [Backups](#backups).

For anything else, look in [Troubleshooting](#troubleshooting).

## Advanced

Everything below is technical detail: installing and launching, the command line, the
data folder, backups and restoring, updates, the job feed file format and how models are
used. You do not need any of it to use the app day to day.

### Desktop app

The desktop app opens the workspace in its own window. On Linux, use the
`.AppImage`: allow execution in file Properties → Permissions, then double-click it.
It needs WebKitGTK 4.1, FUSE 2 compatibility support and a desktop session.
Without FUSE, run the file with `--appimage-extract`, then open `squashfs-root/AppRun`.
Keep that extracted folder together. Windows builds use a per-user setup EXE and a Start
menu shortcut, with WebView2 installation handled by the installer. Windows targets Windows 11 x64. There is no macOS
build yet, and Windows ARM is not supported. The builds are not code-signed, so your system may warn
you the first time you open the app. Follow the system's prompts; do not disable its protection.

Closing the desktop window or pressing **Ctrl+Q** stops its local backend. An active
run prompts before interruption; choose **Keep working** to continue it. A second
launch focuses the existing window. Stop an existing browser instance before opening
the desktop app with the same data folder.

Exports open a native Save dialog; canceling it leaves the recorded export intact.
PDF proof renders inside the app. Posting and guide links open in your default browser.
Data and backups use the same locations and formats as the browser package.

For the full-backup and restore commands below, the Linux desktop maintenance launcher is
inside the extracted AppImage, at
`squashfs-root/usr/libexec/the-role-clinic/backend/role-clinic` (run the AppImage once with
`--appimage-extract` to get that folder). On Windows it is `backend\role-clinic.cmd` inside
the installation folder. Quote paths with spaces and close the app before running
maintenance. Use those launchers for all maintenance commands below. In PowerShell, prefix a quoted launcher path with `&`.
Normal desktop use needs no terminal.

### Browser package: download and launch

1. Check the archive with `sha256sum -c <archive>.sha256` in its download folder.
2. Extract the `.tar.gz` into a folder you own. Keep the extracted files together.
3. Open a terminal in that folder and run `./role-clinic`.
4. The launcher starts a loopback server and opens your default browser. If opening
   the browser fails, copy the printed `http://127.0.0.1:<port>` URL into it.

Node, npm, SQLite, Docker and a developer toolchain are **not needed to run the
package**. Node and required libraries are bundled. Your desktop's `xdg-open`
command opens the browser when available. Use a current Firefox or Chromium-family browser.
Ollama and model downloads are optional and are not bundled or installed.

`./role-clinic start --no-browser` prints the URL without opening a browser.
Launching again reopens the existing instance. The default chooses an available
port; an explicit `PORT` environment variable requests a particular port and
fails visibly if occupied. The app listens only on `127.0.0.1`.

For an optional application-menu shortcut, run `./role-clinic install-desktop`.
Run `./role-clinic uninstall-desktop` to remove it. Reinstall the shortcut after
moving the extracted app folder. No autostart or system-wide installation is added.

### Stop and reopen

For the desktop app, close its window, press **Ctrl+Q**, or choose **Settings →
Quit app**. Reopen it from the application menu or AppImage. The following commands
apply to the browser package and the desktop maintenance launcher.

Closing the browser tab leaves the local server running. Use **Settings → Stop
local app**, or run `./role-clinic stop`. Active model runs block an ordinary stop;
wait for completion, or explicitly use `./role-clinic stop --force`. An interrupted
run is recorded as failed on restart and can be retried where supported.

`./role-clinic status` reports the running version and port. Reopen with the launcher.

### Data location

On Linux, data is in `$XDG_DATA_HOME/the-role-clinic` or
`~/.local/share/the-role-clinic`; on Windows it is in
`%APPDATA%\The Role Clinic`. `ROLE_CLINIC_DATA_DIR=/absolute/path` overrides
it. Use the same override for every launch, backup and restore command. Settings
shows the actual folder, and the launcher's `data-dir` command prints it on any system.
Data is outside the replaceable package.

`role-clinic.sqlite` stores jobs, answers and résumé records; `artifacts/` holds exported
and attached files; `settings.json` may contain your API key with owner-only POSIX
permissions or a current-account Windows DACL; `backups/` holds database snapshots. `app.log` records server errors.
Do not sync or copy a live SQLite/WAL file as your backup.

### Backups

**Full backup (recommended for recovery and moving computers):** stop the app first,
then run `./role-clinic backup /absolute/path/role-clinic-data.tar.gz`. The archive
includes a consistent database snapshot, recorded artifacts, settings and first-run
state. Your Anthropic API key is **left out** by default, so enter it again in
Settings after a restore; add `--include-api-key` only if you want it in the archive,
and then keep the archive private. Archives are not encrypted.
The command refuses to overwrite an existing archive or omit missing artifacts.
It has a 2 GiB expanded-data limit. Existing backup history and logs are not included.

**Database snapshots:** the server creates a snapshot at startup and daily, keeping
14 automatic snapshots. Manual and pre-migration snapshots are retained. Settings
can create/download a database snapshot, but it is not a full backup: it excludes
artifact files and settings. Full restore uses the full backup archive format.

### Restore

1. Stop the app. Place the full backup archive **outside** the data folder.
2. Run `./role-clinic restore /absolute/path/role-clinic-data.tar.gz` to validate it
   and inspect its date, file count and schema. This does not replace data.
3. To apply it, repeat with `--confirm`. The entire prior data folder is preserved
   as a sibling `the-role-clinic.before-restore-…` recovery folder. After validation,
   the restored folder replaces the current one. Artifact paths are relocated to
   the actual restored data directory.
4. Start the app, check jobs, submitted records and files, then retain or manually
   remove the old recovery folder when satisfied.

Archives with invalid paths, links, duplicate entries, missing files, checksum
mismatches, invalid settings or an unsupported database version are rejected.
A checksum protects consistency; it does not prove who created an archive. Restore
only your own or otherwise trusted backups. Keep recovery folders private too.

### Update

Desktop updates are manual: quit and back up first, replace the AppImage or
run the new Windows installer, then reopen and check your saved workspace.
Uninstalling leaves your data folder in place. There is no automatic updater.

For the Linux browser package, stop the running app, make a full backup, extract the new package into a **new**
folder, and launch its `role-clinic`. Keep the old package until the update is
checked. The data directory stays the same. Before a schema upgrade, the app makes
a pre-migration database snapshot; it refuses to open a database from a newer app.
Reinstall the optional desktop shortcut to point to the new folder.

For a rollback after a schema change, keep a copy of current data, use a compatible
app to restore the pre-update full backup, then start the older package. Do not
force an older app to write a newer database or overwrite the data folder manually.

### Job-feed file

A job feed is optional. If a search tool such as Claude Code or Codex saves the jobs it
finds to `job-search/data/jobs.csv` inside your data folder (the folder shown in **Settings**),
Role Clinic reads it automatically as soon as the file exists. To use a different file, set its
full path in **Settings → Job feed**. The Jobs page then
lists them under **To review**, behind an **Only from the job feed** filter: jobs from the file
that are waiting for your decision. Role Clinic
never searches for jobs. It reads the file when it starts, when you return to the window
(at most every 30 seconds) and when you choose **Check for new jobs**. It also fetches each
full posting in the background; if that fails, the job shows **Summary only**, and a page
that looks closed shows **May be closed**. No model runs during import.

A job leaves To review only when you decide: **Save**, **Skip**, **I applied**,
or start **Tailor résumé**. Opening a job does not move it.

The file needs these columns: `Job Title`, `Company`, `Apply Link` and `Date Found`
(YYYY-MM-DD). Optional columns are `Date Posted`, `Priority`, `Location`, `Work Arrangement`,
`Salary Range`, `Required Qualifications`, `Preferred Qualifications`, `Missing Skills / Flags`,
`Why It Fits` and `Source`. Other columns are left alone. Role Clinic adds one column,
`Imported`, holding the date it imported the row; a search tool should keep it and still
count those rows when it checks for duplicates. Two links are the same job when they match
after lowercasing the host and removing the fragment, a trailing slash and tracking
parameters such as `utm_*`, `gh_src` and `lever-source`; identifying parameters such as
`gh_jid` are kept. The app also remembers every imported link, so a row you delete from the
file is not imported again.

The notes your search tool wrote (priority, flags, why it fits) are shown to you as written
by that tool and are never sent to a model. Application status is kept only in Role Clinic.
**Clean up** in Settings removes imported rows and undecided jobs from the file older than a number of
days you choose, after a preview, using the posted date when there is one and the found date
otherwise. It never touches tracked, applied or skipped jobs, or rows not yet imported.

### Privacy and models

Each task (requirement extraction, evidence selection, résumé drafting, claim
verification, writing review) has its own provider and model in **Settings**. A local
Ollama model and Claude can be mixed. Local calls run one at a time. Claude sends the
relevant résumé evidence and job text to Anthropic and bills your key; Ollama processes
requests on this computer. Your profile, application answers and a job feed's notes are
never part of a model request. Capturing a URL contacts the public job site; launching
the app makes no model or API call.

For Claude, enter the current prices in Settings. The app shows an estimate before a run
and refuses one above the per-run cap (default $1) or one that would pass the monthly
cap (default $20, summed from recorded runs). Local models are never blocked by a cap.
The API key is stored with owner-only permissions, is never returned to the browser, and is
left out of full backups unless you add `--include-api-key`.

### Troubleshooting

- `./role-clinic verify` checks the installed package against its file manifest.
- If launch fails, read `app.log` in the data folder. Errors never require installing
  npm dependencies into the downloaded package. Re-extract the package if damaged.
- A busy explicit port can be resolved by unsetting `PORT` and relaunching. A second
  instance using the same data folder is rejected or reused; stale records are
  handled without killing unrelated processes.
- For a missing Ollama connection, keep using tracking or install/configure Ollama
  separately. The launcher never downloads models or makes paid inference calls.
- To remove the app: stop it, remove the optional desktop shortcut, then delete the
  extracted package. Local data remains. To remove data too, first make any desired
  full backup and then manually delete the exact data folder shown in Settings.

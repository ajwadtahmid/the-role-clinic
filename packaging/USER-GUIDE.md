# The Role Clinic — preview

A local job tracker and résumé workspace. Linux x86_64 has automated package and
native webview checks on Ubuntu 22.04/Fedora 44. macOS Apple Silicon and Windows x64
packages are being implemented; native and clean-machine qualification remain open.
AI quality fixes and public-release qualification remain pending; review generated claims.

## Desktop preview

The 0.5.0 Tauri preview opens the workspace in its own window. On Ubuntu, open the
`.deb` with the software installer; on Fedora, use the `.rpm`. Launch **The Role Clinic**
from your application menu. The installer resolves GTK3, WebKitGTK 4.1 and `xdg-utils`.
An `.AppImage` is also available: allow execution in file Properties → Permissions,
then double-click it. It needs FUSE 2 compatibility support and a desktop session.
Without FUSE, run the file with `--appimage-extract`, then open `squashfs-root/AppRun`.
Keep that extracted folder together. macOS builds use a DMG: drag the app into
Applications, then open it there. Windows builds use a per-user setup EXE and a Start
menu shortcut, with WebView2 installation handled by the installer. These new platforms
are not yet qualified. The Mac runtime requires macOS 13.5+ on Apple Silicon;
Windows qualification targets Windows 11 x64. Intel Mac and Windows ARM are outside
this preview. Public Mac downloads still need Developer ID signing/notarization;
Windows previews are unsigned. Follow OS security checks; do not disable protection.

Closing the desktop window or pressing **Ctrl+Q** (**Command+Q** on Mac) stops its local backend. An active
run prompts before interruption; choose **Keep working** to continue it. A second
launch focuses the existing window. Stop an existing browser preview before opening
the desktop version with the same data folder.

Exports open a native Save dialog; canceling it leaves the recorded export intact.
PDF proof renders inside the app. Posting and guide links open in your default browser.
Data and backups use the same locations and formats as the browser preview.

For full-backup/restore commands below, the Linux desktop maintenance launcher is
`/usr/libexec/the-role-clinic/backend/role-clinic`. For an extracted AppImage it is
`squashfs-root/usr/libexec/the-role-clinic/backend/role-clinic`. Quote these paths with spaces
and close the app before running maintenance. On Mac the launcher is inside
`The Role Clinic.app/Contents/Resources/backend/role-clinic`; on Windows it is
`backend\role-clinic.cmd` inside the installation folder. Use those launchers for
all maintenance commands below. In PowerShell, prefix a quoted launcher path with `&`.
Normal desktop use needs no terminal.

## Browser fallback: download and launch

1. Check the archive with `sha256sum -c <archive>.sha256` in its download folder.
2. Extract the `.tar.gz` into a folder you own. Keep the extracted files together.
3. Open a terminal in that folder and run `./role-clinic`.
4. The launcher starts a loopback server and opens your default browser. If opening
   the browser fails, copy the printed `http://127.0.0.1:<port>` URL into it.

Node, npm, SQLite, Docker and a developer toolchain are **not needed to run the
package**. Node and required libraries are bundled. Your desktop's `xdg-open`
command opens the browser when available. A current Firefox or Chromium-family
browser is the initial browser target; browser visual qualification is pending.
Ollama and model downloads are optional and are not bundled or installed.

`./role-clinic start --no-browser` prints the URL without opening a browser.
Launching again reopens the existing instance. The default chooses an available
port; an explicit `PORT` environment variable requests a particular port and
fails visibly if occupied. The app listens only on `127.0.0.1`.

For an optional application-menu shortcut, run `./role-clinic install-desktop`.
Run `./role-clinic uninstall-desktop` to remove it. Reinstall the shortcut after
moving the extracted app folder. No autostart or system-wide installation is added.

## First use

The first screen is a three-step welcome: add your résumé, choose a model, add
your first job. Each step can be skipped, and you can show it again from
**Settings → Welcome guide**. On **Jobs**, choose **Add job**, then paste a posting or
fetch a supported public URL. Saving jobs, tracking them and recording answers work
without a model or API key. The first-run state is saved locally.

For optional tailoring: import a PDF/DOCX in **Résumé → Master résumé**, review the draft,
and save only true evidence. Fill in your private profile separately. Configure
an installed local Ollama model or your own Anthropic API key in **Settings**.
Claude sends relevant résumé evidence and job text to its API and charges you;
Ollama processes model requests locally. Private profile and application answers
stay outside model inputs. Capturing a URL contacts the public job site.

On **Jobs**, each posting has one main button for its next step: **Check fit**,
**Tailor résumé** (which also adds the job to the Tracker), **Review and export**,
**Mark as applied**, then **Open in Tracker**. **Track this job**, **Already applied** and
**Skip** are always available for a job you have not decided about. A strip under the job header shows whether a fit check or tailoring
run is waiting, running, finished or failed, and a notice appears on any page when one
ends. Review generated lines, accept/edit/reject them, and export DOCX or PDF. Record
what you actually submitted using the explicit application confirmation; if you applied
with your master résumé, choose **No file: I used my master résumé** and the application
is recorded as **No résumé file recorded**. The **Tracker**
keeps follow-ups, each job's questions and answers (open them from the Q&A column), the
answer library, Gap trends and spreadsheet exports.

## Job-feed file

A job feed is optional. If a search tool such as Claude Code or Codex saves the jobs it
finds to `job-search/data/jobs.csv` inside your data folder (the folder shown in **Settings**),
Role Clinic reads it automatically as soon as the file exists. To use a different file, set its
full path in **Settings → Job feed**. The Jobs page then
shows a **Triage** chip: jobs from the file that are waiting for your decision. Role Clinic
never searches for jobs. It reads the file when it starts, when you return to the window
(at most every 30 seconds) and when you choose **Check for new jobs**. It also fetches each
full posting in the background; if that fails, the job shows **Summary only**, and a page
that looks closed shows **May be closed**. No model runs during import.

A job leaves Triage only when you decide: **Track this job**, **Skip**, **Already applied**,
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
**Clean up** in Settings removes imported rows and undecided Triage jobs older than a number of
days you choose, after a preview, using the posted date when there is one and the found date
otherwise. It never touches tracked, applied or skipped jobs, or rows not yet imported.

## Stop and reopen

For the desktop preview, close its window, press **Ctrl+Q**, or choose **Settings →
Quit app**. Reopen it from the application menu or AppImage. The following commands
apply to the browser fallback and the desktop maintenance launcher.

Closing the browser tab leaves the local server running. Use **Settings → Stop
local app**, or run `./role-clinic stop`. Active model runs block an ordinary stop;
wait for completion, or explicitly use `./role-clinic stop --force`. An interrupted
run is recorded as failed on restart and can be retried where supported.

`./role-clinic status` reports the running version and port. Reopen with the launcher.

## Data location

On Linux, data is in `$XDG_DATA_HOME/the-role-clinic` or
`~/.local/share/the-role-clinic`. On Mac it is in
`~/Library/Application Support/The Role Clinic`; on Windows it is in
`%APPDATA%\The Role Clinic`. `ROLE_CLINIC_DATA_DIR=/absolute/path` overrides
it. Use the same override for every launch, backup and restore command. Settings
shows the actual folder. Data is outside the replaceable package.

`role-clinic.sqlite` stores jobs, answers and résumé records; `artifacts/` holds exported
and attached files; `settings.json` may contain your API key with owner-only POSIX
permissions or a current-account Windows DACL; `backups/` holds database snapshots. `app.log` records server errors.
Do not sync or copy a live SQLite/WAL file as your backup.

## Backups

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

## Restore

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

## Update

Desktop updates are manual: quit and back up first, replace the AppImage/Mac app or
run the new DEB/RPM/Windows installer, then reopen and check your saved workspace.
Uninstalling should leave your data folder in place; native installation, upgrade and
uninstall checks remain required on each advertised platform.
There is no automatic updater.

For the Linux browser archive, stop the running app, make a full backup, extract the new package into a **new**
folder, and launch its `role-clinic`. Keep the old package until the update is
checked. The data directory stays the same. Before a schema upgrade, the app makes
a pre-migration database snapshot; it refuses to open a database from a newer app.
Reinstall the optional desktop shortcut to point to the new folder.

For a rollback after a schema change, keep a copy of current data, use a compatible
app to restore the pre-update full backup, then start the older package. Do not
force an older app to write a newer database or overwrite the data folder manually.

## Troubleshooting and removal

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

Linux x86_64 was smoke-tested on Fedora 44 and in an Ubuntu 22.04 container.
macOS/Windows builds and native CI are configured but have not been validated here.
Native rendering, dialogs, updates, removal and clean-install checks remain open.

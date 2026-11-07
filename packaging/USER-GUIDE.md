# The Role Clinic — Linux preview

A local job tracker and résumé workspace. This preview targets **Linux x86_64
with glibc 2.34 or newer** and the C++ runtime listed in `manifest.json`. It does
not target Alpine/musl, ARM, macOS or Windows. Other platform packages are planned.
Smoke-tested on Fedora 44 and in a clean Ubuntu 22.04.5 LTS container. Full
desktop/browser visual qualification remains open. AI quality fixes and release
qualification remain pending; review all generated résumé claims.

## Desktop preview

The 0.5.0 Tauri preview opens the workspace in its own window. On Ubuntu, open the
`.deb` with the software installer; on Fedora, use the `.rpm`. Launch **The Role Clinic**
from your application menu. The installer resolves GTK3, WebKitGTK 4.1 and `xdg-utils`.
An `.AppImage` is also available: allow execution in file Properties → Permissions,
then double-click it. It needs FUSE 2 compatibility support and a desktop session.
Without FUSE, run the file with `--appimage-extract`, then open `squashfs-root/AppRun`.
Keep that extracted folder together. macOS/Windows packages are planned separately.

Closing the desktop window or pressing **Ctrl+Q** stops its local backend. An active
run prompts before interruption; choose **Keep working** to continue it. A second
launch focuses the existing window. Stop an existing browser preview before opening
the desktop version with the same data folder.

Exports open a native Save dialog; canceling it leaves the recorded export intact.
PDF proof renders inside the app. Posting and guide links open in your default browser.
Data and backups use the same locations and formats as the browser preview.

For full-backup/restore commands below, the installed desktop maintenance launcher is
`/usr/lib/The Role Clinic/backend/role-clinic`. For an extracted AppImage it is
`squashfs-root/usr/lib/The Role Clinic/backend/role-clinic`. Quote these paths with spaces
and close the app before running maintenance. Normal app use needs no terminal.

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
**Track this job**, **Tailor résumé**, **Review and export**, **Mark as applied**, then
**Open in Tracker**. A strip under the job header shows whether a fit check or tailoring
run is waiting, running, finished or failed, and a notice appears on any page when one
ends. Review generated lines, accept/edit/reject them, and export DOCX or PDF. Record
what you actually submitted using the explicit application confirmation. The **Tracker**
keeps follow-ups, each job's questions and answers (open them from the Q&A column), the
answer library, Gap trends and spreadsheet exports.

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

By default, data is in `$XDG_DATA_HOME/the-role-clinic` or
`~/.local/share/the-role-clinic`. `ROLE_CLINIC_DATA_DIR=/absolute/path` overrides
it. Use the same override for every launch, backup and restore command. Settings
shows the actual folder. Data is outside the replaceable package.

`clinic.sqlite` stores jobs, answers and résumé records; `artifacts/` holds exported
and attached files; `settings.json` may contain your API key with owner-only
permissions; `backups/` holds database snapshots. `app.log` records server errors.
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

Stop the running app, make a full backup, extract the new package into a **new**
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

This is a Linux x86_64 preview. It was smoke-tested on Fedora 44 and in a clean
Ubuntu 22.04 container; other distributions have not been tested.

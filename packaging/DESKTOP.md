# Linux desktop preview

Version 0.5.0 is a development preview of the Tauri desktop app for Linux x86_64.
Keep the browser preview available until the owner accepts the Linux build.
macOS/Windows installers, signing and updates are Phase 9. AI quality work is Phase 10.

## Install and open

The build produces three alternatives. Download one from a trusted release location
when releases are published; this repository currently produces local artifacts only.
Verify its SHA-256 checksum before opening it.

| Format | Use |
| --- | --- |
| `.deb` | Ubuntu/Debian: open with the software installer, then launch **The Role Clinic** from the application menu. The installer resolves GTK3, WebKitGTK 4.1 and `xdg-utils` dependencies. |
| `.rpm` | Fedora: open with the software installer, then launch **The Role Clinic** from the application menu. The installer resolves `gtk3`, `webkit2gtk4.1` and `xdg-utils`. |
| `.AppImage` | Portable alternative: in file Properties → Permissions, allow execution, then double-click. Requires a desktop session and FUSE 2 compatibility support; some file managers need **Run** rather than **Open**. |

The shipped Node runtime requires glibc 2.34+ and GLIBCXX 3.4.29+. The app targets
Ubuntu 22.04+ and Fedora 44 x86_64; Alpine/musl and ARM are outside this preview.
No system Node, npm, Rust, SQLite command, Docker or browser is needed for normal use.
Ollama and models are separate, optional installations.

For AppImage systems without FUSE, extract once:

```sh
chmod +x 'The Role Clinic_0.5.0_amd64.AppImage'
'./The Role Clinic_0.5.0_amd64.AppImage' --appimage-extract
./squashfs-root/AppRun
```

Keep the extracted folder together. AppImage mount/double-click behavior still needs
owner testing on a real desktop; automated tests use its extracted launcher.
The `.deb` and `.rpm` are the preferred installed previews because they register a
menu entry and declare system dependencies. No public signed release is available yet.

## Desktop behavior and data

- Opening the app starts its private loopback backend and shows the existing workspace.
  Launching it again focuses the existing window.
- Closing the window, **Ctrl+Q**, or **Settings → Quit app** stops its owned backend.
  An active model run prompts before interruption; **Keep working** leaves it running.
- Exports open a native Save dialog. Canceling it leaves the stored export intact.
  PDF proof is rendered locally from the exact generated PDF, inside the app.
  Individual desktop downloads have a 256 MiB limit; use the maintenance launcher
  for a larger full-data backup.
- Posting and guide links open in the default browser. The app window stays in the
  workspace. Clipboard operations only write text requested by the user.
- A running browser preview must be stopped before opening the desktop app with the
  same data folder. The desktop reports the conflict without stopping that preview.

The existing data location and schema are preserved: `$XDG_DATA_HOME/the-role-clinic`
or `~/.local/share/the-role-clinic`; `ROLE_CLINIC_DATA_DIR` overrides it. A package
upgrade does not move or erase that folder. Do not launch an older app against a
newer database; incompatible schemas are refused. `app.log` records backend diagnostics.

Settings can save a database snapshot. Full backups and restores still use the shipped
maintenance launcher **while the app is closed**, following [the user guide](USER-GUIDE.md#backups).
For `.deb`/`.rpm`, the launcher is `/usr/lib/The Role Clinic/backend/role-clinic`.
For an extracted AppImage it is `squashfs-root/usr/lib/The Role Clinic/backend/role-clinic`.
Quote paths with spaces. For example:

```sh
'/usr/lib/The Role Clinic/backend/role-clinic' backup "$HOME/role-clinic-backup.tar.gz"
'/usr/lib/The Role Clinic/backend/role-clinic' restore "$HOME/role-clinic-backup.tar.gz"
```

Restore first validates and shows a preview; add `--confirm` only to apply it.
The API key is excluded from full backups unless `--include-api-key` is supplied.
Uninstalling the desktop package leaves personal data in place; delete it separately
only when you intend to remove your workspace.

## Build and validate

Use Node from `.node-version`, the Rust toolchain in `rust-toolchain.toml`, and Linux
x86_64 GTK3/WebKitGTK 4.1 development libraries. The build bundles the existing backend
and native SQLite module; it does not rewrite them in Rust.

```sh
npm ci --ignore-scripts
npm test
npm run build
npm run desktop:build
```

Tauri writes packages to `src-tauri/target/release/bundle/` by default. Build on the
oldest supported distribution to avoid raising the system library requirements.
The provided Ubuntu 22.04 container includes the pinned Node/Rust toolchains:

```sh
docker build -f packaging/Dockerfile.desktop-linux -t role-clinic-phase8-build .
mkdir -p dist/cargo-cache dist/desktop-cache
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" \
  -e CARGO_HOME=/work/dist/cargo-cache -e XDG_CACHE_HOME=/work/dist/desktop-cache \
  -e CARGO_TARGET_DIR=/work/dist/desktop-target \
  -e CARGO_BUILD_JOBS=2 role-clinic-phase8-build npm run desktop:build
```

This uses an existing locked `node_modules` install; run `npm ci --ignore-scripts`
first. It needs network access for OS packages, Rust crates and Tauri bundling tools.
`npm run desktop:dev` stages the production UI/backend before opening a development
window; frontend edits require restarting this command. `npm start` remains the browser
preview, so adopting the desktop does not replace the fallback.

The native harness requires an isolated X11/D-Bus session, `WebKitWebDriver`, `xdotool`
and `xclip`. After installing/extracting the Debian package in a disposable environment:

```sh
TAURI_WEBVIEW_AUTOMATION=true dbus-run-session -- xvfb-run -a \
  node scripts/smoke-desktop.mjs
```

It uses temporary synthetic data and removes it afterwards. No model or API calls run.
`scripts/measure-desktop.mjs` compares total app + WebKit + Node process memory and
startup against the same engine's MiniBrowser running the browser preview. It is not an
Electron comparison. Root-only test containers disable WebKit sandboxing through a
test environment variable; ordinary production launch does not disable the sandbox.

The privileged interface has four commands: save an allowlisted application export to
a user-selected path, write clipboard text, open an HTTP(S) link, and quit. The main
window must be at its own backend's exact origin. No generic filesystem, shell, HTTP
or clipboard-read permission is exposed to the frontend. Existing API Host/Origin
checks remain active; desktop responses add a CSP.

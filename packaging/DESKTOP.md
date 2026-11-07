# Desktop packages

The desktop app keeps the React workspace and a bundled local Node backend in a
Tauri window. Version 0.5.0 remains a development preview. Linux has automated native
workflow evidence; macOS/Windows build and install checks are configured but have
not run here. No public release or automatic update service exists yet.

## Choose a download

Each OS/CPU needs its own package. The same workspace, local-data model and backup
format are used across them; a single executable cannot run on all three systems.

| Target | Package | Open it |
| --- | --- | --- |
| Linux x86_64 | `.AppImage`, `.deb`, `.rpm` | AppImage: allow execution in Properties → Permissions, then double-click. Alternatively open the DEB/RPM in your software installer and launch from the application menu. |
| macOS Apple Silicon | `.dmg` containing `.app` | Open the disk image, drag **The Role Clinic** into Applications, eject the image, then open the app from Applications. Native qualification pending. |
| Windows x64 | NSIS `-setup.exe` | Open the installer, install for your account, then open **The Role Clinic** from Start. Native qualification pending. |

Download only a package published by a trusted source and compare its SHA-256 with
`SHA256SUMS`. Development artifacts come from the repository's GitHub Actions runs
or a local build. A GitHub release download channel is intended after qualification;
these workflows upload temporary build artifacts and never publish a release.
Checksums detect damage; unsigned checksums alone do not authenticate a publisher.

No system Node, npm, Rust, SQLite command, Docker or developer toolchain is needed.
Ollama and models are optional separate installations. Basic tracking works without
AI configuration. The Windows installer includes the offline WebView2 installer;
it installs the runtime when needed instead of expecting a developer to install it.
The Evergreen runtime then receives Microsoft's normal updates.

### Platform scope and prerequisites

- Linux targets Ubuntu 22.04+ and Fedora 44 on x86_64 with a desktop session.
  The bundled native binaries require glibc 2.34+ and GLIBCXX 3.4.29+.
  DEB/RPM declare GTK3, WebKitGTK 4.1 and `xdg-utils` dependencies.
- AppImage needs FUSE 2 compatibility support. If unavailable, run it once with
  `--appimage-extract` and open `squashfs-root/AppRun`; keep that folder together.
  Normal FUSE mount/double-click still requires real-desktop acceptance.
- macOS builds target Apple Silicon. The technical minimum is macOS 13.5, imposed
  by the bundled Node 24 runtime; CI targets macOS 15. This does not establish that
  every OS version between them is qualified. Intel/universal Mac builds are not included.
- Windows builds target x64 and will be qualified on Windows 11; Node's technical
  floor is Windows 10. Windows ARM and Windows 10 support are not advertised.
- Public Mac downloads require Developer ID signing and Apple notarization.
  CI uses ad-hoc signatures for development, which do not establish Gatekeeper trust.
  Windows previews are unsigned and may be blocked or warned about by SmartScreen.
  Public Windows signing and clean-machine launch checks remain release gates.
  Do not disable system security settings to test these previews.

## Window, files and data

Opening the desktop app starts its private backend on an available loopback port.
A second launch focuses the existing window. Closing the window quits the app and
its backend on all platforms; there is no tray/background mode. Use **Settings →
Quit app**, **Ctrl+Q** on Linux/Windows, or **Command+Q** on macOS. The Mac menu includes
Quit and standard editing actions. An active run asks before interruption; **Keep
working** leaves it running. Reopen the app to recover saved work after a crash.

Exports use native Save dialogs; canceling preserves the recorded export. PDF proof
renders locally from the generated PDF. Desktop downloads have a 256 MiB limit;
use maintenance for a larger full backup. Posting and guide links open in the default
browser. Clipboard commands only write the text requested by the user.
Stop the browser preview before using the same data folder in the desktop app.

| OS | Default data folder | Maintenance launcher relative to installation |
| --- | --- | --- |
| Linux | `$XDG_DATA_HOME/the-role-clinic` or `~/.local/share/the-role-clinic` | `/usr/libexec/the-role-clinic/backend/role-clinic` (DEB/RPM) |
| macOS | `~/Library/Application Support/The Role Clinic` | `The Role Clinic.app/Contents/Resources/backend/role-clinic` |
| Windows | `%APPDATA%\The Role Clinic` | `backend\role-clinic.cmd` inside the chosen installation folder |

An extracted AppImage's launcher is at
`squashfs-root/usr/libexec/the-role-clinic/backend/role-clinic`.
`ROLE_CLINIC_DATA_DIR` overrides the data folder; use it consistently for launching,
backup and restore. Settings shows the actual folder. Data is outside app files.
API-key settings use owner-only POSIX permissions on Linux/macOS and an explicit
current-account Windows DACL. Other Windows data relies on the private per-user folder's
inherited permissions; avoid shared folders for workspace overrides.

## Update, backup, restore and removal

Updates are manual. Quit the app, make a full backup, then replace the AppImage or
Mac app, or run the newer DEB/RPM/Windows installer. Keep the old package and backup
until records and exports are checked. App versions and schema migrations are
independent: compatible updates reuse data, migrations make a pre-migration database
snapshot, and older apps refuse newer schemas. There is no background updater.

With the app closed, run the maintenance launcher with `backup /absolute/path/data.tar.gz`.
Use `restore /absolute/path/data.tar.gz` to validate a backup, then repeat with
`--confirm` to apply it. Restore retains the prior data folder as a sibling recovery
folder and relocates artifact paths, including backups moved between OS families.
API keys are excluded unless `--include-api-key` is explicit. Archives are not encrypted.
See [the user guide](USER-GUIDE.md#backups) for detailed recovery behavior.

Quote launcher and archive paths containing spaces. On Windows PowerShell, for example:

```powershell
& 'C:\path\to\installation\backend\role-clinic.cmd' backup 'D:\Backups\clinic.tar.gz'
& 'C:\path\to\installation\backend\role-clinic.cmd' restore 'D:\Backups\clinic.tar.gz'
```

For macOS:

```sh
'/Applications/The Role Clinic.app/Contents/Resources/backend/role-clinic' backup "$HOME/clinic.tar.gz"
```

Uninstall through the Linux package manager or Windows Installed apps, or delete the
AppImage/Mac app. Uninstalling should leave personal data in place; each platform's
installer/removal behavior must be tested before advertising support. To remove data,
make any desired backup, quit the app, then delete the exact data folder shown in
Settings. Recovery folders and user-saved backups are separate and remain until removed.

## Build and validate

Use the Node version in `.node-version`, Rust in `rust-toolchain.toml`, and native
Tauri prerequisites. Build on the target OS/CPU: Linux x64 with GTK3/WebKitGTK 4.1,
macOS arm64 with Xcode, Windows x64 with Microsoft C++ Build Tools/Windows SDK.
Backend cross-compilation is deliberately refused; native SQLite is smoke-tested
with exactly the Node executable being shipped. Only the target SQLite prebuild is copied.
Linux places the companion in `usr/libexec/the-role-clinic/backend`, outside the
`usr/lib` tree rewritten by AppImage's linuxdeploy tool. The shipped native binaries
therefore retain their manifest hashes in all three Linux package formats. The
AppImage CI check verifies its actual extracted payload, not only the staging folder.

```sh
npm ci --ignore-scripts
npm test
npm run desktop:check
npm run desktop:build
npm run desktop:collect
```

The package version must match `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`;
the preparation/build checks refuse mismatches or nonnumeric version suffixes.
No script bumps versions. Tauri automatically merges its macOS/Windows config overlay.
Linux remains DEB/RPM/AppImage, macOS APP/DMG, Windows per-user NSIS.
Build results default to `src-tauri/target/release/bundle/`; `CARGO_TARGET_DIR` overrides
that root. Collection writes OS-specific `dist/desktop-<target>-<version>/` artifacts,
checksums and build provenance marked as unqualified development previews.

macOS CI derives a monotonic build ordinal from `GITHUB_RUN_NUMBER * 100 +
GITHUB_RUN_ATTEMPT` and maps it to Apple's numeric `CFBundleVersion` components.
`ROLE_CLINIC_BUILD_NUMBER` overrides that ordinal for controlled release builds; never
reuse or decrease it in the same distribution channel. Local builds without it default
to the app version. `CFBundleShortVersionString` stays equal to `package.json`.
This is separate from the marketing version; the public channel must keep an ordinal
ledger if its workflow changes. No App Store distribution is configured.

Mac preparation signs the bundled Node executable with its JIT entitlement and the
SQLite addon with the same `APPLE_SIGNING_IDENTITY` (ad-hoc `-` by default).
For a real signing build, the identity must already exist in the local keychain before
preparation. Tauri can then sign/notarize the outer app with the normal Apple environment
variables. Certificate import and secure release credential provisioning are not
implemented by the preview workflow. Validate the nested signatures, notarization and
Gatekeeper assessment before release. Windows signing can use Tauri's supported
certificate/sign-command configuration once credentials and a channel are selected.
No signing secrets are required by pull-request CI.

### Automated coverage and remaining checks

`.github/workflows/desktop-linux.yml` builds on Ubuntu 22.04 and runs the Linux native
WebKit harness without outbound networking. Its test-only root containers disable the
WebKit sandbox; production does not. `packaging/Dockerfile.desktop-linux` provides the
pinned build environment. See the existing Linux evidence for Fedora checks.

`.github/workflows/desktop-native.yml` builds on native macOS arm64 and Windows x64
runners, installs the DMG/NSIS artifacts into paths with spaces/non-ASCII, and runs:

- `scripts/smoke-package.mjs`: bundled Node/SQLite, loopback guards, first-run capture,
  controlled local Ollama connection, real exports/submitted records, package move,
  schema migration/refusal, full backup/key opt-in and relocated restore without system Node.
- `scripts/smoke-desktop-lifecycle.mjs`: actual installed shell startup, second launch,
  saved data after quit/reopen, and shell-crash cleanup. This is a lifecycle check,
  not proof of rendering, keyboard shortcuts or native dialogs.

CI is configured, not recorded as passed until its runs are inspected. Hosted runners
contain development software and do not prove clean-machine prerequisites. Before
qualifying either new OS, use [the desktop acceptance checklist](DESKTOP-ACCEPTANCE.md)
on clean target machines. Keep missing-runtime handling, signing, uninstall/update
preservation and real webview workflows open until that evidence exists.

Official references: [Tauri distribution](https://v2.tauri.app/distribute/),
[Windows WebView2 installation](https://v2.tauri.app/distribute/windows-installer/),
[macOS signing](https://v2.tauri.app/distribute/sign/macos/),
[Node 24 platform floors](https://github.com/nodejs/node/blob/v24.x/BUILDING.md).

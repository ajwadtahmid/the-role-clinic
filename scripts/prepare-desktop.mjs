import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { desktopTarget, checkDesktopVersions } from './desktop-target.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
desktopTarget()
await checkDesktopVersions(new URL('../', import.meta.url))
const targetArch = { x86_64: 'x64', aarch64: 'arm64' }[process.env.TAURI_ENV_ARCH] || process.env.TAURI_ENV_ARCH
if (targetArch && targetArch !== process.arch) throw new Error('Build with a native Node runtime matching the Tauri target architecture; cross-compiling the backend is not supported.')
const targetOS = { linux: 'linux', darwin: 'darwin', macos: 'darwin', windows: 'win32' }[process.env.TAURI_ENV_PLATFORM]
if (targetOS && targetOS !== process.platform) throw new Error('Build on the target operating system so the backend and native dependencies match the installer.')
execFileSync(process.execPath, ['scripts/build-package.mjs', '--stage-only'], { cwd: root, stdio: 'inherit' })

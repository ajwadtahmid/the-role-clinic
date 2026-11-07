import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Phase 8 currently builds Linux x86_64 only.')
execFileSync(process.execPath, ['scripts/build-package.mjs', '--stage-only'], { cwd: root, stdio: 'inherit' })

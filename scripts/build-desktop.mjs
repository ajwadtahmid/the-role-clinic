import { execFileSync } from 'node:child_process'
import { checkDesktopVersions, desktopTarget, macBundleVersion } from './desktop-target.mjs'

await checkDesktopVersions(new URL('../', import.meta.url))
desktopTarget()
const args = ['node_modules/@tauri-apps/cli/tauri.js', 'build', ...process.argv.slice(2)]
if (process.platform === 'darwin') {
  const sequence = process.env.ROLE_CLINIC_BUILD_NUMBER || (process.env.GITHUB_RUN_NUMBER ? String(Number(process.env.GITHUB_RUN_NUMBER) * 100 + Number(process.env.GITHUB_RUN_ATTEMPT || 1)) : null)
  if (sequence) args.push('--config', JSON.stringify({ bundle: { macOS: { bundleVersion: macBundleVersion(sequence) } } }))
}
execFileSync(process.execPath, args, { cwd: new URL('../', import.meta.url), stdio: 'inherit' })

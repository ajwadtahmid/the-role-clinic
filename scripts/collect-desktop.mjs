import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, copyFile, writeFile, chmod } from 'node:fs/promises'
import { join, resolve, basename } from 'node:path'
import { desktopTarget, checkDesktopVersions } from './desktop-target.mjs'

const version = await checkDesktopVersions(new URL('../', import.meta.url))
const { target } = desktopTarget()
const source = resolve(process.argv[2] || `${process.env.CARGO_TARGET_DIR || 'src-tauri/target'}/release/bundle`)
const output = resolve(`dist/desktop-${target}-${version}`)
await mkdir(output, { recursive: true })
const extensions = process.platform === 'darwin' ? ['.dmg'] : process.platform === 'win32' ? ['.exe'] : ['.deb', '.rpm', '.AppImage']
const files = []
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name)
    if (entry.isDirectory() && !entry.name.endsWith('.app')) await collect(file)
    else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
      const bytes = await readFile(file), destination = join(output, basename(file))
      await copyFile(file, destination)
      if (entry.name.endsWith('.AppImage')) await chmod(destination, 0o755)
      files.push({ name: basename(file), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
  }
}
await collect(source)
if (!files.length || extensions.some((ext) => !files.some((file) => file.name.endsWith(ext)))) throw new Error(`Missing expected ${target} installer formats: ${extensions.join(', ')}`)
files.sort((a, b) => a.name.localeCompare(b.name))
await writeFile(join(output, 'SHA256SUMS'), files.map((file) => `${file.sha256}  ${file.name}\n`).join(''))
await writeFile(join(output, 'build.json'), JSON.stringify({ version, target, node: process.version, sourceCommit: process.env.GITHUB_SHA || null, run: process.env.GITHUB_RUN_ID || null, buildOrdinal: process.env.ROLE_CLINIC_BUILD_NUMBER || (process.env.GITHUB_RUN_NUMBER ? Number(process.env.GITHUB_RUN_NUMBER) * 100 + Number(process.env.GITHUB_RUN_ATTEMPT || 1) : null), distribution: 'development-preview', publicReleaseQualified: false, files }, null, 2))
console.log(output)

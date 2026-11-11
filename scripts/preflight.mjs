// Run this before pushing a release tag. It does, on this computer and for free, what CI would otherwise
// find out one slow, billed run at a time.
//   npm run preflight                quick checks: versions, workflows, types, tests, build, Linux package
//   npm run preflight -- --desktop   also builds the Linux AppImage in Docker and runs the native UI test, as CI does
// It cannot run the Windows build or the Windows-only tests; those run only on GitHub.
import { spawnSync } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkDesktopVersions } from './desktop-target.mjs'

const root = new URL('../', import.meta.url)
const rootPath = fileURLToPath(root)
const desktop = process.argv.includes('--desktop')
const failures = []
const warnings = []
const started = Date.now()
const seconds = () => `${Math.round((Date.now() - started) / 1000)}s`

async function check(name, run) {
  process.stdout.write(`\n== ${name}\n`)
  try { await run(); console.log(`ok   ${name} (${seconds()})`) } catch (error) { console.log(`FAIL ${name}: ${error.message}`); failures.push(name); return false }
  return true
}
function command(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: rootPath, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${result.status}`)
}

// 1. The version must agree everywhere a build reads it.
await check('versions match', async () => { console.log(await checkDesktopVersions(root)) })

// 2. Workflows: tags only, and everything they call must exist.
await check('workflows', async () => {
  const directory = join(rootPath, '.github', 'workflows')
  const files = (await readdir(directory)).filter((file) => file.endsWith('.yml'))
  const scripts = JSON.parse(await readFile(join(rootPath, 'package.json'), 'utf8')).scripts
  const problems = []
  for (const file of files) {
    const text = await readFile(join(directory, file), 'utf8')
    if (/^\s*pull_request\b/m.test(text) || /^\s*branches:/m.test(text)) problems.push(`${file} runs on pushes or pull requests; builds are for version tags only`)
    for (const [, path] of text.matchAll(/\b(scripts\/[\w.-]+\.(?:mjs|sh))/g)) if (!(await stat(join(rootPath, path)).catch(() => null))) problems.push(`${file} uses ${path}, which does not exist`)
    for (const [, name] of text.matchAll(/npm run ([\w:-]+)/g)) if (!scripts[name]) problems.push(`${file} runs npm script "${name}", which does not exist`)
    for (const [, called] of text.matchAll(/uses: \.\/\.github\/workflows\/([\w.-]+)/g)) {
      const target = await readFile(join(directory, called), 'utf8').catch(() => null)
      if (target === null) problems.push(`${file} calls ${called}, which does not exist`)
      else if (!/^\s*workflow_call:/m.test(target)) problems.push(`${called} is called from ${file} but has no workflow_call trigger`)
    }
  }
  const release = await readFile(join(directory, 'release.yml'), 'utf8')
  if (!/tags:\s*\[/.test(release)) problems.push('release.yml does not trigger on tags')
  if (problems.length) throw new Error(`\n  ${problems.join('\n  ')}`)
})

// 3. Windows will not delete a file that is still open, and CI is the only place that notices. Flag the likely cases.
await check('tests close their databases before deleting them (Windows)', async () => {
  const found = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (/\.test\.tsx?$/.test(entry.name)) {
        const text = await readFile(path, 'utf8')
        if (/createDatabase\(/.test(text) && /rm\([^)]*recursive/.test(text) && !/\.close\(\)/.test(text)) found.push(path.slice(rootPath.length))
      }
    }
  }
  await walk(join(rootPath, 'apps')); await walk(join(rootPath, 'packages'))
  if (found.length) throw new Error(`these tests open a database and delete its folder without closing it:\n  ${found.join('\n  ')}`)
})

const quick = [
  ['typecheck', () => command('npm', ['run', 'typecheck'])],
  // Named folders keep the old node:test scripts under extra/ out, which vitest cannot run.
  ['tests', () => command('npx', ['vitest', 'run', 'apps', 'packages'])],
  ['desktop target checks', () => command('node', ['--test', 'scripts/desktop-target.checks.mjs'])],
  ['build', () => command('npm', ['run', 'build'])],
  ['Linux package', () => command('npm', ['run', 'package:linux'])],
  ['Linux package smoke test', async () => {
    const version = JSON.parse(await readFile(join(rootPath, 'package.json'), 'utf8')).version
    command('npm', ['run', 'test:package', '--', `dist/the-role-clinic-${version}-linux-x64.tar.gz`])
  }],
]
for (const [name, run] of quick) if (!(await check(name, run))) break

if (desktop && !failures.length) {
  await check('Linux AppImage build and native UI test (Docker)', () => command('bash', ['scripts/ci-desktop-linux.sh', 'all']))
} else if (!desktop) {
  warnings.push('Skipped the Linux AppImage build and native UI test. Run with --desktop before tagging a release.')
}
warnings.push('Not covered here: the Windows build and the Windows-only tests. They run only on GitHub.')

console.log(`\n${failures.length ? `FAILED: ${failures.join(', ')}` : 'All checks passed.'} (${seconds()})`)
for (const warning of warnings) console.log(`note: ${warning}`)
process.exit(failures.length ? 1 : 0)

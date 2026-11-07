import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile, chmod } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { c } from 'tar'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)
if (process.platform !== 'linux' || process.arch !== 'x64' || !process.report.getReport().header.glibcVersionRuntime) throw new Error('Build this target on Linux x86_64 with glibc.')
const pinnedNode = (await readFile('.node-version', 'utf8')).trim()
if (process.version !== `v${pinnedNode}`) throw new Error('Build with Node v24.18.1 so the bundled runtime is pinned and reproducible.')
const pkg = JSON.parse(await readFile('package.json', 'utf8')), lock = JSON.parse(await readFile('package-lock.json', 'utf8'))
const stageOnly = process.argv.includes('--stage-only')
const name = stageOnly ? 'desktop-backend' : `the-role-clinic-${pkg.version}-linux-x64`, output = join(root, 'dist', name), archive = `${output}.tar.gz`
await mkdir(join(root, 'dist'), { recursive: true })
await rm(output, { recursive: true, force: true }); await rm(archive, { force: true })
await rm(join(root, 'dist/compiled'), { recursive: true, force: true })
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' })
run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.package.json'])
run(process.execPath, ['scripts/render-guide.mjs'])
run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'apps/web/vite.config.ts'])
await mkdir(join(output, 'app'), { recursive: true })
await cp('dist/compiled/apps', join(output, 'app/apps'), { recursive: true })
await cp('dist/compiled/packages', join(output, 'app/packages'), { recursive: true })
await cp('apps/web/dist', join(output, 'app/apps/web/dist'), { recursive: true })
await writeFile(join(output, 'app/package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, type: 'module', private: true, dependencies: pkg.dependencies }, null, 2))
await writeFile(join(output, 'app/apps/server/package.json'), JSON.stringify({ type: 'module' }))
await writeFile(join(output, 'app/packages/shared/package.json'), JSON.stringify({ type: 'module' }))
const modules = [...new Set(execFileSync(process.execPath, [process.env.npm_execpath || join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'), 'ls', '--omit=dev', '--all', '--parseable'], { cwd: root, encoding: 'utf8' }).trim().split('\n'))]
const licenses = []
for (const source of modules) {
  const rel = relative(root, source)
  if (!rel.startsWith('node_modules/') || rel.includes('/@the-role-clinic/')) continue
  const sourceReal = await realpath(source)
  if (!sourceReal.startsWith(`${root}/node_modules/`)) throw new Error(`A dependency resolves outside the locked install: ${rel}`)
  const dependency = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  if (lock.packages[rel]?.version !== dependency.version) throw new Error(`Dependency differs from package-lock.json: ${rel}. Run npm ci before packaging.`)
  const target = join(output, 'app', rel)
  await mkdir(dirname(target), { recursive: true })
  await cp(source, target, { recursive: true, filter: (path) => {
    const child = relative(source, path)
    if (child === 'node_modules' || child.startsWith('node_modules/')) return false
    if (rel === 'node_modules/better-sqlite3' && child.startsWith('prebuilds/') && child !== 'prebuilds/linux-x64.node') return false
    return true
  } })
  licenses.push({ name: dependency.name, version: dependency.version, license: dependency.license ?? 'See package files', path: `app/${rel}` })
}
await mkdir(join(output, 'runtime'))
await cp(process.execPath, join(output, 'runtime/node')); await chmod(join(output, 'runtime/node'), 0o755)
await cp(join(dirname(process.execPath), '../LICENSE'), join(output, 'runtime/LICENSE'))
await cp('packaging/role-clinic', join(output, 'role-clinic')); await chmod(join(output, 'role-clinic'), 0o755)
await cp('packaging/launcher.mjs', join(output, 'launcher.mjs'))
await cp('packaging/USER-GUIDE.md', join(output, 'USER-GUIDE.md'))
await writeFile(join(output, 'THIRD-PARTY.json'), JSON.stringify(licenses, null, 2))
const binaryFiles = ['runtime/node', 'app/node_modules/better-sqlite3/prebuilds/linux-x64.node']
const requirements = { glibc: '0', glibcxx: '0' }
const numeric = (a, b) => a.localeCompare(b, undefined, { numeric: true })
for (const path of binaryFiles) {
  const info = execFileSync('readelf', ['--version-info', join(output, path)], { encoding: 'utf8' })
  for (const match of info.matchAll(/\b(GLIBC|GLIBCXX)_([\d.]+)/g)) {
    const key = match[1] === 'GLIBC' ? 'glibc' : 'glibcxx'
    if (numeric(match[2], requirements[key]) > 0) requirements[key] = match[2]
  }
}
// Exercise the bundled native module with exactly the runtime being shipped.
run(join(output, 'runtime/node'), ['--input-type=module', '-e', `import Database from ${JSON.stringify(join(output, 'app/node_modules/better-sqlite3/lib/index.js'))};const d=new Database(':memory:');d.exec('CREATE VIRTUAL TABLE t USING fts5(text)');d.close()`])
const files = []
async function inventory(directory) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await inventory(path)
    else if (entry.isFile()) { const bytes = await readFile(path); files.push({ path: relative(output, path), size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }) }
    else throw new Error(`Unexpected symbolic link or special file in the package: ${path}`)
  }
}
await inventory(output)
const manifest = { format: 'the-role-clinic-package', version: pkg.version, target: 'linux-x64-glibc', nodeVersion: process.version, schemaVersion: 7, requirements, packageLockSha256: createHash('sha256').update(await readFile('package-lock.json')).digest('hex'), files }
await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2))
if (!stageOnly) {
  await c({ file: archive, cwd: join(root, 'dist'), gzip: true, portable: true, noMtime: true }, [name])
  const checksum = createHash('sha256').update(await readFile(archive)).digest('hex')
  await writeFile(`${archive}.sha256`, `${checksum}  ${name}.tar.gz\n`)
}
console.log(JSON.stringify({ ...(stageOnly ? { staged: output } : { archive, bytes: (await stat(archive)).size }), files: files.length, requirements }, null, 2))

import { readFile } from 'node:fs/promises'

export function desktopTarget(platform = process.platform, arch = process.arch) {
  const targets = {
    'linux-x64': { target: 'linux-x64-glibc', node: 'node', sqlite: 'linux-x64.node', requirements: {} },
    'darwin-arm64': { target: 'darwin-arm64', node: 'node', sqlite: 'darwin-arm64.node', requirements: { macOS: '13.5' } },
    'win32-x64': { target: 'win32-x64', node: 'node.exe', sqlite: 'win32-x64.node', requirements: { windows: '10', webview: 'WebView2 Evergreen' } },
  }
  const result = targets[`${platform}-${arch}`]
  if (!result) throw new Error(`No desktop package is configured for ${platform}-${arch}. Build natively on Linux x64, macOS arm64 or Windows x64.`)
  return result
}

export async function checkDesktopVersions(root) {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  const config = JSON.parse(await readFile(new URL('src-tauri/tauri.conf.json', root), 'utf8'))
  const cargo = await readFile(new URL('src-tauri/Cargo.toml', root), 'utf8')
  const version = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version) || config.version !== pkg.version || version !== pkg.version) {
    throw new Error('Desktop versions must use the same MAJOR.MINOR.PATCH in package.json, tauri.conf.json and Cargo.toml.')
  }
  return pkg.version
}

export function macBundleVersion(sequence) {
  if (!/^\d+$/.test(String(sequence)) || !Number.isSafeInteger(Number(sequence)) || Number(sequence) < 1 || Number(sequence) > 99989999) throw new Error('ROLE_CLINIC_BUILD_NUMBER must be an increasing integer from 1 to 99989999.')
  const number = Number(sequence)
  return `${1 + Math.floor(number / 10000)}.${Math.floor(number / 100) % 100}.${number % 100}`
}

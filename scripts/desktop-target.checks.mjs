import assert from 'node:assert/strict'
import { test } from 'node:test'
import { desktopTarget, checkDesktopVersions, macBundleVersion } from './desktop-target.mjs'

test('packages only the three explicitly selected native targets', () => {
  assert.equal(desktopTarget('linux', 'x64').sqlite, 'linux-x64.node')
  assert.equal(desktopTarget('darwin', 'arm64').sqlite, 'darwin-arm64.node')
  assert.equal(desktopTarget('win32', 'x64').node, 'node.exe')
  for (const [os, arch] of [['darwin', 'x64'], ['win32', 'arm64'], ['linux', 'arm64']]) assert.throws(() => desktopTarget(os, arch), /No desktop package/)
})
test('desktop version copies agree with the package version', async () => {
  await checkDesktopVersions(new URL('../', import.meta.url))
})
test('macOS build numbers increase across rebuilds within Apple numeric limits', () => {
  assert.equal(macBundleVersion(101), '1.1.1')
  assert.equal(macBundleVersion(10000), '2.0.0')
  assert.equal(macBundleVersion(99989999), '9999.99.99')
  for (const bad of [0, -1, 99990000, '1.2', '1;exit']) assert.throws(() => macBundleVersion(bad), /increasing integer/)
})

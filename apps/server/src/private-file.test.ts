import { it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { defaultSettings, writeSettings } from './settings.js'

it.skipIf(process.platform !== 'win32')('protects settings with a Windows DACL restricted to the current account', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clinic-permissions-'))
  try {
    await writeSettings(root, { ...defaultSettings(), anthropicApiKey: 'FAKE_PERMISSION_TEST_KEY' })
    const script = '$acl=Get-Acl -LiteralPath $env:ROLE_CLINIC_PERMISSION_TEST; [pscustomobject]@{protected=$acl.AreAccessRulesProtected; user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; rules=@($acl.Access | ForEach-Object { [pscustomobject]@{sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; inherited=$_.IsInherited; type=$_.AccessControlType.ToString(); rights=$_.FileSystemRights.ToString()} })} | ConvertTo-Json -Depth 4'
    const { stdout } = await promisify(execFile)(join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, env: { ...process.env, ROLE_CLINIC_PERMISSION_TEST: join(root, 'settings.json') } })
    const acl = JSON.parse(stdout)
    expect(acl.protected).toBe(true)
    // Windows can leave SYSTEM and Administrators on a new file whatever we grant, and they can reach it anyway.
    // What matters is that nothing is inherited, the account has full control, and nobody else is let in.
    const standard = new Set(['S-1-5-18', 'S-1-5-32-544'])
    expect(acl.rules.every((rule: { inherited: boolean; type: string }) => !rule.inherited && rule.type === 'Allow')).toBe(true)
    expect(acl.rules.find((rule: { sid: string }) => rule.sid === acl.user)).toMatchObject({ rights: 'FullControl' })
    expect(acl.rules.filter((rule: { sid: string }) => rule.sid !== acl.user && !standard.has(rule.sid))).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
  // Starting PowerShell and reading an ACL can take several seconds on a hosted Windows runner.
}, 30_000)

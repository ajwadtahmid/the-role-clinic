import { execFile } from 'node:child_process'
import { chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
let userSid: Promise<string> | undefined
export async function protectPrivateFile(path: string): Promise<void> {
  if (process.platform !== 'win32') { await chmod(path, 0o600); return }
  const system = join(process.env.SystemRoot || 'C:\\Windows', 'System32')
  userSid ??= exec(join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true }).then(({ stdout }) => {
    const sid = stdout.match(/S-1-\d+(?:-\d+)+/)?.[0]
    if (!sid) throw new Error('Could not determine the Windows account for private file permissions.')
    return sid
  })
  const sid = await userSid
  // New files have only inherited ACEs. Remove them and grant this account access by SID.
  await exec(join(system, 'icacls.exe'), [path, '/inheritance:r', '/grant:r', `*${sid}:(F)`], { windowsHide: true })
}

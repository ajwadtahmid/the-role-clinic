import { homedir } from 'node:os'
import { join } from 'node:path'

export function getDataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ROLE_CLINIC_DATA_DIR) return env.ROLE_CLINIC_DATA_DIR
  if (env.APPDATA) return join(env.APPDATA, 'The Role Clinic')
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'The Role Clinic')
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'the-role-clinic')
}

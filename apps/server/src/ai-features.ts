import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import type { AiFeatures, AppSettings } from '../../../packages/shared/src/index.js'

// Whether the AI parts (fit check, tailoring, the Résumé page) are in use. A new install asks once (chosen is false until then);
// an install that already has a settings file, a finished welcome or any jobs predates the choice and keeps working as it did, so it counts as on.
export function resolveAiFeatures(sqlite: Database.Database, dataDirectory: string, settings: AppSettings): AiFeatures {
  if (settings.aiFeatures) return settings.aiFeatures
  const existing = existsSync(join(dataDirectory, 'settings.json')) || existsSync(join(dataDirectory, 'welcome.json')) || Boolean(sqlite.prepare('SELECT 1 FROM jobs LIMIT 1').get())
  return existing ? { chosen: true, enabled: true, hidden: false } : { chosen: false, enabled: false, hidden: false }
}

// Automatic checks only run while AI features are on and showing.
export const aiActive = (features: AiFeatures) => features.enabled && !features.hidden

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { appSettingsSchema, taskNames, type AppSettings, type PublicSettings } from '../../../packages/shared/src/index.js'

const DEFAULT_MODEL = 'gemma4:12b'
export function defaultSettings(): AppSettings {
  return {
    taskModels: Object.fromEntries(taskNames.map((task) => [task, { provider: 'ollama', model: DEFAULT_MODEL }])) as AppSettings['taskModels'],
    ollamaBaseUrl: 'http://127.0.0.1:11434',
  }
}

export async function readSettings(dataDirectory: string): Promise<AppSettings> {
  let content: string
  try {
    content = await readFile(join(dataDirectory, 'settings.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultSettings()
    throw error
  }
  return appSettingsSchema.parse(JSON.parse(content))
}

export async function writeSettings(dataDirectory: string, settings: AppSettings): Promise<void> {
  const validated = appSettingsSchema.parse(settings)
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 })
  const tmp = join(dataDirectory, `.settings-${randomUUID()}.tmp`)
  await writeFile(tmp, JSON.stringify(validated, null, 2), { mode: 0o600 })
  await chmod(tmp, 0o600)
  await rename(tmp, join(dataDirectory, 'settings.json'))
}

export function toPublicSettings(settings: AppSettings): PublicSettings {
  return {
    taskModels: settings.taskModels,
    ollamaBaseUrl: settings.ollamaBaseUrl,
    anthropicApiKeyConfigured: Boolean(settings.anthropicApiKey),
  }
}

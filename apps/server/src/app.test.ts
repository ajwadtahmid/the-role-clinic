import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.js'
import { createDatabase } from './db.js'
import { defaultSettings, readSettings } from './settings.js'
import { SerialRunQueue } from './queue.js'

const temporaryDirectories: string[] = []
async function fixture(development = false) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'role-clinic-test-'))
  temporaryDirectories.push(dataDirectory)
  const { sqlite, db } = createDatabase(dataDirectory)
  return { dataDirectory, sqlite, db, app: createApp({ dataDirectory, sqlite, db, development, port: 3000, webPort: 5173 }) }
}
function request(app: ReturnType<typeof createApp>, path: string, init: RequestInit = {}) {
  return app.request(`http://127.0.0.1:3000${path}`, {
    ...init,
    headers: { host: '127.0.0.1:3000', ...(init.headers ?? {}) },
  })
}
const sameOrigin = { origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' }

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('Phase 1 local foundation', () => {
  it('creates the SQLite schema and reports health', async () => {
    const { app, sqlite } = await fixture()
    const response = await request(app, '/api/health')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, database: 'connected' })
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all().map((row) => (row as { name: string }).name)
    expect(tables).toContain('job_answers_fts')
    expect(tables).toContain('applications')
    expect(tables).toContain('runs')
    sqlite.close()
  })

  it('rejects hostile Host headers and cross-origin or originless mutations', async () => {
    const { app, sqlite } = await fixture()
    const hostileHost = await request(app, '/api/health', { headers: { host: 'evil.example:3000' } })
    const noOrigin = await request(app, '/api/backups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const foreignOrigin = await request(app, '/api/backups', { method: 'POST', headers: { ...sameOrigin, origin: 'http://evil.example:3000' }, body: '{}' })
    expect(hostileHost.status).toBe(403)
    expect(noOrigin.status).toBe(403)
    expect(foreignOrigin.status).toBe(403)
    sqlite.close()
  })

  it('persists per-task model choices and never returns the API key', async () => {
    const { app, dataDirectory, sqlite } = await fixture()
    const settings = defaultSettings()
    settings.taskModels.requirementExtraction = { provider: 'ollama', model: 'qwen3.5:9b' }
    settings.taskModels.resumeDrafting = { provider: 'anthropic', model: 'claude-sonnet' }
    settings.anthropicApiKey = 'sk-ant-test-secret'
    const saved = await request(app, '/api/settings', { method: 'PUT', headers: sameOrigin, body: JSON.stringify(settings) })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ taskModels: settings.taskModels, anthropicApiKeyConfigured: true })
    const loaded = await request(app, '/api/settings')
    const response = await loaded.text()
    expect(response).not.toContain('sk-ant-test-secret')
    expect(JSON.parse(response).taskModels.requirementExtraction.model).toBe('qwen3.5:9b')
    const stored = await readFile(join(dataDirectory, 'settings.json'), 'utf8')
    expect(stored).toContain('sk-ant-test-secret')
    const permissions = (await stat(join(dataDirectory, 'settings.json'))).mode & 0o777
    expect(permissions).toBe(0o600)
    sqlite.close()
  })

  it('does not allow Ollama URLs to target remote hosts', async () => {
    const { app, sqlite } = await fixture()
    const settings = defaultSettings()
    settings.ollamaBaseUrl = 'http://192.168.1.50:11434'
    const response = await request(app, '/api/settings', { method: 'PUT', headers: sameOrigin, body: JSON.stringify(settings) })
    expect(response.status).toBe(400)
    expect((await response.json()).error).toContain('localhost or 127.0.0.1')
    sqlite.close()
  })

  it('explains that an Anthropic connection test needs a saved key without sending a request', async () => {
    const { app, sqlite } = await fixture()
    const response = await request(app, '/api/connections/anthropic/test', { method: 'POST', headers: sameOrigin, body: '{}' })
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ ok: false, error: 'Add an Anthropic API key in Settings first.' })
    sqlite.close()
  })

  it('creates a consistent database backup outside the app bundle', async () => {
    const { app, dataDirectory, sqlite } = await fixture()
    const response = await request(app, '/api/backups', { method: 'POST', headers: sameOrigin, body: '{}' })
    expect(response.status).toBe(201)
    const payload = await response.json() as { filename: string }
    const backupPath = join(dataDirectory, 'backups', payload.filename)
    const backup = await readFile(backupPath)
    expect(backup.subarray(0, 16).toString()).toBe('SQLite format 3\u0000')
    sqlite.close()
  })

  it('serializes queued work and publishes replayable run events', async () => {
    const { sqlite, db } = await fixture(true)
    const queue = new SerialRunQueue(db)
    const events: number[] = []
    queue.subscribe((event) => events.push(event.id))
    const first = queue.enqueueDemo()
    const second = queue.enqueueDemo()
    await new Promise((resolve) => setTimeout(resolve, 120))
    const statuses = sqlite.prepare('SELECT status FROM runs ORDER BY created_at, rowid').all().map((row) => (row as { status: string }).status)
    expect(statuses).toEqual(['done', 'done'])
    expect(queue.getEventsAfter(0).map((event) => event.runId)).toContain(first.id)
    expect(queue.getEventsAfter(0).map((event) => event.runId)).toContain(second.id)
    expect(events).toEqual([1, 2, 3, 4, 5, 6])
    sqlite.close()
  })

  it('replays queue events over the SSE endpoint', async () => {
    const { app, sqlite } = await fixture(true)
    const queued = await request(app, '/api/dev/queue-demo', { method: 'POST', headers: { ...sameOrigin, origin: 'http://127.0.0.1:5173' }, body: '{}' })
    expect(queued.status).toBe(202)
    await new Promise((resolve) => setTimeout(resolve, 60))
    const controller = new AbortController()
    const response = await request(app, '/api/runs/events?after=0', { signal: controller.signal })
    const reader = response.body!.getReader()
    let output = ''
    for (let index = 0; index < 5 && !output.includes('queue-smoke-test'); index += 1) {
      const chunk = await reader.read()
      if (chunk.done) break
      output += new TextDecoder().decode(chunk.value)
    }
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(output).toContain('event: run')
    expect(output).toContain('queue-smoke-test')
    controller.abort()
    await reader.cancel().catch(() => undefined)
    sqlite.close()
  })
})

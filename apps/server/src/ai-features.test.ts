import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.js'
import { createDatabase } from './db.js'
import { defaultSettings, readSettings, writeSettings } from './settings.js'
import type { ModelRequest } from './model-adapters.js'

const directories: string[] = []
async function fixture(modelRouter?: { complete: (task: string, request: ModelRequest) => Promise<{ text: string; provider: 'ollama'; model: string }> }) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'role-clinic-ai-')); directories.push(dataDirectory)
  const { sqlite, db } = createDatabase(dataDirectory)
  const app = createApp({ dataDirectory, sqlite, db, port: 3000, ...(modelRouter ? { modelRouter: modelRouter as never } : {}) })
  const call = (path: string, init: RequestInit = {}) => app.request(`http://127.0.0.1:3000${path}`, { ...init, headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'content-type': 'application/json', ...(init.headers ?? {}) } })
  const features = async () => ((await (await call('/api/settings')).json()) as { aiFeatures: { chosen: boolean; enabled: boolean; hidden: boolean } }).aiFeatures
  return { dataDirectory, sqlite, call, features }
}
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })

describe('AI features setting', () => {
  it('asks a new install once, and counts an install that already has settings or jobs as on', async () => {
    const fresh = await fixture()
    expect(await fresh.features()).toEqual({ chosen: false, enabled: false, hidden: false })
    fresh.sqlite.close()
    const withSettings = await fixture()
    await writeSettings(withSettings.dataDirectory, defaultSettings())
    expect(await withSettings.features()).toEqual({ chosen: true, enabled: true, hidden: false })
    withSettings.sqlite.close()
    const withJobs = await fixture()
    await withJobs.call('/api/jobs', { method: 'POST', body: JSON.stringify({ company: 'Acme', title: 'Engineer', text: 'A job description that is long enough to be saved as a job.' }) })
    expect(await withJobs.features()).toEqual({ chosen: true, enabled: true, hidden: false })
    withJobs.sqlite.close()
  })

  it('records the first choice, hides and shows AI without deleting, and is not changed by saving model settings', async () => {
    const f = await fixture()
    expect((await f.call('/api/ai-features', { method: 'PUT', body: JSON.stringify({ enabled: false }) })).status).toBe(200)
    expect(await f.features()).toEqual({ chosen: true, enabled: false, hidden: false })
    await f.call('/api/ai-features', { method: 'PUT', body: JSON.stringify({ enabled: true }) })
    await f.call('/api/ai-features', { method: 'PUT', body: JSON.stringify({ hidden: true }) })
    expect(await f.features()).toEqual({ chosen: true, enabled: true, hidden: true })
    // Saving model settings from the Settings page, which holds an older copy, cannot undo the choice.
    const saved = await f.call('/api/settings', { method: 'PUT', body: JSON.stringify({ ...defaultSettings(), aiFeatures: { chosen: true, enabled: true, hidden: false } }) })
    expect(((await saved.json()) as { aiFeatures: { hidden: boolean } }).aiFeatures.hidden).toBe(true)
    expect((await readSettings(f.dataDirectory)).aiFeatures).toEqual({ chosen: true, enabled: true, hidden: true })
    await f.call('/api/ai-features', { method: 'PUT', body: JSON.stringify({ enabled: true }) })
    expect((await f.features()).hidden).toBe(false)
    expect((await f.call('/api/ai-features', { method: 'PUT', body: JSON.stringify({ enabled: 'yes' }) })).status).toBe(400)
    f.sqlite.close()
  })

  it('runs the quick test on a local model only, and says what went wrong', async () => {
    const seen: string[] = []
    const ok = await fixture({ async complete(task, request) { seen.push(`${task}:${request.maxOutputTokens}`); return { text: 'OK', provider: 'ollama', model: 'fake' } } })
    const passed = await (await ok.call('/api/ai/test', { method: 'POST' })).json() as { ok: boolean; model: string }
    expect(passed).toMatchObject({ ok: true, model: 'gemma4:12b' }); expect(seen).toEqual(['requirementExtraction:16'])
    ok.sqlite.close()
    const broken = await fixture({ async complete() { throw new Error('model "gemma4:12b" is not installed') } })
    const failed = await broken.call('/api/ai/test', { method: 'POST' })
    expect(failed.status).toBe(502); expect(await failed.json()).toMatchObject({ ok: false, error: expect.stringContaining('not installed') })
    broken.sqlite.close()
    const paid = await fixture(); const settings = defaultSettings(); settings.taskModels.requirementExtraction = { provider: 'anthropic', model: 'claude-test' }
    await writeSettings(paid.dataDirectory, settings)
    expect((await paid.call('/api/ai/test', { method: 'POST' })).status).toBe(409)
    paid.sqlite.close()
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createDatabase } from './db.js'
import { createApp } from './app.js'
import { saveMaster, saveProfile, readMaster } from './master.js'
import { defaultSettings, writeSettings } from './settings.js'
import { emptyMaster, emptyProfile, type TaskName } from '../../../packages/shared/src/index.js'
import type { ModelRequest } from './model-adapters.js'

const dirs: string[] = []
const jd = 'TypeScript experience is required. Rust experience is preferred. Candidates need 5+ years of software engineering experience. Must be authorized to work in the US.'
async function setup(auto = false, failSlop = false, draftText = 'Reduced API latency by 20% using TypeScript and Rust', semanticVerdict: 'grounded' | 'stretch' | 'unsupported' = 'grounded', countedTokens: number | null = null, unusableExtractionReplies = 0) {
  const dir = await mkdtemp(join(tmpdir(), 'clinic-pipeline-')); dirs.push(dir)
  const { sqlite, db } = createDatabase(dir)
  const master = emptyMaster(), bulletId = randomUUID()
  master.roles.push({ id: randomUUID(), company: 'Acme', title: 'Software Engineer', start: 'January 2025', end: 'Present', bullets: [{ id: bulletId, rev: 1, text: 'Reduced API latency by 15% using TypeScript', skills: ['TypeScript'], metrics: ['15%'], verbs: ['Reduced'], sourceRef: 'master.pdf' }] })
  master.skills.push({ name: 'TypeScript', category: 'Languages', evidenceIds: [bulletId] }, { name: 'Rust', category: 'Languages', evidenceIds: [] })
  saveMaster(sqlite, master)
  saveProfile(sqlite, { ...emptyProfile(), email: 'private-secret@example.test', workAuthorization: 'Authorized to work in the US; PRIVATE_PROFILE_MARKER' })
  if (auto) await writeSettings(dir, defaultSettings())
  const calls: TaskName[] = [], inputs: string[] = []
  let slopFailures = 0, unusableReplies = unusableExtractionReplies
  const modelRouter = { async countInputTokens() { return countedTokens }, async complete(task: TaskName, request: ModelRequest) {
    calls.push(task); inputs.push(request.user)
    if (task === 'requirementExtraction' && unusableReplies-- > 0) return { text: 'Sure! Here are the requirements you asked for.', provider: 'ollama' as const, model: 'fake-local' }
    let value: unknown
    if (task === 'requirementExtraction') value = { requirements: [
      { quote: 'TypeScript experience is required', kind: 'hard', category: 'skill', skill: 'TypeScript', years: null },
      { quote: 'Rust experience is preferred', kind: 'nice', category: 'skill', skill: 'Rust', years: null },
      { quote: '5+ years of software engineering experience', kind: 'knockout', category: 'years', skill: '', years: 5 },
      { quote: 'Must be authorized to work in the US', kind: 'knockout', category: 'work_authorization', skill: '', years: null },
    ], seniority: 'mid-level', vocabulary: ['TypeScript'] }
    else if (task === 'bulletScoring') {
      const input = JSON.parse(request.user) as { bullets: Array<{ id: string }>; requirements: Array<{ id: string }> }
      value = { scores: input.bullets.map((b) => ({ bulletId: b.id, score: 90, requirementIds: [input.requirements[0].id], rationale: 'Direct TypeScript experience.' })) }
    } else if (task === 'resumeDrafting') {
      const input = JSON.parse(request.user) as { bullets: Array<{ id: string }> }
      value = { lines: [{ text: draftText, sourceIds: [input.bullets[0].id] }] }
    } else if (task === 'claimVerification') {
      const input = JSON.parse(request.user) as { lines: Array<{ outId: string }> }
      value = { verdicts: input.lines.map((line) => ({ outId: line.outId, verdict: semanticVerdict, reason: 'Semantic review result.' })) }
    } else if (task === 'antiSlop') {
      if (failSlop && slopFailures++ === 0) throw new Error('Transient writing-review failure')
      value = { flags: [] }
    } else throw new Error(`Unexpected model task: ${task}`)
    return { text: JSON.stringify(value), provider: 'ollama' as const, model: 'fake-local', usage: { inputTokens: 100, outputTokens: 50 } }
  } }
  const app = createApp({ dataDirectory: dir, sqlite, db, port: 3000, modelRouter })
  const request = (path: string, init: RequestInit = {}) => app.request(`http://127.0.0.1:3000${path}`, { ...init, headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', ...(init.headers ?? {}) } })
  const post = (path: string, value: unknown = {}) => request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
  const created = await post('/api/jobs', { company: 'Example', title: 'Engineer', text: jd })
  const job = await created.json() as { id: string; extractionRunId: string | null }
  return { dir, sqlite, request, post, job, calls, inputs, bulletId }
}
async function waitFor(sqlite: ReturnType<typeof createDatabase>['sqlite'], kind: string, expected: string) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const row = sqlite.prepare('SELECT id,status,error FROM runs WHERE kind=? ORDER BY rowid DESC LIMIT 1').get(kind) as { id: string; status: string; error: string | null } | undefined
    if (row?.status === expected) return row
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`${kind} did not reach ${expected}`)
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

describe('extraction and tailoring pipeline', () => {
  it('auto-extracts exact JD spans, shows knockout basis, and keeps profile out of model requests', async () => {
    const { sqlite, request, job, calls, inputs } = await setup(true)
    expect(job.extractionRunId).toBeTruthy()
    await waitFor(sqlite, 'extract', 'done')
    const analysis = await (await request(`/api/jobs/${job.id}/analysis`)).json() as { extraction: { requirements: Array<{ quote: string; start: number; end: number; assessment: string; basis: string }> }; preliminaryGaps: unknown[] }
    expect(analysis.extraction.requirements).toHaveLength(4)
    for (const requirement of analysis.extraction.requirements) expect(jd.slice(requirement.start, requirement.end)).toBe(requirement.quote)
    expect(analysis.extraction.requirements.find((r) => r.quote.startsWith('5+'))).toMatchObject({ assessment: 'gap' })
    expect(analysis.extraction.requirements.find((r) => r.quote.startsWith('Must be'))).toMatchObject({ assessment: 'met' })
    expect(calls).toEqual(['requirementExtraction'])
    expect(inputs.join('\n')).not.toContain('private-secret@example.test')
    expect(inputs.join('\n')).not.toContain('PRIVATE_PROFILE_MARKER')
    sqlite.close()
  })

  it('gives the model one repair attempt when its first reply is unusable, showing it the problem', async () => {
    const { sqlite, post, job, calls, inputs } = await setup(false, false, undefined, undefined, null, 1)
    expect((await post(`/api/jobs/${job.id}/extract`)).status).toBe(202)
    await waitFor(sqlite, 'extract', 'done')
    expect(calls).toEqual(['requirementExtraction', 'requirementExtraction'])
    expect(inputs[1]).toContain('Your previous reply could not be used')
    expect(inputs[1]).toContain('did not return valid JSON')
    sqlite.close()
  })

  it('fails the run, with a clear message, when the repair attempt is also unusable', async () => {
    const { sqlite, post, job, calls } = await setup(false, false, undefined, undefined, null, 2)
    expect((await post(`/api/jobs/${job.id}/extract`)).status).toBe(202)
    const failed = await waitFor(sqlite, 'extract', 'failed')
    expect(failed.error).toContain('did not return valid JSON')
    expect(calls).toEqual(['requirementExtraction', 'requirementExtraction'])
    sqlite.close()
  })

  it('resumes a failed step, preserves earlier checkpoints, and blocks an unsupported model claim', async () => {
    const { sqlite, post, request, job, calls, inputs } = await setup(false, true)
    expect((await post(`/api/jobs/${job.id}/extract`)).status).toBe(202)
    await waitFor(sqlite, 'extract', 'done')
    const estimate = await (await request(`/api/jobs/${job.id}/estimate?kind=tailor`)).json() as { estimatedUsd: number; allowed: boolean }
    expect(estimate).toMatchObject({ estimatedUsd: 0, allowed: true })
    expect((await post(`/api/jobs/${job.id}/tailor`)).status).toBe(202)
    const failed = await waitFor(sqlite, 'tailor', 'failed')
    expect(failed.error).toContain('Transient writing-review failure')
    expect((sqlite.prepare("SELECT COUNT(*) AS n FROM run_checkpoints WHERE run_id=? AND step='claims'").get(failed.id) as { n: number }).n).toBe(1)
    expect((await post(`/api/runs/${failed.id}/retry`)).status).toBe(202)
    await waitFor(sqlite, 'tailor', 'done')
    const analysis = await (await request(`/api/jobs/${job.id}/analysis`)).json() as { tailored: { lines: Array<{ verdict: string; layer1Flags: string[] }>; exportReady: boolean; gaps: unknown[] } }
    expect(analysis.tailored.exportReady).toBe(false)
    expect(analysis.tailored.lines[0].verdict).toBe('unsupported')
    expect(analysis.tailored.lines[0].layer1Flags.join(' ')).toContain('20%')
    expect(analysis.tailored.lines[0].layer1Flags.join(' ')).toContain('Rust')
    expect(calls.filter((task) => task === 'bulletScoring')).toHaveLength(1)
    expect(calls.filter((task) => task === 'resumeDrafting')).toHaveLength(1)
    expect(calls.filter((task) => task === 'claimVerification')).toHaveLength(1)
    expect(calls.filter((task) => task === 'antiSlop')).toHaveLength(2)
    expect(inputs.join('\n')).not.toContain('private-secret@example.test')
    expect(inputs.join('\n')).not.toContain('PRIVATE_PROFILE_MARKER')
    sqlite.close()
  })

  it('stops a paid run before inference when prices are missing or the cap is too low', async () => {
    const { dir, sqlite, post, job, calls } = await setup()
    const settings = defaultSettings()
    settings.taskModels.requirementExtraction = { provider: 'anthropic', model: 'claude-test' }
    settings.anthropicApiKey = 'test-only-key'
    await writeSettings(dir, settings)
    const missingPrice = await post(`/api/jobs/${job.id}/extract`)
    expect(missingPrice.status).toBe(422)
    expect((await missingPrice.json() as { error: string }).error).toContain('Set input and output prices')
    settings.modelPrices['claude-test'] = { inputPerMillion: 3, outputPerMillion: 15 }
    settings.costCapUsd = 0.0001
    await writeSettings(dir, settings)
    const overCap = await post(`/api/jobs/${job.id}/extract`)
    expect(overCap.status).toBe(422)
    expect((await overCap.json() as { error: string }).error).toContain('exceeds')
    expect(calls).toHaveLength(0)
    sqlite.close()
  })

  it('blocks a subtle unsupported scope claim even when Layer 1 finds no new number or tool', async () => {
    const { sqlite, post, request, job } = await setup(false, false, 'Led engineering strategy for a global platform', 'unsupported')
    await post(`/api/jobs/${job.id}/extract`)
    await waitFor(sqlite, 'extract', 'done')
    await post(`/api/jobs/${job.id}/tailor`)
    await waitFor(sqlite, 'tailor', 'done')
    const analysis = await (await request(`/api/jobs/${job.id}/analysis`)).json() as { tailored: { exportReady: boolean; lines: Array<{ verdict: string; layer1Flags: string[] }> } }
    expect(analysis.tailored.lines[0].layer1Flags).toEqual([])
    expect(analysis.tailored.lines[0].verdict).toBe('unsupported')
    expect(analysis.tailored.exportReady).toBe(false)
    sqlite.close()
  })

  it('uses paid-model token counting to stop a run before completion when actual input is larger than estimated', async () => {
    const { dir, sqlite, post, job, calls } = await setup(false, false, undefined, 'grounded', 10_000)
    const settings = defaultSettings()
    settings.taskModels.requirementExtraction = { provider: 'anthropic', model: 'claude-test' }
    settings.anthropicApiKey = 'test-only-key'
    settings.modelPrices['claude-test'] = { inputPerMillion: 3, outputPerMillion: 5 }
    settings.costCapUsd = 0.04
    await writeSettings(dir, settings)
    expect((await post(`/api/jobs/${job.id}/extract`)).status).toBe(202)
    const failed = await waitFor(sqlite, 'extract', 'failed')
    expect(failed.error).toContain('Token-counted cost could exceed')
    expect(calls).toHaveLength(0)
    sqlite.close()
  })
  it('scores the largest 16-bullet shortlist in bounded batches before completing a draft', async () => {
    const { sqlite, post, job, calls, inputs } = await setup(false, false, 'Reduced API latency by 15% using TypeScript')
    const master = readMaster(sqlite).document
    const source = master.roles[0].bullets[0]
    master.roles[0].bullets = Array.from({ length: 16 }, (_, index) => ({ ...source, id: index === 0 ? source.id : randomUUID(), text: `${source.text}. ${'Maintained application services. '.repeat(45)}` }))
    saveMaster(sqlite, master)
    await post(`/api/jobs/${job.id}/extract`); await waitFor(sqlite, 'extract', 'done')
    await post(`/api/jobs/${job.id}/tailor`); await waitFor(sqlite, 'tailor', 'done')
    const scoring = inputs.filter((_input, index) => calls[index] === 'bulletScoring').map((input) => JSON.parse(input))
    expect(scoring).toHaveLength(4)
    expect(scoring.map((input) => input.bullets.length)).toEqual([4, 4, 4, 4])
    expect(new Set(scoring.flatMap((input) => input.bullets.map((bullet: { id: string }) => bullet.id))).size).toBe(16)
    sqlite.close()
  })

  it('refuses to retry a failed run while another run of the same kind is already waiting for that job', async () => {
    const { sqlite, post, job } = await setup()
    const failedId = randomUUID(), now = new Date().toISOString()
    const insert = sqlite.prepare('INSERT INTO runs(id,job_id,kind,status,step,created_at) VALUES(?,?,?,?,?,?)')
    insert.run(failedId, job.id, 'extract', 'failed', 'queued', now)
    insert.run(randomUUID(), job.id, 'extract', 'queued', 'queued', now)
    const response = await post(`/api/runs/${failedId}/retry`)
    expect(response.status).toBe(409)
    expect((await response.json() as { error: string }).error).toMatch(/already queued or running/)
    expect((sqlite.prepare('SELECT status FROM runs WHERE id=?').get(failedId) as { status: string }).status).toBe('failed')
    sqlite.close()
  })

  it('refuses paid work that would pass the monthly cap, counting spend from earlier runs this month', async () => {
    const { dir, sqlite, post, request, job, calls } = await setup()
    const settings = defaultSettings()
    settings.taskModels.requirementExtraction = { provider: 'anthropic', model: 'claude-test' }
    settings.anthropicApiKey = 'test-only-key'
    settings.modelPrices['claude-test'] = { inputPerMillion: 3, outputPerMillion: 15 }
    settings.costCapUsd = 1
    settings.monthlyCapUsd = 20
    await writeSettings(dir, settings)
    expect(await (await request(`/api/jobs/${job.id}/estimate?kind=extract`)).json()).toMatchObject({ allowed: true, monthlyCapUsd: 20, spentThisMonthUsd: 0 })
    sqlite.prepare('INSERT INTO runs(id,kind,status,step,usage,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(), 'tailor', 'done', 'complete', JSON.stringify({ totalUsd: 19.99, calls: [] }), new Date().toISOString())
    const blocked = await post(`/api/jobs/${job.id}/extract`)
    expect(blocked.status).toBe(422)
    expect((await blocked.json() as { error: string }).error).toMatch(/monthly cap/)
    expect(await (await request(`/api/jobs/${job.id}/estimate?kind=extract`)).json()).toMatchObject({ allowed: false, spentThisMonthUsd: 19.99 })
    expect(calls).toHaveLength(0)
    sqlite.close()
  })

  it('ignores spend from earlier months and never blocks a local model', async () => {
    const { dir, sqlite, post, request, job } = await setup()
    sqlite.prepare('INSERT INTO runs(id,kind,status,step,usage,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(), 'tailor', 'done', 'complete', JSON.stringify({ totalUsd: 500, calls: [] }), '2020-01-15T00:00:00.000Z')
    expect(await (await request(`/api/jobs/${job.id}/estimate?kind=extract`)).json()).toMatchObject({ spentThisMonthUsd: 0 })
    const settings = defaultSettings(); settings.monthlyCapUsd = 1
    await writeSettings(dir, settings)
    sqlite.prepare('INSERT INTO runs(id,kind,status,step,usage,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(), 'tailor', 'done', 'complete', JSON.stringify({ totalUsd: 50, calls: [] }), new Date().toISOString())
    expect((await post(`/api/jobs/${job.id}/extract`)).status).toBe(202)
    await waitFor(sqlite, 'extract', 'done')
    sqlite.close()
  })
})

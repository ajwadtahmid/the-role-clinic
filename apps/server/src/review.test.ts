import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createApp } from './app.js'
import { createDatabase } from './db.js'
import { saveMaster, saveProfile, snapshotMaster } from './master.js'
import { defaultSettings, writeSettings } from './settings.js'
import { emptyMaster, emptyProfile, type ReviewWorkspace, type ResumeBlock, type TaskName } from '../../../packages/shared/src/index.js'
import { checkReadingOrder, renderPdf } from './resume-output.js'
import type { ModelRequest } from './model-adapters.js'

const fixtures: Array<{ directory: string; sqlite: ReturnType<typeof createDatabase>['sqlite'] }> = []
afterEach(async () => { for (const { directory, sqlite } of fixtures.splice(0)) { if (sqlite.open) sqlite.close(); await rm(directory, { recursive: true, force: true }) } })
export async function reviewFixture(hold = false) {
  const directory = await mkdtemp(join(tmpdir(), 'clinic-review-')), { sqlite, db } = createDatabase(directory)
  fixtures.push({ directory, sqlite })
  const master = emptyMaster(), sectionId = randomUUID(), bulletId = randomUUID(), replacementId = randomUUID(), projectId = randomUUID()
  const bullet = (id: string, text: string) => ({ id, rev: 1, text, skills: [], metrics: [], verbs: [], sourceRef: 'fixture' })
  master.roles.push({ id: sectionId, company: 'Acme', title: 'Engineer', start: '2024', end: 'Present', bullets: [bullet(bulletId, 'Reduced API latency by 15% using TypeScript'), bullet(replacementId, 'Built a deployment pipeline using TypeScript')] })
  master.projects.push({ id: projectId, name: 'Personal app', stack: [], start: '', end: '', summary: '', bullets: [bullet(randomUUID(), 'Built a personal database app')] })
  master.skills.push({ name: 'TypeScript', category: 'Languages', evidenceIds: [bulletId] })
  master.education.push({ id: randomUUID(), school: 'Example University', credential: 'BS', field: 'Computer Science', start: '', end: '', details: '' })
  saveMaster(sqlite, master); saveProfile(sqlite, { ...emptyProfile(), name: 'Jane Example', email: 'jane@example.test', workAuthorization: 'PRIVATE_AUTH_MARKER', notes: 'PRIVATE_NOTE_MARKER' })
  const jobId = randomUUID(), runId = randomUUID(), outId = randomUUID(), now = new Date().toISOString()
  sqlite.prepare('INSERT INTO jobs(id,company,title,captured_at,raw_snapshot,text) VALUES(?,?,?,?,?,?)').run(jobId, 'Target / Company', 'Software Engineer', now, 'Original posting', 'TypeScript software engineering job description with reliable systems.')
  sqlite.prepare('INSERT INTO runs(id,job_id,kind,status,step,created_at) VALUES(?,?,?,?,?,?)').run(runId, jobId, 'tailor', 'done', 'complete', now)
  const snapshotHash = snapshotMaster(sqlite)
  const document = { jobId, runId, snapshotHash, summary: null, skillsLine: ['TypeScript'], lines: [{ outId, text: 'Reduced API latency by 20% using TypeScript', sourceIds: [bulletId], author: 'model', verdict: 'unsupported', layer1Flags: ['New or changed number: 20%'], layer2Reason: 'Changed metric', slopFlags: [] }], scores: [{ bulletId: replacementId, score: 80, requirementIds: [], rationale: 'Useful deployment evidence.' }], gaps: [], exportReady: false }
  sqlite.prepare('INSERT INTO tailored(id,job_id,run_id,snapshot_hash,document,created_at) VALUES(?,?,?,?,?,?)').run(runId, jobId, runId, snapshotHash, JSON.stringify(document), now)
  let release = () => {}, gate = hold ? new Promise<void>((resolve) => { release = resolve }) : Promise.resolve()
  const inputs: string[] = []
  const modelRouter = { async complete(task: TaskName, request: ModelRequest) {
    inputs.push(request.user); await gate
    if (task !== 'claimVerification') throw new Error('Unexpected model task')
    const input = JSON.parse(request.user) as { lines: Array<{ outId: string }> }
    return { text: JSON.stringify({ verdicts: input.lines.map((line) => ({ outId: line.outId, verdict: 'grounded', reason: 'Matches cited evidence.' })) }), provider: 'ollama' as const, model: 'fake-local', usage: { inputTokens: 100, outputTokens: 50 } }
  } }
  const app = createApp({ dataDirectory: directory, sqlite, db, port: 3000, modelRouter })
  const request = (path: string, init: RequestInit = {}) => app.request(`http://127.0.0.1:3000${path}`, { ...init, headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' } })
  const base = `/api/jobs/${jobId}/review`
  const load = async () => await (await request(base)).json() as ReviewWorkspace
  const edit = async (action: unknown, revision?: number) => request(base, { method: 'PUT', body: JSON.stringify({ runId, revision: revision ?? (await load()).review.revision, action }) })
  const post = (suffix: string, value: unknown) => request(`${base}/${suffix}`, { method: 'POST', body: JSON.stringify(value) })
  return { directory, sqlite, master, sectionId, projectId, bulletId, replacementId, jobId, runId, outId, request, base, load, edit, post, inputs, release }
}
async function finished(sqlite: ReturnType<typeof createDatabase>['sqlite']) {
  for (let i = 0; i < 100; i++) {
    if (!sqlite.prepare("SELECT 1 FROM runs WHERE status IN ('queued','running')").get()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Verification did not finish')
}

describe('Phase 5 review and exports', () => {
  it('persists decisions, rejects stale changes and uses frozen evidence after the master changes', async () => {
    const f = await reviewFixture(), initial = await f.load()
    expect(initial.review.lines[0].decision).toBe('pending')
    expect((await f.edit({ kind: 'decision', outId: f.outId, decision: 'accepted' }, 1)).status).toBe(200)
    expect((await f.edit({ kind: 'decision', outId: f.outId, decision: 'rejected' }, 1)).status).toBe(409)
    expect((await f.load()).exportReady).toBe(false)
    f.master.roles[0].bullets[0].text = 'Unrelated replacement master text'; saveMaster(f.sqlite, f.master)
    expect((await f.load()).review.master.roles[0].bullets[0].text).toContain('15%')
    const version = (await f.load()).review
    expect((await f.post('export', { runId: f.runId, revision: version.revision, format: 'pdf' })).status).toBe(422)
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM artifacts').get()).toEqual({ n: 0 })
  })
  it('offers a same-section source replacement, preserves original suggestions and rechecks edited user claims', async () => {
    const f = await reviewFixture()
    await f.edit({ kind: 'decision', outId: f.outId, decision: 'rejected' })
    let state = await f.load()
    expect(state.replacements[0].id).toBe(f.replacementId)
    expect((await f.edit({ kind: 'replace', outId: f.outId, bulletId: f.replacementId })).status).toBe(200)
    await finished(f.sqlite)
    state = await f.load()
    expect(state.review.lines[0]).toMatchObject({ author: 'user', decision: 'pending', verification: 'checked', text: 'Built a deployment pipeline using TypeScript', originalText: 'Reduced API latency by 20% using TypeScript' })
    await f.edit({ kind: 'edit', outId: f.outId, text: 'Built 99 deployment pipelines using TypeScript' })
    await finished(f.sqlite)
    await f.edit({ kind: 'decision', outId: f.outId, decision: 'accepted' })
    state = await f.load()
    expect(state.review.lines[0].layer1Flags.join(' ')).toContain('99')
    expect(state.exportReady).toBe(true)
    expect(f.inputs.join('')).not.toContain('PRIVATE_AUTH_MARKER')
    expect(f.inputs.join('')).not.toContain('jane@example.test')
    expect((await f.edit({ kind: 'add-to-master', outId: f.outId, sectionId: f.sectionId })).status).toBe(200)
    await finished(f.sqlite)
    state = await f.load()
    expect(state.review.snapshotHash).not.toBe(JSON.parse((f.sqlite.prepare('SELECT document FROM tailored').get() as { document: string }).document).snapshotHash)
    expect(state.review.master.roles[0].bullets).toHaveLength(3)
    expect(state.review.lines[0].layer1Flags).toEqual([])
  })
  it('never applies a delayed verdict to different text and preserves decisions made during verification', async () => {
    const f = await reviewFixture(true)
    await f.edit({ kind: 'edit', outId: f.outId, text: 'Reduced API latency by 15% using TypeScript' })
    await f.edit({ kind: 'decision', outId: f.outId, decision: 'accepted' })
    f.release(); await finished(f.sqlite)
    expect((await f.load()).review.lines[0]).toMatchObject({ verification: 'checked', decision: 'accepted', verdict: 'grounded' })
  })
  it('queues the latest text after an edit made during a call', async () => {
    const f = await reviewFixture(true)
    await f.edit({ kind: 'edit', outId: f.outId, text: 'Reduced API latency by 15% using TypeScript' })
    await f.edit({ kind: 'edit', outId: f.outId, text: 'Reduced API latency by 70% using TypeScript' })
    f.release(); await finished(f.sqlite)
    expect((await f.load()).review.lines[0]).toMatchObject({ verification: 'checked', verdict: 'unsupported', text: 'Reduced API latency by 70% using TypeScript' })
  })
  it('keeps edits saved when a paid verifier has no configured prices', async () => {
    const f = await reviewFixture(), settings = defaultSettings()
    settings.taskModels.claimVerification = { provider: 'anthropic', model: 'unpriced' }; await writeSettings(f.directory, settings)
    const response = await f.edit({ kind: 'edit', outId: f.outId, text: 'Reduced API latency by 15% using TypeScript' })
    const state = await response.json() as ReviewWorkspace
    expect(response.status).toBe(200); expect(state.verificationError).toContain('prices')
    expect(state.review.lines[0].verification).toBe('pending'); expect(f.inputs).toEqual([])
  })
  it('renders real text PDF and DOCX, checks reading order, records immutable artifacts and freezes the selected submitted version', async () => {
    const f = await reviewFixture()
    await f.edit({ kind: 'edit', outId: f.outId, text: 'Reduced API latency by 15% using TypeScript' }); await finished(f.sqlite)
    await f.edit({ kind: 'decision', outId: f.outId, decision: 'accepted' })
    const state = await f.load(), version = { runId: f.runId, revision: state.review.revision }
    const previewResponse = await f.post('preview', version)
    expect(previewResponse.status).toBe(200)
    const preview = await previewResponse.json() as { pages: number; lastPagePercent: number; parseCheck: { ok: boolean }; pdfBase64: string }
    expect(preview.pages).toBe(1); expect(preview.lastPagePercent).toBeGreaterThan(0); expect(preview.parseCheck.ok).toBe(true)
    expect(Buffer.from(preview.pdfBase64, 'base64').subarray(0, 5).toString()).toBe('%PDF-')
    const exports = []
    for (const format of ['docx', 'pdf']) {
      const response = await f.post('export', { ...version, format })
      expect(response.status).toBe(201)
      const artifact = await response.json() as { id: string; filename: string; downloadUrl: string; parseCheck: { ok: boolean } }; exports.push(artifact)
      expect(artifact.parseCheck.ok).toBe(true); expect(artifact.filename).not.toContain('/')
      const download = await f.request(artifact.downloadUrl), bytes = Buffer.from(await download.arrayBuffer())
      expect(bytes.subarray(0, format === 'pdf' ? 5 : 2).toString()).toBe(format === 'pdf' ? '%PDF-' : 'PK')
    }
    const row = f.sqlite.prepare('SELECT file_path,document FROM artifacts WHERE id=?').get(exports[0].id) as { file_path: string; document: string }
    expect((await stat(row.file_path)).mode & 0o777).toBe(0o600)
    expect(row.document).not.toContain('PRIVATE_AUTH_MARKER'); expect(row.document).not.toContain('PRIVATE_NOTE_MARKER')
    const status = await f.request(`/api/jobs/${f.jobId}/status`, { method: 'PUT', body: JSON.stringify({ status: 'applied', submittedArtifactId: exports[0].id }) })
    expect(status.status).toBe(200)
    await f.edit({ kind: 'decision', outId: f.outId, decision: 'rejected' })
    const application = f.sqlite.prepare('SELECT submitted_text,submitted_artifact_id FROM applications').get() as { submitted_text: string; submitted_artifact_id: string }
    expect(application.submitted_text).toContain('15%'); expect(application.submitted_artifact_id).toBe(exports[0].id)
    expect((await f.request(`/api/jobs/${f.jobId}/status`, { method: 'PUT', body: JSON.stringify({ status: 'applied', submittedArtifactId: exports[1].id }) })).status).toBe(409)
  })
  it('measures actual multi-page PDF output and catches missing or reordered lines', async () => {
    const blocks: ResumeBlock[] = Array.from({ length: 60 }, (_, i) => ({ id: `${i}`, kind: 'bullet', text: `Built service number ${i} with a reliable deployment pipeline, database integration, TypeScript and automated tests for customer-facing application features.` }))
    const result = await renderPdf(blocks)
    expect(result.pages).toBeGreaterThan(1); expect(result.parseCheck.ok).toBe(true)
    expect(checkReadingOrder(blocks.slice(0, 2), `${blocks[1].text}\n${blocks[0].text}`).ok).toBe(false)
    expect(checkReadingOrder(blocks.slice(0, 2), blocks[0].text).missing).toEqual([blocks[1].text])
  })
})

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { serve } from '@hono/node-server'
import { fetch as nodeFetch, Request as NodeRequest, Response as NodeResponse, Headers as NodeHeaders } from 'undici'
import { createApp } from '../../server/src/app.js'
import { createDatabase } from '../../server/src/db.js'
import { saveMaster, saveProfile, snapshotMaster } from '../../server/src/master.js'
import { emptyMaster, emptyProfile, type TaskName } from '../../../packages/shared/src/index.js'
import type { ModelRequest } from '../../server/src/model-adapters.js'
import { TailoringWorkspace } from './tailoring-workspace.js'

// The renderer is checked with real PDFs in the server tests. A browser DOM in
// this process confuses PDFKit's Node loader; keep this UI test about the workflow.
vi.mock('../../server/src/resume-output.js', async (original) => {
  const actual = await original<typeof import('../../server/src/resume-output.js')>()
  return { ...actual, renderPdf: vi.fn(async () => ({ buffer: Buffer.from('%PDF-proof'), pages: 1, lastPagePercent: 45, parseCheck: { ok: true, missing: [] } })) }
})
const resources: Array<{ server: ReturnType<typeof serve>; sqlite: ReturnType<typeof createDatabase>['sqlite']; directory: string }> = []
afterEach(async () => {
  cleanup()
  for (const { server, sqlite, directory } of resources.splice(0)) { await new Promise<void>((resolve) => server.close(() => resolve())); sqlite.close(); await rm(directory, { recursive: true, force: true }) }
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'clinic-review-ui-')), { sqlite, db } = createDatabase(directory)
  const master = emptyMaster(), sectionId = randomUUID(), bulletId = randomUUID(), jobId = randomUUID(), runId = randomUUID(), outId = randomUUID(), now = new Date().toISOString()
  master.roles.push({ id: sectionId, company: 'Acme', title: 'Engineer', start: '2024', end: 'Present', bullets: [{ id: bulletId, rev: 1, text: 'Reduced API latency by 15%', skills: [], metrics: [], verbs: [], sourceRef: '' }] })
  saveMaster(sqlite, master); saveProfile(sqlite, { ...emptyProfile(), name: 'Jane Example', email: 'jane@example.test' })
  sqlite.prepare('INSERT INTO jobs(id,company,title,captured_at,raw_snapshot,text) VALUES(?,?,?,?,?,?)').run(jobId, 'Target', 'Engineer', now, 'Original', 'Build and maintain reliable software applications with a team.')
  sqlite.prepare('INSERT INTO runs(id,job_id,kind,status,step,created_at) VALUES(?,?,?,?,?,?)').run(runId, jobId, 'tailor', 'done', 'complete', now)
  const hash = snapshotMaster(sqlite)
  sqlite.prepare('INSERT INTO tailored(id,job_id,run_id,snapshot_hash,document,created_at) VALUES(?,?,?,?,?,?)').run(runId, jobId, runId, hash, JSON.stringify({ jobId, runId, snapshotHash: hash, summary: null, skillsLine: [], lines: [{ outId, text: 'Reduced API latency by 20%', sourceIds: [bulletId], author: 'model', verdict: 'unsupported', layer1Flags: ['New or changed number: 20%'], layer2Reason: 'Changed metric', slopFlags: [] }], scores: [], gaps: [], exportReady: false }), now)
  vi.stubGlobal('Request', NodeRequest); vi.stubGlobal('Response', NodeResponse); vi.stubGlobal('Headers', NodeHeaders)
  const reservation = createServer()
  const port = await new Promise<number>((resolve, reject) => { reservation.on('error', reject); reservation.listen(0, '127.0.0.1', () => resolve((reservation.address() as { port: number }).port)) })
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  const modelRouter = { async complete(task: TaskName, request: ModelRequest) {
    expect(task).toBe('claimVerification')
    const value = JSON.parse(request.user) as { lines: Array<{ outId: string }> }
    return { text: JSON.stringify({ verdicts: value.lines.map((line) => ({ outId: line.outId, verdict: 'grounded', reason: 'Source matches.' })) }), provider: 'ollama' as const, model: 'fake-local' }
  } }
  const app = createApp({ dataDirectory: directory, sqlite, db, port, modelRouter })
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }); resources.push({ server, sqlite, directory })
  await new Promise<void>((resolve, reject) => { server.on('error', reject); server.on('listening', resolve) })
  ;(window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(`http://127.0.0.1:${port}/`)
  vi.stubGlobal('fetch', (input: string, init: RequestInit = {}) => nodeFetch(`http://127.0.0.1:${port}${input}`, { ...init, headers: { origin: `http://127.0.0.1:${port}`, ...init.headers } } as Parameters<typeof nodeFetch>[1]))
  const applied = vi.fn(), user = userEvent.setup()
  render(<TailoringWorkspace jobId={jobId} company="Target" title="Engineer" onApplied={applied} />)
  return { sqlite, jobId, outId, applied, user }
}

describe('review UI', () => {
  it('reviews an unsupported line, saves corrected wording, previews, exports and explicitly freezes the submitted file', async () => {
    const { sqlite, user, applied } = await setup()
    // A model-written line that is not in the résumé cannot be accepted, only reworded or rejected.
    await screen.findByText(/Cannot be exported/)
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull()
    const exportButton = screen.getByRole('button', { name: 'Export DOCX' }) as HTMLButtonElement
    expect(exportButton.disabled).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const editor = screen.getByRole('textbox', { name: 'Edit résumé line' })
    await user.clear(editor); await user.type(editor, 'Reduced API latency by 15%')
    await user.click(screen.getByRole('button', { name: 'Save wording' }))
    await waitFor(() => expect(exportButton.disabled).toBe(false))
    await screen.findByText(/1 page · last page 45% used · text check passed/)
    expect(within(screen.getByLabelText('Accepted résumé preview')).getByText('• Reduced API latency by 15%')).toBeTruthy()
    await user.click(exportButton)
    await screen.findByRole('link', { name: /Download Jane-Example-Target-Engineer.docx/ })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM artifacts').get()).toEqual({ n: 1 })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM applications').get()).toEqual({ n: 0 })
    await user.click(screen.getByText('Profile & application answers · copy into application forms'))
    await user.type(screen.getByRole('textbox', { name: 'Application question' }), 'Why this role?')
    await user.type(screen.getByRole('textbox', { name: 'Application answer' }), 'I enjoy building reliable systems.')
    await user.click(screen.getByRole('button', { name: 'Add application answer' }))
    await screen.findByText('Answer saved.')
    // The export offers the next step right where it finished, instead of in a drawer further down.
    await user.click(screen.getByRole('button', { name: 'Mark as applied' }))
    const mark = screen.getByRole('button', { name: 'Mark as applied with this export' }) as HTMLButtonElement
    expect(mark.disabled).toBe(true)
    await user.click(screen.getByRole('checkbox', { name: 'I submitted this exported version.' }))
    await user.click(mark)
    await waitFor(() => expect(applied).toHaveBeenCalledOnce())
    expect(sqlite.prepare('SELECT submitted_answer FROM job_answers').get()).toEqual({ submitted_answer: 'I enjoy building reliable systems.' })
    expect((sqlite.prepare('SELECT submitted_text FROM applications').get() as { submitted_text: string }).submitted_text).toContain('15%')
  })
})

import type Database from 'better-sqlite3'
import type { PipelineService } from './pipeline.js'
import { readSettings } from './settings.js'
import { aiActive, resolveAiFeatures } from './ai-features.js'

export type FitBatchState = { running: boolean; paused: boolean; total: number; done: number; failed: number; message: string }
const idle: FitBatchState = { running: false, paused: false, total: 0, done: 0, failed: 0, message: '' }
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Fit checks for every job in To review or Saved that has none yet, one at a time, started by the user (or by the
// automatic setting). It enqueues the next check only when the queue holds no tailoring, so tailoring never waits behind more
// than the check already running, and it stops on the first spending-cap refusal.
export class FitBatch {
  private state: FitBatchState = { ...idle }
  private stopping = false

  constructor(private sqlite: Database.Database, private dataDirectory: string, private pipeline: PipelineService, private pollMs = 400) {}

  status(): FitBatchState { return { ...this.state } }

  // Jobs still waiting for a first fit check.
  waiting(): string[] {
    return (this.sqlite.prepare(`SELECT j.id FROM jobs j LEFT JOIN applications a ON a.job_id=j.id
      WHERE COALESCE(a.status,'new') IN ('new','saved')
        AND NOT EXISTS (SELECT 1 FROM requirements r WHERE r.job_id=j.id)
        AND NOT EXISTS (SELECT 1 FROM runs u WHERE u.job_id=j.id AND u.kind='extract' AND u.status IN ('queued','running'))
      ORDER BY j.captured_at DESC`).all() as Array<{ id: string }>).map((row) => row.id)
  }

  // Jobs checked before the local model matched bullets to requirements: their stored check has no suggestions field.
  // They are checked again only when every model involved runs on this computer, so a refresh never spends money.
  async stale(): Promise<string[]> {
    const settings = await readSettings(this.dataDirectory)
    if (settings.taskModels.requirementExtraction.provider !== 'ollama' || settings.taskModels.bulletScoring.provider !== 'ollama') return []
    return (this.sqlite.prepare(`SELECT j.id FROM jobs j LEFT JOIN applications a ON a.job_id=j.id
      WHERE COALESCE(a.status,'new') IN ('new','saved')
        AND (SELECT r.document FROM requirements r WHERE r.job_id=j.id ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1) NOT LIKE '%"suggestions"%'
        AND NOT EXISTS (SELECT 1 FROM runs u WHERE u.job_id=j.id AND u.kind='extract' AND u.status IN ('queued','running'))
      ORDER BY j.captured_at DESC`).all() as Array<{ id: string }>).map((row) => row.id)
  }

  async preview() {
    const fresh = this.waiting(), refresh = await this.stale(), ids = [...fresh, ...refresh], settings = await readSettings(this.dataDirectory)
    const provider = settings.taskModels.requirementExtraction.provider
    let estimatedUsd: number | null = null, allowed = true
    if (provider === 'anthropic' && ids.length) {
      try { const one = await this.pipeline.estimate(ids[0], 'extract'); estimatedUsd = Math.round(one.estimatedUsd * ids.length * 10_000) / 10_000; allowed = one.allowed && estimatedUsd <= one.capUsd * ids.length && one.spentThisMonthUsd + estimatedUsd <= one.monthlyCapUsd }
      catch { allowed = false }
    }
    return { count: ids.length, refresh: refresh.length, provider, estimatedUsd, allowed }
  }

  async start(includeRefresh = true): Promise<FitBatchState> {
    if (this.state.running) return this.status()
    const ids = [...this.waiting(), ...(includeRefresh ? await this.stale() : [])]
    this.stopping = false
    this.state = { running: ids.length > 0, paused: false, total: ids.length, done: 0, failed: 0, message: ids.length ? '' : 'Every job already has a fit check.' }
    if (ids.length) void this.run(ids).catch((error) => { this.state = { ...this.state, running: false, message: (error as Error).message } })
    return this.status()
  }

  // Starts only when the user chose automatic checks and the check runs on this computer.
  async maybeStart() {
    const settings = await readSettings(this.dataDirectory)
    if (settings.autoFitCheck && settings.taskModels.requirementExtraction.provider === 'ollama' && aiActive(resolveAiFeatures(this.sqlite, this.dataDirectory, settings))) await this.start(false)
  }

  stop(): FitBatchState {
    this.stopping = true
    if (this.state.running) this.state = { ...this.state, message: 'Stopping after the check in progress.' }
    return this.status()
  }

  private tailoring() { return Boolean(this.sqlite.prepare("SELECT 1 FROM runs WHERE kind IN ('tailor','reverify') AND status IN ('queued','running') LIMIT 1").get()) }

  private async run(ids: string[]) {
    for (const id of ids) {
      while (!this.stopping && this.tailoring()) { this.state = { ...this.state, paused: true }; await wait(this.pollMs) }
      if (this.stopping) break
      this.state = { ...this.state, paused: false }
      let runId: string
      try { runId = (await this.pipeline.enqueueExtract(id, true)).id }
      catch (error) {
        const message = (error as Error).message
        // A cap refusal ends the batch; a job that cannot be checked (removed, no text) is skipped.
        if (/cap/i.test(message)) { this.state = { ...this.state, running: false, paused: false, message }; return }
        this.state = { ...this.state, failed: this.state.failed + 1 }; continue
      }
      for (;;) {
        const row = this.sqlite.prepare('SELECT status FROM runs WHERE id=?').get(runId) as { status: string } | undefined
        if (!row || row.status === 'done') { this.state = { ...this.state, done: this.state.done + 1 }; break }
        if (row.status === 'failed' || row.status === 'cancelled') { this.state = { ...this.state, failed: this.state.failed + 1 }; break }
        await wait(this.pollMs)
      }
    }
    const { done, failed, total } = this.state
    this.state = { ...this.state, running: false, paused: false, message: this.stopping ? `Stopped. ${done} of ${total} checked.` : failed ? `Checked ${done} of ${total}. ${failed} could not be checked.` : `Checked ${done} job${done === 1 ? '' : 's'}.` }
  }
}

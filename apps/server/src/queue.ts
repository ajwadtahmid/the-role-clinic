import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { eq } from 'drizzle-orm'
import type { ClinicDatabase } from './db.js'
import { runs } from './schema.js'
import type { RunEvent, RunStatus } from '../../../packages/shared/src/index.js'

export interface RunRecord {
  id: string
  kind: 'demo' | 'extract' | 'tailor' | 'reverify'
  jobId?: string
  status: RunStatus
  step: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
  message?: string
  quiet?: boolean
}
export interface RunContext { progress(step: string, message: string): void }
type Work = (run: RunRecord, context: RunContext) => Promise<void>
type QueuedTask = { run: RunRecord; work?: Work }

export class SerialRunQueue {
  private pending: QueuedTask[] = []
  private active = false
  private eventId = 0
  private recent: RunEvent[] = []
  private emitter = new EventEmitter()

  constructor(private db: ClinicDatabase) {}

  enqueueDemo(): RunRecord { return this.enqueue('demo') }
  enqueueWork(kind: 'extract' | 'tailor' | 'reverify', jobId: string, work: Work, quiet = false): RunRecord { return this.enqueue(kind, jobId, work, quiet) }

  retryWork(run: RunRecord, work: Work): RunRecord {
    if (run.status !== 'failed') throw new Error('Only failed runs can be retried.')
    run.status = 'queued'; run.step = 'queued'; run.finishedAt = undefined
    this.db.update(runs).set({ status: 'queued', step: 'queued', error: null, finishedAt: null }).where(eq(runs.id, run.id)).run()
    this.pending.push({ run, work }); this.publish(run, 'Retry queued from the last saved step.')
    void this.drain().catch((error) => console.error(`[queue] worker stopped unexpectedly: ${(error as Error).message}`))
    return run
  }

  getEventsAfter(id: number): RunEvent[] { return this.recent.filter((event) => event.id > id) }
  subscribe(listener: (event: RunEvent) => void): () => void { this.emitter.on('event', listener); return () => this.emitter.off('event', listener) }

  private enqueue(kind: RunRecord['kind'], jobId?: string, work?: Work, quiet = false): RunRecord {
    const run: RunRecord = { id: randomUUID(), kind, jobId, status: 'queued', step: 'queued', createdAt: new Date().toISOString(), ...(quiet ? { quiet } : {}) }
    this.db.insert(runs).values({ id: run.id, jobId, kind, status: run.status, step: run.step, promptVersions: '{}', createdAt: run.createdAt }).run()
    this.pending.push({ run, work })
    this.publish(run, kind === 'demo' ? 'Infrastructure test queued; no résumé work will run.' : `${kind} queued.`)
    void this.drain().catch((error) => console.error(`[queue] worker stopped unexpectedly: ${(error as Error).message}`))
    return run
  }

  private publish(run: RunRecord, message?: string): void {
    const event: RunEvent = { id: ++this.eventId, runId: run.id, jobId: run.jobId, kind: run.kind, status: run.status, step: run.step, message, ...(run.quiet ? { quiet: true } : {}), timestamp: new Date().toISOString() }
    this.recent.push(event)
    if (this.recent.length > 200) this.recent.shift()
    this.emitter.emit('event', event)
  }

  private async drain(): Promise<void> {
    if (this.active) return
    this.active = true
    try {
      while (this.pending.length) {
        const { run, work } = this.pending.shift()!
        run.status = 'running'; run.step = work ? 'starting' : 'queue-smoke-test'; run.startedAt = new Date().toISOString()
        try {
          this.db.update(runs).set({ status: run.status, step: run.step, startedAt: run.startedAt }).where(eq(runs.id, run.id)).run()
          this.publish(run, 'Queue worker started.')
          if (work) await work(run, { progress: (step, message) => {
            run.step = step
            this.db.update(runs).set({ step }).where(eq(runs.id, run.id)).run()
            this.publish(run, message)
          } })
          else await new Promise((resolve) => setTimeout(resolve, 20))
          run.status = 'done'; run.step = 'complete'; run.finishedAt = new Date().toISOString()
          run.message = work ? 'Run complete.' : 'Queue and event delivery verified; no extraction or tailoring was performed.'
          this.db.update(runs).set({ status: run.status, step: run.step, finishedAt: run.finishedAt }).where(eq(runs.id, run.id)).run()
          this.publish(run, run.message)
        } catch (error) {
          run.status = 'failed'; run.finishedAt = new Date().toISOString()
          run.message = error instanceof Error ? error.message : 'Run failed.'
          // A failing write here must not stop the worker or leave the queue stuck: report it and move on.
          try { this.db.update(runs).set({ status: 'failed', error: run.message, finishedAt: run.finishedAt }).where(eq(runs.id, run.id)).run() }
          catch (writeError) { console.error(`[queue] could not record the failure of run ${run.id}: ${(writeError as Error).message}`) }
          this.publish(run, run.message)
        }
      }
    } finally { this.active = false }
  }
}

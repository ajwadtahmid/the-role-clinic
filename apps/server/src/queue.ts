import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { eq } from 'drizzle-orm'
import type { ClinicDatabase } from './db.js'
import { runs } from './schema.js'
import type { RunEvent, RunStatus } from '../../../packages/shared/src/index.js'

export interface RunRecord {
  id: string
  kind: 'demo'
  status: RunStatus
  step: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
  message?: string
}

export class SerialRunQueue {
  private pending: RunRecord[] = []
  private active = false
  private eventId = 0
  private recent: RunEvent[] = []
  private emitter = new EventEmitter()

  constructor(private db: ClinicDatabase) {}

  enqueueDemo(): RunRecord {
    const run: RunRecord = { id: randomUUID(), kind: 'demo', status: 'queued', step: 'queued', createdAt: new Date().toISOString() }
    this.db.insert(runs).values({ id: run.id, kind: run.kind, status: run.status, step: run.step, promptVersions: '{}', createdAt: run.createdAt }).run()
    this.pending.push(run)
    this.publish(run, 'Infrastructure test queued; no résumé work will run.')
    void this.drain()
    return run
  }

  getEventsAfter(id: number): RunEvent[] { return this.recent.filter((event) => event.id > id) }
  subscribe(listener: (event: RunEvent) => void): () => void {
    this.emitter.on('event', listener)
    return () => this.emitter.off('event', listener)
  }

  private publish(run: RunRecord, message?: string): void {
    const event: RunEvent = { id: ++this.eventId, runId: run.id, status: run.status, step: run.step, message, timestamp: new Date().toISOString() }
    this.recent.push(event)
    if (this.recent.length > 200) this.recent.shift()
    this.emitter.emit('event', event)
  }

  private async drain(): Promise<void> {
    if (this.active) return
    this.active = true
    try {
      while (this.pending.length) {
        const run = this.pending.shift()!
        run.status = 'running'
        run.step = 'queue-smoke-test'
        run.startedAt = new Date().toISOString()
        this.db.update(runs).set({ status: run.status, step: run.step, startedAt: run.startedAt }).where(eq(runs.id, run.id)).run()
        this.publish(run, 'Queue worker started.')
        await new Promise((resolve) => setTimeout(resolve, 20))
        run.status = 'done'
        run.step = 'complete'
        run.finishedAt = new Date().toISOString()
        run.message = 'Queue and event delivery verified; no extraction or tailoring was performed.'
        this.db.update(runs).set({ status: run.status, step: run.step, finishedAt: run.finishedAt }).where(eq(runs.id, run.id)).run()
        this.publish(run, run.message)
      }
    } finally { this.active = false }
  }
}

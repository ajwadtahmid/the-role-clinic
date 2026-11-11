import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.js'
import { createDatabase } from './db.js'

const directories: string[] = []
async function fixture() {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'role-clinic-apply-')); directories.push(dataDirectory)
  const { sqlite, db } = createDatabase(dataDirectory), app = createApp({ dataDirectory, sqlite, db, port: 3000 })
  const call = (path: string, init: RequestInit = {}) => app.request(`http://127.0.0.1:3000${path}`, { ...init, headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'content-type': 'application/json', ...(init.headers ?? {}) } })
  const job = await (await call('/api/jobs', { method: 'POST', body: JSON.stringify({ company: 'Acme', title: 'Engineer', text: 'A posting long enough to be kept as the job description.' }) })).json() as { id: string }
  const status = (body: unknown) => call(`/api/jobs/${job.id}/status`, { method: 'PUT', body: JSON.stringify(body) })
  const row = () => sqlite.prepare('SELECT status,applied_at AS appliedAt,submitted_job_text AS jobText FROM applications WHERE job_id=?').get(job.id) as { status: string; appliedAt: string | null; jobText: string | null } | undefined
  const events = () => (sqlite.prepare('SELECT s.status FROM status_events s JOIN applications a ON a.id=s.application_id WHERE a.job_id=? ORDER BY s.created_at,s.rowid').all(job.id) as Array<{ status: string }>).map((e) => e.status)
  return { sqlite, call, job, status, row, events }
}
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })

describe('marking applied without a file, and undoing it', () => {
  it('records the job description when marked applied, and an undo puts everything back', async () => {
    const f = await fixture()
    expect((await f.status({ status: 'applied', submittedText: '' })).status).toBe(200)
    expect(f.row()).toMatchObject({ status: 'applied', jobText: 'A posting long enough to be kept as the job description.' })
    expect(f.row()?.appliedAt).toBeTruthy()
    expect((await f.status({ status: 'new', undoApplied: true })).status).toBe(200)
    expect(f.row()).toEqual({ status: 'new', appliedAt: null, jobText: null })
    expect(f.events()).not.toContain('applied')
    // Marking it again afterwards works as the first time.
    expect((await f.status({ status: 'applied', submittedText: '' })).status).toBe(200)
    expect(f.row()?.appliedAt).toBeTruthy()
    f.sqlite.close()
  })

  it('refuses to undo what is not a fresh, file-less application', async () => {
    const f = await fixture()
    expect((await f.status({ status: 'saved', undoApplied: true })).status).toBe(409)
    await f.status({ status: 'applied', submittedText: 'The résumé text I sent.' })
    expect((await f.status({ status: 'new', undoApplied: true })).status).toBe(409)
    expect((await f.status({ status: 'interviewing', undoApplied: true })).status).toBe(400)
    expect(f.row()?.status).toBe('applied')
    f.sqlite.close()
  })
})

describe('saving a job to track, without its description', () => {
  async function bare() {
    const f = await fixture()
    const call = (path: string, init: RequestInit = {}) => f.call(path, init)
    const created = await call('/api/jobs', { method: 'POST', body: JSON.stringify({ company: 'Globex', title: 'Analyst' }) })
    return { ...f, call, created, id: ((await created.clone().json()) as { id: string }).id }
  }
  it('needs only a company and a title, and adds the description later without ever replacing one', async () => {
    const f = await bare()
    expect(f.created.status).toBe(201)
    expect((await f.call('/api/jobs', { method: 'POST', body: JSON.stringify({ company: 'Globex' }) })).status).toBe(400)
    // No description yet, so a fit check refuses with a clear reason instead of failing later.
    const check = await f.call(`/api/jobs/${f.id}/extract`, { method: 'POST', body: '{}' })
    expect(check.ok).toBe(false); expect(JSON.stringify(await check.json())).toContain('job description')
    expect((await f.call(`/api/jobs/${f.id}/description`, { method: 'PUT', body: JSON.stringify({ text: 'too short' }) })).status).toBe(400)
    expect((await f.call(`/api/jobs/${f.id}/description`, { method: 'PUT', body: JSON.stringify({ text: 'You will build and run internal tools for the finance team.' }) })).status).toBe(200)
    expect((await f.call(`/api/jobs/${f.id}/description`, { method: 'PUT', body: JSON.stringify({ text: 'A different description that must not replace the first one.' }) })).status).toBe(409)
    expect((f.sqlite.prepare('SELECT text,raw_snapshot AS raw FROM jobs WHERE id=?').get(f.id) as { text: string; raw: string })).toEqual({ text: 'You will build and run internal tools for the finance team.', raw: 'You will build and run internal tools for the finance team.' })
    f.sqlite.close()
  })
  it('accepts today as the day applied early in the morning, and keeps the time from being later than now', async () => {
    const f = await bare()
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 10, 10, 7, 30))
    try {
      const apply = (body: unknown) => f.call(`/api/jobs/${f.id}/status`, { method: 'PUT', body: JSON.stringify(body) })
      expect((await apply({ status: 'applied', appliedAt: '2026-11-11', submittedText: '' })).status).toBe(400)
      expect((await apply({ status: 'applied', appliedAt: '2026-11-10', submittedText: '' })).status).toBe(200)
      expect(new Date((f.sqlite.prepare('SELECT applied_at AS at FROM applications WHERE job_id=?').get(f.id) as { at: string }).at).getTime()).toBeLessThanOrEqual(Date.now())
    } finally { vi.useRealTimers() }
    f.sqlite.close()
  })
  it('records a job as already applied on the day given, and refuses a future day', async () => {
    const f = await bare()
    const apply = (body: unknown) => f.call(`/api/jobs/${f.id}/status`, { method: 'PUT', body: JSON.stringify(body) })
    expect((await apply({ status: 'applied', appliedAt: '2999-01-01', submittedText: '' })).status).toBe(400)
    expect((await apply({ status: 'applied', appliedAt: '2026-11-02', submittedText: '' })).status).toBe(200)
    expect(((f.sqlite.prepare('SELECT applied_at AS at FROM applications WHERE job_id=?').get(f.id)) as { at: string }).at.slice(0, 10)).toBe('2026-11-02')
    f.sqlite.close()
  })
})


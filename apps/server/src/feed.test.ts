import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.js'
import { createDatabase } from './db.js'
import { defaultSettings, writeSettings } from './settings.js'
import { applyCleanup, fetchPostings, importRows, markImported, normalizeFeedUrl, parseCsv, planCleanup, readFeedFile, readFeedText, type PostingCapture } from './feed.js'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

const HEADER = 'Job Title,Company,Apply Link,Date Found,Date Posted,Priority,Location,Work Arrangement,Salary Range,Required Qualifications,Missing Skills / Flags,Why It Fits,Source,Notes'
const row = (title: string, company: string, url: string, found = '2026-11-01', extra: Partial<Record<string, string>> = {}) =>
  [title, company, url, found, extra.posted ?? '', extra.priority ?? 'High', extra.location ?? 'Remote', 'Remote', 'Not published', extra.required ?? 'Python and SQL', extra.flags ?? 'Citizenship; On-site', extra.why ?? 'WHY_IT_FITS_PRIVATE_MARKER', 'Careers page', ''].map((value) => /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value).join(',')

async function setup(csv?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'clinic-feed-')); dirs.push(dir)
  const { sqlite, db } = createDatabase(dir)
  const path = join(dir, 'jobs.csv')
  if (csv !== undefined) await writeFile(path, csv)
  const capture: PostingCapture = async (url) => ({ text: `Full posting for ${url}. ${'Responsibilities include building services. '.repeat(3)}`, rawSnapshot: '<html>full</html>', url, applyUrl: url })
  return { dir, sqlite, db, path, capture }
}

describe('feed CSV reading', () => {
  it('handles a byte-order mark, CRLF, quoted commas, quotes and embedded newlines', () => {
    const text = `﻿${HEADER}\r\n${row('Engineer, Platform', 'Acme', 'https://acme.test/jobs/1', '2026-11-01', { required: 'Line one\nLine "two", with comma' })}\r\n`
    const file = readFeedText(text)
    expect(file.missingColumns).toEqual([])
    expect(file.rows).toHaveLength(1)
    expect(file.rows[0]).toMatchObject({ title: 'Engineer, Platform', required: 'Line one\nLine "two", with comma', foundAt: '2026-11-01' })
  })
  it('counts rows missing a required value as invalid and reports missing columns', () => {
    const file = readFeedText(`${HEADER}\n${row('', 'Acme', 'https://acme.test/1')}\n${row('Dev', 'Acme', 'not a url')}\n${row('Dev', 'Acme', 'https://acme.test/2', 'yesterday')}\n${row('Dev', 'Acme', 'https://acme.test/3')}\n\n`)
    expect(file.invalid).toBe(3)
    expect(file.rows).toHaveLength(1)
    expect(readFeedText('Job Title,Company\nA,B\n').missingColumns).toEqual(['Apply Link', 'Date Found'])
  })
  it('keeps unknown columns and uses the first of duplicate headers', () => {
    const file = readFeedText('Job Title,Company,Apply Link,Date Found,Company,Mystery\nDev,First,https://a.test/1,2026-11-01,Second,x\n')
    expect(file.rows[0].company).toBe('First')
    expect(parseCsv('a,b\n1,2')[1].fields.map((field) => field.value)).toEqual(['1', '2'])
  })
  it('refuses a relative path, a non-CSV file and an oversized file', async () => {
    const { path, sqlite } = await setup('a,b\n')
    await expect(readFeedFile('jobs.csv')).rejects.toThrow('full path')
    await expect(readFeedFile(path.replace('.csv', '.txt'))).rejects.toThrow('full path')
    await writeFile(path, Buffer.alloc(5 * 1024 * 1024 + 1, 97))
    await expect(readFeedFile(path)).rejects.toThrow('5 MB')
    sqlite.close()
  })
})

describe('feed URL rules', () => {
  it.each([
    ['https://Jobs.Example.com/Role/1/', 'https://jobs.example.com/Role/1'],
    ['https://example.com/job#apply', 'https://example.com/job'],
    ['https://example.com/job?utm_source=x&utm_medium=y', 'https://example.com/job'],
    ['https://example.com/careers?gh_jid=12345&gh_src=abc', 'https://example.com/careers?gh_jid=12345'],
    ['https://jobs.lever.co/acme/1?lever-source=Site&lever-origin=applied', 'https://jobs.lever.co/acme/1'],
    ['https://example.com/job?ref=a&fbclid=b&gclid=c&mc_cid=d&id=7', 'https://example.com/job?id=7'],
  ])('normalizes %s', (input, expected) => expect(normalizeFeedUrl(input)).toBe(expected))
  it('rejects non-web and credentialed addresses', () => {
    expect(normalizeFeedUrl('ftp://example.com/x')).toBeNull()
    expect(normalizeFeedUrl('https://user:pw@example.com/x')).toBeNull()
    expect(normalizeFeedUrl('nonsense')).toBeNull()
  })
})

describe('feed import', () => {
  it('imports once, starts no run, and keeps finder notes out of the job text', async () => {
    const f = await setup(`${HEADER}\n${row('Engineer', 'Acme', 'https://acme.test/jobs/1', '2026-11-01', { posted: '2026-10-30' })}\n${row('Analyst', 'Beta', 'https://beta.test/jobs/2')}\n`)
    const file = (await readFeedFile(f.path)).file
    expect(importRows(f.sqlite, file)).toMatchObject({ imported: 2, duplicates: 0 })
    const jobs = f.sqlite.prepare('SELECT title,origin,found_at,posted_at,finder_priority,posting_state,text,finder_note FROM jobs ORDER BY title').all() as Array<Record<string, string | null>>
    expect(jobs[1]).toMatchObject({ title: 'Engineer', origin: 'feed', found_at: '2026-11-01', posted_at: '2026-10-30', finder_priority: 'High', posting_state: 'summary' })
    expect(jobs[1].text).toContain('Python and SQL')
    expect(jobs[1].text).not.toMatch(/WHY_IT_FITS_PRIVATE_MARKER|Citizenship/)
    expect(jobs[1].finder_note).toContain('WHY_IT_FITS_PRIVATE_MARKER')
    expect(f.sqlite.prepare('SELECT COUNT(*) n FROM runs').get()).toEqual({ n: 0 })
    expect(f.sqlite.prepare('SELECT COUNT(*) n FROM applications').get()).toEqual({ n: 0 })
    expect(importRows(f.sqlite, file)).toMatchObject({ imported: 0, duplicates: 2 })
    f.sqlite.close()
  })
  it('skips duplicates by URL and by company, title and location, and notes a similar role', async () => {
    const f = await setup(`${HEADER}\n${row('Engineer', 'Acme', 'https://acme.test/jobs/1')}\n${row('Engineer', 'Acme', 'https://acme.test/jobs/1?utm_source=feed')}\n${row('ENGINEER', 'acme', 'https://acme.test/other')}\n${row('Engineer', 'Acme', 'https://acme.test/jobs/9', '2026-11-01', { location: 'Austin' })}\n`)
    expect(importRows(f.sqlite, (await readFeedFile(f.path)).file)).toMatchObject({ imported: 2, duplicates: 2 })
    const similar = f.sqlite.prepare("SELECT finder_note FROM jobs WHERE location='Austin'").get() as { finder_note: string }
    expect(JSON.parse(similar.finder_note).similarTo).toContain('Acme')
    f.sqlite.close()
  })
  it('does not import a job already saved by hand', async () => {
    const f = await setup(`${HEADER}\n${row('Engineer', 'Acme', 'https://acme.test/jobs/1/')}\n`)
    f.sqlite.prepare("INSERT INTO jobs(id,company,title,captured_at,source_url,raw_snapshot,text,location,remote,salary,source,capture_method) VALUES('manual','Acme','Dev',?,'https://acme.test/jobs/1?utm_source=x','s','t','','','','paste','paste')").run(new Date().toISOString())
    expect(importRows(f.sqlite, (await readFeedFile(f.path)).file)).toMatchObject({ imported: 0, duplicates: 1 })
    f.sqlite.close()
  })
  it('remembers an imported URL after the job is deleted', async () => {
    const f = await setup(`${HEADER}\n${row('Engineer', 'Acme', 'https://acme.test/jobs/1')}\n`)
    importRows(f.sqlite, (await readFeedFile(f.path)).file)
    f.sqlite.prepare('DELETE FROM jobs').run()
    expect(importRows(f.sqlite, (await readFeedFile(f.path)).file)).toMatchObject({ imported: 0, duplicates: 1 })
    expect(f.sqlite.prepare('SELECT COUNT(*) n FROM jobs').get()).toEqual({ n: 0 })
    f.sqlite.close()
  })
})

describe('Imported marker', () => {
  it('adds the column, leaves every other byte alone, and is stable on a second pass', async () => {
    const f = await setup(`${HEADER}\r\n${row('Engineer', 'Acme', 'https://acme.test/jobs/1')}\r\n${row('Other', 'Beta', 'https://beta.test/2')}\r\n`)
    const marks = new Map([['https://acme.test/jobs/1', '2026-11-07']])
    expect(await markImported(f.path, marks)).toEqual({ changed: 1, notice: null })
    const text = await readFile(f.path, 'utf8')
    const lines = text.split('\r\n')
    expect(lines[0]).toBe(`${HEADER},Imported`)
    expect(lines[1]).toBe(`${row('Engineer', 'Acme', 'https://acme.test/jobs/1')},2026-11-07`)
    expect(lines[2]).toBe(`${row('Other', 'Beta', 'https://beta.test/2')},`)
    expect(await markImported(f.path, marks)).toEqual({ changed: 0, notice: null })
    expect(await readFile(f.path, 'utf8')).toBe(text)
    expect((await readdir(f.dir)).filter((name) => name.endsWith('.tmp'))).toEqual([])
    f.sqlite.close()
  })
  it('fills an existing blank Imported cell and keeps a byte-order mark', async () => {
    const f = await setup('﻿Job Title,Company,Apply Link,Date Found,Imported\nDev,Acme,https://a.test/1,2026-11-01,\nDev,Acme,https://a.test/2,2026-11-01,2026-10-01\n')
    await markImported(f.path, new Map([['https://a.test/1', '2026-11-07'], ['https://a.test/2', '2026-11-07']]))
    expect(await readFile(f.path, 'utf8')).toBe('﻿Job Title,Company,Apply Link,Date Found,Imported\nDev,Acme,https://a.test/1,2026-11-01,2026-11-07\nDev,Acme,https://a.test/2,2026-11-01,2026-10-01\n')
    f.sqlite.close()
  })
  it('never writes a half-updated file when the file keeps changing', async () => {
    const f = await setup(`${HEADER}\n${row('Engineer', 'Acme', 'https://acme.test/jobs/1')}\n`)
    const original = await readFile(f.path, 'utf8')
    const base = (await stat(f.path)).mtimeMs
    let tick = 1
    const touch = setInterval(() => { void utimes(f.path, new Date(), new Date(base + 1000 * tick++)).catch(() => undefined) }, 0)
    const result = await markImported(f.path, new Map([['https://acme.test/jobs/1', '2026-11-07']]))
    clearInterval(touch)
    const text = await readFile(f.path, 'utf8')
    expect(text === original || text === `${HEADER},Imported\n${row('Engineer', 'Acme', 'https://acme.test/jobs/1')},2026-11-07\n`).toBe(true)
    if (text === original) expect(result.notice).toContain('changed')
    expect((await readdir(f.dir)).filter((name) => name.endsWith('.tmp'))).toEqual([])
    f.sqlite.close()
  })
})

describe('background posting fetch', () => {
  async function imported(rows: string[]) {
    const f = await setup(`${HEADER}\n${rows.join('\n')}\n`)
    return { ...f, ids: importRows(f.sqlite, (await readFeedFile(f.path)).file).importedIds }
  }
  const state = (f: Awaited<ReturnType<typeof imported>>) => f.sqlite.prepare('SELECT posting_state AS state, text FROM jobs ORDER BY title').all() as Array<{ state: string; text: string }>

  it('replaces the summary with the full posting', async () => {
    const f = await imported([row('A', 'Acme', 'https://acme.test/jobs/1')])
    await fetchPostings(f.sqlite, f.ids, f.capture, { spacingMs: 0 })
    expect(state(f)[0].state).toBe('full')
    expect(state(f)[0].text).toContain('Full posting')
    f.sqlite.close()
  })
  it('marks a 404 as maybe closed and a blocked or failed fetch as summary only', async () => {
    const f = await imported([row('A', 'Acme', 'https://acme.test/jobs/1'), row('B', 'Beta', 'https://beta.test/2'), row('C', 'Gamma', 'https://gamma.test/3')])
    const capture: PostingCapture = async (url) => {
      if (url.includes('acme')) throw new Error('Job page returned HTTP 404.')
      if (url.includes('beta')) throw new Error('This site is blocked. Paste the description instead.')
      throw new Error('timeout')
    }
    await fetchPostings(f.sqlite, f.ids, capture, { spacingMs: 0 })
    expect(state(f).map((job) => job.state)).toEqual(['maybe_closed', 'summary_only', 'summary_only'])
    f.sqlite.close()
  })
  it('flags a page that says the job is closed', async () => {
    const f = await imported([row('A', 'Acme', 'https://acme.test/jobs/1')])
    await fetchPostings(f.sqlite, f.ids, async (url) => ({ text: 'This job is no longer accepting applications. '.repeat(3), rawSnapshot: 'x', url, applyUrl: url }), { spacingMs: 0 })
    expect(state(f)[0].state).toBe('maybe_closed')
    f.sqlite.close()
  })
  it('never runs more fetches at once than the cap', async () => {
    const f = await imported(Array.from({ length: 8 }, (_, index) => row(`Job ${index}`, `Company ${index}`, `https://host${index}.test/jobs/${index}`)))
    let running = 0, peak = 0
    await fetchPostings(f.sqlite, f.ids, async (url) => { running++; peak = Math.max(peak, running); await new Promise((resolve) => setTimeout(resolve, 5)); running--; return { text: `Posting ${url} ${'x'.repeat(60)}`, rawSnapshot: 'x', url, applyUrl: url } }, { concurrency: 3, spacingMs: 0 })
    expect(peak).toBe(3)
    expect(state(f).every((job) => job.state === 'full')).toBe(true)
    f.sqlite.close()
  })
  it('spaces requests to the same host', async () => {
    const f = await imported([row('A', 'Acme', 'https://same.test/jobs/1'), row('B', 'Beta', 'https://same.test/jobs/2')])
    const times: number[] = []
    await fetchPostings(f.sqlite, f.ids, async (url) => { times.push(Date.now()); return { text: `Posting ${url} ${'x'.repeat(60)}`, rawSnapshot: 'x', url, applyUrl: url } }, { concurrency: 2, spacingMs: 60 })
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(50)
    f.sqlite.close()
  })
})

describe('Clean up', () => {
  const now = new Date('2026-11-07T12:00:00Z')
  async function seeded() {
    const f = await setup(`${HEADER}\n${row('Old', 'Acme', 'https://a.test/old', '2026-08-01')}\n${row('OldPosted', 'Beta', 'https://b.test/oldposted', '2026-11-05', { posted: '2026-07-01' })}\n${row('Fresh', 'Gamma', 'https://c.test/fresh', '2026-11-01')}\n${row('Tracked', 'Delta', 'https://d.test/tracked', '2026-07-01')}\n`)
    importRows(f.sqlite, (await readFeedFile(f.path)).file, new Date('2026-11-07T00:00:00Z'))
    await markImported(f.path, new Map(['https://a.test/old', 'https://b.test/oldposted', 'https://c.test/fresh', 'https://d.test/tracked'].map((key) => [key, '2026-11-07'])))
    const tracked = f.sqlite.prepare("SELECT id FROM jobs WHERE title='Tracked'").get() as { id: string }
    f.sqlite.prepare("INSERT INTO applications(id,job_id,status,notes,contacts) VALUES('app',?,'saved','','')").run(tracked.id)
    // An old row nobody has imported must never be touched.
    await writeFile(f.path, `${await readFile(f.path, 'utf8')}${row('Unmarked', 'Zed', 'https://z.test/unmarked', '2026-01-01')},\n`)
    return f
  }
  it('previews and applies the same set, using the posted date first', async () => {
    const f = await seeded()
    const { plan } = planCleanup(f.sqlite, (await readFeedFile(f.path)).file, 60, now)
    expect(plan.csvRows).toBe(3)
    expect(plan.triageJobs.map((job) => job.title).sort()).toEqual(['Old', 'OldPosted'])
    expect(await applyCleanup(f.sqlite, f.path, 60, now)).toMatchObject({ removedRows: 3, removedJobs: 2 })
    const left = (await readFile(f.path, 'utf8')).split('\n').filter(Boolean)
    expect(left).toHaveLength(3)
    expect(left.join('\n')).toMatch(/Fresh/); expect(left.join('\n')).toMatch(/Unmarked/)
    expect(f.sqlite.prepare('SELECT title FROM jobs ORDER BY title').all()).toEqual([{ title: 'Fresh' }, { title: 'Tracked' }])
    // The remembered URLs survive, so the searcher re-listing a trimmed row adds nothing.
    expect(f.sqlite.prepare('SELECT COUNT(*) n FROM feed_imports').get()).toEqual({ n: 4 })
    f.sqlite.close()
  })
})

describe('feed API', () => {
  async function api(csv: string) {
    const f = await setup(csv)
    await writeSettings(f.dir, { ...defaultSettings(), jobFeed: { path: f.path } })
    const prompts: string[] = []
    const modelRouter = { async complete(_task: string, request: { user: string; system?: string }) { prompts.push(`${request.system ?? ''}\n${request.user}`); return { text: JSON.stringify({ requirements: [], seniority: 'junior', vocabulary: [] }), provider: 'ollama' as const, model: 'fake' } } }
    const app = createApp({ dataDirectory: f.dir, sqlite: f.sqlite, db: f.db, port: 3000, postingCapture: f.capture, feedSpacingMs: 0, modelRouter })
    const call = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => app.request(`http://127.0.0.1:3000${path}`, { method, headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const settled = async () => { for (let i = 0; i < 200; i++) { if (!f.sqlite.prepare("SELECT 1 FROM jobs WHERE posting_state='summary'").get()) return; await new Promise((resolve) => setTimeout(resolve, 10)) } }
    return { ...f, call, prompts, settled }
  }
  const csv = `${HEADER}\n${row('Engineer', 'Acme', 'https://acme.test/jobs/1')}\n${row('Analyst', 'Beta', 'https://beta.test/jobs/2')}\n`

  it('imports on refresh, keeps Triage out of Active, and moves a tracked job to Active', async () => {
    const f = await api(csv)
    const refreshed = await f.call('/api/feed/refresh', {})
    expect(refreshed.status).toBe(200)
    await f.settled()
    expect(await (await f.call('/api/jobs/counts')).json()).toMatchObject({ triage: 2, active: 0, new: 2, all: 2 })
    const triage = await (await f.call('/api/jobs?status=triage')).json() as { jobs: Array<{ id: string; origin: string; flagCount: number; finderPriority: string; postingState: string }> }
    expect(triage.jobs).toHaveLength(2)
    expect(triage.jobs[0]).toMatchObject({ origin: 'feed', flagCount: 2, finderPriority: 'High', postingState: 'full' })
    expect(((await (await f.call('/api/jobs?status=active')).json()) as { jobs: unknown[] }).jobs).toHaveLength(0)
    expect((await f.call(`/api/jobs/${triage.jobs[0].id}/status`, { status: 'saved' }, 'PUT')).status).toBe(200)
    expect(await (await f.call('/api/jobs/counts')).json()).toMatchObject({ triage: 1, active: 1 })
    const skipId = triage.jobs[1].id
    await f.call(`/api/jobs/${skipId}/status`, { status: 'skipped' }, 'PUT')
    expect(await (await f.call('/api/jobs/counts')).json()).toMatchObject({ triage: 0, skipped: 1 })
    expect(f.sqlite.prepare("SELECT COUNT(*) n FROM runs").get()).toEqual({ n: 0 })
    f.sqlite.close()
  })
  it('reports status and tests a file without changing anything', async () => {
    const f = await api(csv)
    await f.call('/api/feed/refresh', {}); await f.settled()
    const before = await readFile(f.path, 'utf8')
    expect(await (await f.call('/api/feed/status')).json()).toMatchObject({ configured: true, path: f.path })
    expect(await (await f.call('/api/feed/test', {})).json()).toMatchObject({ rows: 2, valid: 2, invalid: 0, alreadyImported: 2, newRows: 0 })
    expect(await readFile(f.path, 'utf8')).toBe(before)
    expect((await f.call('/api/feed/test', { path: 'relative.csv' })).status).toBe(422)
    f.sqlite.close()
  })
  it('never sends finder notes to a model, even when the owner runs a fit check', async () => {
    const f = await api(csv)
    await f.call('/api/feed/refresh', {}); await f.settled()
    expect(f.prompts).toEqual([])
    const jobs = await (await f.call('/api/jobs?status=triage')).json() as { jobs: Array<{ id: string }> }
    await f.call(`/api/jobs/${jobs.jobs[0].id}/extract`, {})
    for (let i = 0; i < 200 && !f.prompts.length; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(f.prompts.length).toBeGreaterThan(0)
    expect(f.prompts.join('\n')).not.toMatch(/WHY_IT_FITS_PRIVATE_MARKER|Citizenship|"High"/)
    f.sqlite.close()
  })
  it('keeps the feed path when settings are saved without it, and refuses a relative path', async () => {
    const f = await api(csv)
    const settings = { ...defaultSettings() }
    expect((await f.call('/api/settings', settings, 'PUT')).status).toBe(200)
    expect(((await (await f.call('/api/settings')).json()) as { jobFeed: { path: string } }).jobFeed.path).toBe(f.path)
    expect((await f.call('/api/settings', { ...settings, jobFeed: { path: 'jobs.csv' } }, 'PUT')).status).toBe(400)
    expect((await f.call('/api/settings', { ...settings, jobFeed: { path: '' } }, 'PUT')).status).toBe(200)
    expect(((await (await f.call('/api/settings')).json()) as { jobFeed?: unknown }).jobFeed).toBeUndefined()
    expect((await f.call('/api/feed/refresh', {})).status).toBe(409)
    f.sqlite.close()
  })
  it('refuses a manual add of a URL the feed already holds', async () => {
    const f = await api(csv)
    await f.call('/api/feed/refresh', {}); await f.settled()
    const response = await f.call('/api/jobs', { company: 'Other', title: 'Different', text: 'x'.repeat(60), url: 'https://acme.test/jobs/1?utm_source=x#top' })
    expect(response.status).toBe(409)
    f.sqlite.close()
  })
  it('previews and applies a cleanup over the API', async () => {
    const f = await api(`${HEADER}\n${row('Old', 'Acme', 'https://acme.test/jobs/1', '2020-01-01')}\n`)
    await f.call('/api/feed/refresh', {}); await f.settled()
    const preview = await (await f.call('/api/feed/cleanup/preview', { days: 60 })).json()
    expect(preview).toMatchObject({ csvRows: 1, triageJobs: [{ title: 'Old' }] })
    expect((await f.call('/api/feed/cleanup/preview', { days: 0 })).status).toBe(400)
    expect(await (await f.call('/api/feed/cleanup', { days: 60 })).json()).toMatchObject({ removedRows: 1, removedJobs: 1 })
    expect(f.sqlite.prepare('SELECT COUNT(*) n FROM jobs').get()).toEqual({ n: 0 })
    f.sqlite.close()
  })
})

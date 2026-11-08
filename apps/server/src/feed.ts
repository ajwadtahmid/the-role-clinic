import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type Database from 'better-sqlite3'

// The job feed is a CSV that a separate search tool appends to. Role Clinic reads it, remembers every URL it has
// imported, and only ever writes the `Imported` column and the rows the owner chooses to clean up.

export const MAX_FEED_BYTES = 5 * 1024 * 1024
const REQUIRED = ['Job Title', 'Company', 'Apply Link', 'Date Found'] as const
const IMPORTED = 'Imported'
const TRACKING = /^(utm_.*|gh_src|lever-source|lever-origin|ref|source|fbclid|gclid|mc_.*)$/i

export function normalizeFeedUrl(raw: string): string | null {
  let url: URL
  try { url = new URL(raw.trim()) } catch { return null }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
  url.hash = ''
  for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key)
  const path = url.pathname.replace(/\/+$/, '')
  const query = url.searchParams.toString()
  return `${url.protocol}//${url.host.toLowerCase()}${path}${query ? `?${query}` : ''}`
}

interface Field { value: string; start: number; end: number }
interface CsvRecord { fields: Field[]; start: number; end: number; next: number }

// A small CSV reader that keeps the offsets of every field, so a row can be edited without rewriting the others.
export function parseCsv(text: string): CsvRecord[] {
  const records: CsvRecord[] = []
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  while (i < text.length) {
    const fields: Field[] = []
    const start = i
    for (;;) {
      const fieldStart = i
      let value = ''
      if (text[i] === '"') {
        i++
        while (i < text.length) {
          if (text[i] === '"') { if (text[i + 1] === '"') { value += '"'; i += 2; continue } i++; break }
          value += text[i++]
        }
      }
      while (i < text.length && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') value += text[i++]
      fields.push({ value, start: fieldStart, end: i })
      if (text[i] === ',') { i++; continue }
      break
    }
    const end = i
    if (text[i] === '\r') i++
    if (text[i] === '\n') i++
    records.push({ fields, start, end, next: i })
  }
  return records
}

export interface FeedRow {
  index: number // position among records (the header is 0)
  title: string; company: string; url: string; key: string
  foundAt: string; postedAt: string | null
  priority: string; location: string; arrangement: string; salary: string
  required: string; preferred: string; flags: string; whyItFits: string; source: string
  imported: string
}
export interface FeedFile {
  text: string
  columns: Map<string, number>
  records: CsvRecord[]
  rows: FeedRow[]
  invalid: number
  missingColumns: string[]
}

const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(Date.parse(value.slice(0, 10)))
const blank = (record: CsvRecord) => record.fields.length === 1 && record.fields[0].value.trim() === ''

export function readFeedText(text: string): FeedFile {
  const records = parseCsv(text)
  const columns = new Map<string, number>()
  records[0]?.fields.forEach((field, index) => { const name = field.value.trim().toLowerCase(); if (name && !columns.has(name)) columns.set(name, index) })
  const missingColumns = REQUIRED.filter((name) => !columns.has(name.toLowerCase()))
  const rows: FeedRow[] = []
  let invalid = 0
  if (missingColumns.length) return { text, columns, records, rows, invalid, missingColumns: [...missingColumns] }
  const get = (record: CsvRecord, name: string) => {
    const index = columns.get(name.toLowerCase())
    return index === undefined ? '' : (record.fields[index]?.value ?? '').trim()
  }
  records.slice(1).forEach((record, offset) => {
    if (blank(record)) return
    const url = get(record, 'Apply Link'), key = normalizeFeedUrl(url)
    const found = get(record, 'Date Found'), posted = get(record, 'Date Posted')
    if (!get(record, 'Job Title') || !get(record, 'Company') || !key || !isDate(found)) { invalid++; return }
    rows.push({
      index: offset + 1, title: get(record, 'Job Title'), company: get(record, 'Company'), url, key,
      foundAt: found.slice(0, 10), postedAt: isDate(posted) ? posted.slice(0, 10) : null,
      priority: get(record, 'Priority'), location: get(record, 'Location'), arrangement: get(record, 'Work Arrangement'), salary: get(record, 'Salary Range'),
      required: get(record, 'Required Qualifications'), preferred: get(record, 'Preferred Qualifications'),
      flags: get(record, 'Missing Skills / Flags'), whyItFits: get(record, 'Why It Fits'), source: get(record, 'Source'),
      imported: get(record, IMPORTED),
    })
  })
  return { text, columns, records, rows, invalid, missingColumns: [] }
}

export async function readFeedFile(path: string) {
  if (!isAbsolute(path) || !/\.csv$/i.test(path)) throw new Error('Choose the full path of a .csv file.')
  let info
  try { info = await stat(path) } catch { throw new Error('That file was not found.') }
  if (!info.isFile()) throw new Error('That path is not a file.')
  if (info.size > MAX_FEED_BYTES) throw new Error('That file is larger than 5 MB.')
  return { file: readFeedText(await readFile(path, 'utf8')), size: info.size, mtimeMs: info.mtimeMs }
}

interface Edit { start: number; end: number; text: string }
const applyEdits = (text: string, edits: Edit[]) => [...edits].sort((a, b) => b.start - a.start).reduce((out, edit) => out.slice(0, edit.start) + edit.text + out.slice(edit.end), text)

// Sets the Imported value for the given rows (by normalized URL), adding the column to the header when absent.
function markEdits(file: FeedFile, dates: Map<string, string>) {
  const edits: Edit[] = []
  const existing = file.columns.get(IMPORTED.toLowerCase())
  const column = existing ?? file.records[0].fields.length
  if (existing === undefined) edits.push({ start: file.records[0].end, end: file.records[0].end, text: `,${IMPORTED}` })
  let marked = 0
  const touched = new Set<number>()
  for (const row of file.rows) {
    const date = row.imported ? undefined : dates.get(row.key)
    if (!date) continue
    const record = file.records[row.index]
    touched.add(row.index)
    if (record.fields.length > column) edits.push({ start: record.fields[column].start, end: record.fields[column].end, text: date })
    else edits.push({ start: record.end, end: record.end, text: ','.repeat(column - record.fields.length + 1) + date })
    marked++
  }
  if (existing === undefined) {
    // Every other row still gets an empty cell so the file stays rectangular.
    file.records.forEach((record, index) => {
      if (index === 0 || touched.has(index) || blank(record)) return
      edits.push({ start: record.end, end: record.end, text: ','.repeat(column - record.fields.length + 1) })
    })
  }
  return { edits, marked }
}

async function replaceFile(path: string, build: (file: FeedFile) => { text: string; changed: number } | null): Promise<{ changed: number; notice: string | null }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let before
    try { before = await readFeedFile(path) } catch (error) { return { changed: 0, notice: (error as Error).message } }
    const built = build(before.file)
    if (!built || built.changed === 0) return { changed: 0, notice: null }
    const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
    try {
      const info = await stat(path)
      await writeFile(temporary, built.text, { mode: info.mode & 0o777 })
      await chmod(temporary, info.mode & 0o777).catch(() => undefined)
      const after = await stat(path)
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) { await rm(temporary, { force: true }); continue }
      await rename(temporary, path)
      return { changed: built.changed, notice: null }
    } catch (error) {
      await rm(temporary, { force: true })
      const code = (error as NodeJS.ErrnoException).code
      return { changed: 0, notice: code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' ? 'The CSV is open in another program, so it could not be updated. Nothing was lost.' : `The CSV could not be updated: ${(error as Error).message}` }
    }
  }
  return { changed: 0, notice: 'The CSV changed while it was being updated. Run Check for new jobs again.' }
}

export function markImported(path: string, dates: Map<string, string>) {
  return replaceFile(path, (file) => {
    if (file.missingColumns.length) return null
    const { edits, marked } = markEdits(file, dates)
    return { text: applyEdits(file.text, edits), changed: marked }
  })
}

// ---- Import ----

export interface FeedResult { rows: number; invalid: number; imported: number; duplicates: number; alreadyMarked: number; notice: string | null; importedIds: string[] }
const note = (row: FeedRow, similar: string | null) => JSON.stringify({ flags: row.flags, whyItFits: row.whyItFits, source: row.source, similarTo: similar })
// Only the description columns go into the job text. Priority, flags and why-it-fits stay out of anything a model reads.
function summaryText(row: FeedRow) {
  return [row.title, `${row.company}${row.location ? ` — ${row.location}` : ''}`, row.arrangement && `Work arrangement: ${row.arrangement}`, row.salary && `Salary: ${row.salary}`, row.required && `Required qualifications: ${row.required}`, row.preferred && `Preferred qualifications: ${row.preferred}`].filter(Boolean).join('\n')
}
const words = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

function knownState(sqlite: Database.Database) {
  const known = new Set((sqlite.prepare('SELECT url_key FROM feed_imports').all() as Array<{ url_key: string }>).map((row) => row.url_key))
  const urls = new Map<string, string>()
  for (const row of sqlite.prepare('SELECT id,source_url,canonical_url,apply_url FROM jobs').all() as Array<{ id: string; source_url: string | null; canonical_url: string | null; apply_url: string | null }>) {
    for (const url of [row.source_url, row.canonical_url, row.apply_url]) { const key = url && normalizeFeedUrl(url); if (key) urls.set(key, row.id) }
  }
  const triples = new Set((sqlite.prepare('SELECT company,title,location FROM jobs').all() as Array<{ company: string; title: string; location: string }>).map((job) => `${words(job.company)}|${words(job.title)}|${words(job.location)}`))
  return { known, urls, triples }
}

export function importRows(sqlite: Database.Database, file: FeedFile, now = new Date()) {
  const result = { rows: file.rows.length + file.invalid, invalid: file.invalid, imported: 0, duplicates: 0, alreadyMarked: 0, importedIds: [] as string[], marks: new Map<string, string>() }
  const stamp = now.toISOString(), today = stamp.slice(0, 10)
  const state = knownState(sqlite)
  const recent = sqlite.prepare('SELECT company,title FROM jobs WHERE captured_at >= ?').all(new Date(now.getTime() - 60 * 86_400_000).toISOString()) as Array<{ company: string; title: string }>
  const insert = sqlite.prepare('INSERT INTO jobs(id,company,title,captured_at,source_url,raw_snapshot,text,canonical_url,apply_url,location,remote,salary,source,capture_method,origin,found_at,posted_at,finder_priority,finder_note,posting_state) VALUES(?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?)')
  const remember = sqlite.prepare('INSERT OR IGNORE INTO feed_imports(url_key,first_seen_at,found_date,job_id) VALUES(?,?,?,?)')
  sqlite.transaction(() => {
    for (const row of file.rows) {
      if (row.imported) { result.alreadyMarked++; continue }
      const existing = state.urls.get(row.key)
      const triple = `${words(row.company)}|${words(row.title)}|${words(row.location)}`
      if (state.known.has(row.key) || existing || state.triples.has(triple)) {
        result.duplicates++
        remember.run(row.key, stamp, row.foundAt, existing ?? null)
        state.known.add(row.key)
        result.marks.set(row.key, today)
        continue
      }
      const similar = recent.find((job) => words(job.company) === words(row.company) && words(job.title) === words(row.title))
      const jobId = randomUUID(), text = summaryText(row)
      insert.run(jobId, row.company.slice(0, 200), row.title.slice(0, 300), stamp, row.url, text, text, row.url, row.location.slice(0, 300), row.arrangement.slice(0, 100), row.salary.slice(0, 200), 'job feed', 'feed', 'feed', row.foundAt, row.postedAt, row.priority || null, note(row, similar ? `${similar.company} — ${similar.title}` : null), 'summary')
      remember.run(row.key, stamp, row.foundAt, jobId)
      state.known.add(row.key); state.triples.add(triple); recent.push({ company: row.company, title: row.title })
      result.imported++; result.importedIds.push(jobId); result.marks.set(row.key, today)
    }
  })()
  return result
}

// ---- Background posting fetch ----

export interface CapturedPosting { text: string; rawSnapshot: string; url: string; canonicalUrl?: string; applyUrl: string }
export type PostingCapture = (url: string) => Promise<CapturedPosting>
const CLOSED_TEXT = /no longer accepting|no longer available|position has been filled|job (?:has )?expired|posting (?:has )?(?:been )?removed|this job is closed/i

export async function fetchPostings(sqlite: Database.Database, jobIds: string[], capture: PostingCapture, options: { concurrency?: number; spacingMs?: number } = {}) {
  const concurrency = options.concurrency ?? 3, spacing = options.spacingMs ?? 1000
  const queue = [...jobIds], lastByHost = new Map<string, number>()
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      const job = sqlite.prepare("SELECT apply_url,source_url FROM jobs WHERE id=? AND origin='feed' AND posting_state='summary'").get(id) as { apply_url: string | null; source_url: string | null } | undefined
      const url = job?.apply_url ?? job?.source_url
      if (!url) continue
      let host = ''
      try { host = new URL(url).hostname } catch { continue }
      const slot = Math.max(Date.now(), (lastByHost.get(host) ?? 0) + spacing)
      lastByHost.set(host, slot)
      if (slot > Date.now()) await new Promise((resolve) => setTimeout(resolve, slot - Date.now()))
      try {
        const posting = await capture(url)
        const closed = CLOSED_TEXT.test(posting.text.slice(0, 600))
        sqlite.prepare("UPDATE jobs SET text=?,raw_snapshot=?,canonical_url=?,apply_url=?,capture_method='feed-fetch',posting_state=? WHERE id=? AND posting_state='summary'").run(posting.text, posting.rawSnapshot, posting.canonicalUrl ?? posting.url, posting.applyUrl || url, closed ? 'maybe_closed' : 'full', id)
      } catch (error) {
        const closed = /HTTP (404|410)\b/.test((error as Error).message ?? '')
        sqlite.prepare("UPDATE jobs SET posting_state=? WHERE id=? AND posting_state='summary'").run(closed ? 'maybe_closed' : 'summary_only', id)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
}

// ---- Clean up ----

export interface CleanupPlan { csvRows: number; triageJobs: Array<{ id: string; company: string; title: string; date: string }>; cutoff: string }
const cutoffFor = (days: number, now: Date) => new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10)

export function planCleanup(sqlite: Database.Database, file: FeedFile | null, days: number, now = new Date()) {
  const cutoff = cutoffFor(days, now)
  const rows = file && !file.missingColumns.length ? file.rows.filter((row) => row.imported && (row.postedAt ?? row.foundAt) < cutoff) : []
  // Only jobs still waiting in Triage: no application record and no exported file.
  const jobs = sqlite.prepare("SELECT j.id,j.company,j.title,COALESCE(j.posted_at,j.found_at) AS date FROM jobs j LEFT JOIN applications a ON a.job_id=j.id WHERE j.origin='feed' AND a.id IS NULL AND NOT EXISTS (SELECT 1 FROM artifacts r WHERE r.job_id=j.id) AND COALESCE(j.posted_at,j.found_at) < ? ORDER BY date").all(cutoff) as CleanupPlan['triageJobs']
  return { rows, plan: { csvRows: rows.length, triageJobs: jobs, cutoff } satisfies CleanupPlan }
}

export async function applyCleanup(sqlite: Database.Database, path: string | null, days: number, now = new Date()) {
  let removedRows = 0, notice: string | null = null
  if (path) {
    const result = await replaceFile(path, (file) => {
      const { rows } = planCleanup(sqlite, file, days, now)
      if (!rows.length) return null
      return { text: applyEdits(file.text, rows.map((row) => ({ start: file.records[row.index].start, end: file.records[row.index].next, text: '' }))), changed: rows.length }
    })
    removedRows = result.changed; notice = result.notice
  }
  const { plan } = planCleanup(sqlite, null, days, now)
  const remove = sqlite.prepare('DELETE FROM jobs WHERE id=?')
  sqlite.transaction(() => { for (const job of plan.triageJobs) remove.run(job.id) })()
  return { removedRows, removedJobs: plan.triageJobs.length, notice }
}

// ---- Service ----

export interface FeedStatus { configured: boolean; path: string | null; isDefault: boolean; defaultPath: string | null; lastCheckedAt: string | null; running: boolean; lastResult: Omit<FeedResult, 'importedIds'> | null }

export class FeedService {
  private chain: Promise<unknown> = Promise.resolve()
  private checkedAt: string | null = null
  private last: FeedStatus['lastResult'] = null
  private active = 0
  // `getPath` returns a path the owner chose. Without one, the feed is read from `defaultPath` (inside the data
  // folder) as soon as a file exists there, so a search tool that writes to the default location needs no setup.
  constructor(private sqlite: Database.Database, private getPath: () => Promise<string | null>, private capture: PostingCapture, private fetchOptions: { concurrency?: number; spacingMs?: number } = {}, private defaultPath: string | null = null) {}

  async status(): Promise<FeedStatus> {
    const chosen = await this.getPath()
    const path = chosen ?? (this.defaultPath && existsSync(this.defaultPath) ? this.defaultPath : null)
    return { configured: Boolean(path), path, isDefault: !chosen && Boolean(path), defaultPath: this.defaultPath, lastCheckedAt: this.checkedAt, running: this.active > 0, lastResult: this.last }
  }

  // Imports run one at a time, so two quick requests never import the same row twice.
  refresh() {
    const next = this.chain.then(() => this.runImport())
    this.chain = next.catch(() => undefined)
    return next
  }
  private async runImport() {
    this.active++
    try {
      const { path } = await this.status()
      if (!path) throw new Error('No job feed file was found. Set its path in Settings, or run the search so it writes to the default location.')
      const { file } = await readFeedFile(path)
      if (file.missingColumns.length) throw new Error(`The file is missing required columns: ${file.missingColumns.join(', ')}.`)
      const { marks, importedIds, ...counts } = importRows(this.sqlite, file)
      const marked = await markImported(path, marks)
      this.checkedAt = new Date().toISOString()
      this.last = { ...counts, notice: marked.notice }
      // Posting text arrives in the background; nothing here waits on it.
      if (importedIds.length) void fetchPostings(this.sqlite, importedIds, this.capture, this.fetchOptions).catch(() => undefined)
      return { ...counts, notice: marked.notice, importedIds }
    } finally { this.active-- }
  }

  // A dry look at a file: counts only, nothing is changed.
  async test(path: string) {
    const { file } = await readFeedFile(path)
    if (file.missingColumns.length) return { rows: 0, valid: 0, invalid: 0, alreadyImported: 0, newRows: 0, missingColumns: file.missingColumns }
    const state = knownState(this.sqlite)
    const alreadyImported = file.rows.filter((row) => row.imported || state.known.has(row.key)).length
    return { rows: file.rows.length + file.invalid, valid: file.rows.length, invalid: file.invalid, alreadyImported, newRows: file.rows.length - alreadyImported, missingColumns: [] as string[] }
  }

  async cleanupPreview(days: number) {
    const { path } = await this.status()
    const file = path ? (await readFeedFile(path).catch(() => null))?.file ?? null : null
    return planCleanup(this.sqlite, file, days).plan
  }
  async cleanup(days: number) {
    return applyCleanup(this.sqlite, (await this.status()).path, days)
  }
}

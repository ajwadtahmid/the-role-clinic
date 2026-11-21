import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import ExcelJS from 'exceljs'
import { calendarDate } from '../../../packages/shared/src/index.js'
import { normalizeFeedUrl } from './feed.js'
import { similarity } from './similarity.js'

// Importing a spreadsheet of applications: read a file or pasted cells, match its columns, say what each row would become,
// and only then create everything in one transaction. Nothing here fetches a page or calls a model.
const IMPORT_MAX_ROWS = 5000
const IMPORT_MAX_BYTES = 5_000_000

// `numbers` holds each row's own row number in the sheet, so a skipped row can be found again even after blank rows.
export type Table = { name: string; rows: string[][]; numbers: number[] }
export type ImportFormat = 'csv' | 'xlsx' | 'paste'

// ---- Reading ----

// Comma, semicolon or tab, whichever the first line uses most (a sheet pasted from a spreadsheet is tab-separated).
function delimiterOf(text: string) {
  const first = text.split(/\r?\n/, 1)[0] ?? ''
  const counts = [',', ';', '\t'].map((mark) => [mark, first.split(mark).length - 1] as const).sort((a, b) => b[1] - a[1])
  return counts[0][1] > 0 ? counts[0][0] : ','
}

function parseRecords(input: string): Array<{ cells: string[]; number: number }> {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input, delimiter = delimiterOf(text)
  const rows: Array<{ cells: string[]; number: number }> = []
  let row: string[] = [], field = '', quoted = false, number = 1
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false } else field += char
    } else if (char === '"' && field === '') quoted = true
    else if (char === delimiter) { row.push(field); field = '' }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''; rows.push({ cells: row, number: number++ }); row = []
    } else field += char
  }
  if (field !== '' || row.length) { row.push(field); rows.push({ cells: row, number }) }
  return rows.filter((record) => record.cells.some((cell) => cell.trim() !== ''))
}
export const parseDelimited = (input: string) => parseRecords(input).map((record) => record.cells)

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10)
  if (typeof value === 'object') {
    const object = value as unknown as Record<string, unknown>
    if ('result' in object) return cellText(object.result as ExcelJS.CellValue)
    if (Array.isArray(object.richText)) return (object.richText as Array<{ text: string }>).map((part) => part.text).join('')
    // A linked cell is read as its address: the visible words are usually just "link" or "apply here".
    if (typeof object.hyperlink === 'string') return object.hyperlink
    if (typeof object.text === 'string') return object.text
    return ''
  }
  return String(value)
}

// An .xlsx file is a zip. Its table of contents lists how large each part becomes once unpacked, so a small file that
// would unpack to something huge is refused before anything is unpacked. Returns the total, or null if it is not a zip.
const XLSX_MAX_UNPACKED = 50_000_000
export function unpackedSize(buffer: Buffer): number | null {
  const floor = Math.max(0, buffer.length - 22 - 0xffff)
  let end = -1
  for (let i = buffer.length - 22; i >= floor; i--) if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break }
  if (end < 0) return null
  const entries = buffer.readUInt16LE(end + 10)
  let offset = buffer.readUInt32LE(end + 16), total = 0
  for (let n = 0; n < entries; n++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) return null
    const size = buffer.readUInt32LE(offset + 24)
    // 0xFFFFFFFF means the real size is kept elsewhere (zip64): far beyond anything a spreadsheet of applications needs.
    total += size === 0xffffffff ? Number.POSITIVE_INFINITY : size
    offset += 46 + buffer.readUInt16LE(offset + 28) + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32)
  }
  return total
}

export async function readTables(format: ImportFormat, content: string): Promise<Table[]> {
  if (format === 'xlsx') {
    const buffer = Buffer.from(content, 'base64')
    if (buffer.length > IMPORT_MAX_BYTES) throw new Error('The file is larger than 5 MB.')
    const unpacked = unpackedSize(buffer)
    if (unpacked === null) throw new Error('This file could not be read as an Excel workbook (.xlsx).')
    if (unpacked > XLSX_MAX_UNPACKED) throw new Error('This workbook is too large to import (over 50 MB once opened). Save the sheet you need as a CSV file and import that.')
    const workbook = new ExcelJS.Workbook()
    try { await workbook.xlsx.load(buffer as unknown as ArrayBuffer) } catch { throw new Error('This file could not be read as an Excel workbook (.xlsx).') }
    const tables = workbook.worksheets.map((sheet) => {
      if (sheet.actualRowCount > IMPORT_MAX_ROWS + 1) throw new Error(`The sheet "${sheet.name}" has more than ${IMPORT_MAX_ROWS} rows. Split it and import in parts.`)
      const rows: string[][] = [], numbers: number[] = []
      sheet.eachRow({ includeEmpty: false }, (row) => {
        const cells: string[] = []
        for (let column = 1; column <= row.cellCount; column++) cells.push(cellText(row.getCell(column).value).trim())
        if (cells.some(Boolean)) { rows.push(cells); numbers.push(row.number) }
      })
      return { name: sheet.name, rows, numbers }
    }).filter((table) => table.rows.length)
    if (!tables.length) throw new Error('The workbook has no rows with anything in them.')
    return tables
  }
  if (Buffer.byteLength(content) > IMPORT_MAX_BYTES) throw new Error('The text is larger than 5 MB.')
  const records = parseRecords(content), rows = records.map((record) => record.cells)
  if (rows.length > IMPORT_MAX_ROWS + 1) throw new Error(`There are more than ${IMPORT_MAX_ROWS} rows. Split the file and import in parts.`)
  if (!rows.length) throw new Error('There is nothing to import.')
  return [{ name: 'Sheet', rows, numbers: records.map((record) => record.number) }]
}

// ---- Columns ----

export const fields = ['company', 'title', 'status', 'applied', 'followUp', 'location', 'url', 'contacts', 'notes'] as const
export type Field = (typeof fields)[number]
export type Mapping = Partial<Record<Field, number>>
const aliases: Record<Field, string[]> = {
  company: ['company', 'companyname', 'employer', 'organization', 'organisation', 'business', 'firm'],
  title: ['title', 'role', 'position', 'jobtitle', 'roletitle', 'job', 'jobrole', 'positiontitle'],
  status: ['status', 'stage', 'state', 'progress', 'result', 'outcome'],
  applied: ['applied', 'dateapplied', 'appliedon', 'applicationdate', 'applieddate', 'date', 'dateofapplication', 'submitted', 'datesubmitted'],
  followUp: ['followup', 'followupdate', 'nextfollowup', 'nextstep', 'nextstepdate', 'remind', 'reminder'],
  location: ['location', 'city', 'place', 'where'],
  url: ['url', 'link', 'joburl', 'joblink', 'posting', 'jobposting', 'applicationlink', 'website'],
  contacts: ['contact', 'contacts', 'recruiter', 'hiringmanager', 'contactperson'],
  notes: ['notes', 'note', 'comments', 'comment', 'remarks'],
}
const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '')

export function guessMapping(headers: string[]): Mapping {
  const mapping: Mapping = {}, used = new Set<number>()
  for (const field of fields) {
    const index = headers.findIndex((header, i) => !used.has(i) && aliases[field].includes(squash(header)))
    if (index >= 0) { mapping[field] = index; used.add(index) }
  }
  return mapping
}

// ---- Status words ----

const stageChoices = ['saved', 'applied', 'interviewing', 'offer', 'skipped', 'closed:rejected', 'closed:no_reply', 'closed:withdrawn', 'closed:accepted'] as const
export type StageChoice = (typeof stageChoices)[number]
// Checked in order, so "offer declined" is a withdrawal and "not interested" is not "interested".
const wordRules: Array<[RegExp, StageChoice]> = [
  [/offer.*(accept|signed)|accept.*offer|\bhired\b|\bsigned\b|\baccepted\b/, 'closed:accepted'],
  [/offer.*(declin|turn|reject|withdr)|(declin|turn).*offer/, 'closed:withdrawn'],
  [/reject|denied|unsuccessful|not selected|turned down|not moving forward|declined by/, 'closed:rejected'],
  [/ghost|no (reply|response|answer)|never heard|stale|expired/, 'closed:no_reply'],
  [/withdr|cancel|dropped|not interested|abandon|no longer/, 'closed:withdrawn'],
  [/not applying|skip|passed|pass on/, 'skipped'],
  [/interview|screen|on-?site|assessment|take.?home|round|phone|technical|recruiter call|\bhr\b/, 'interviewing'],
  [/offer|negotiat/, 'offer'],
  [/to apply|want to apply|plan to apply|interested|saved|bookmark|wish ?list|to ?do|watch|lead|considering/, 'saved'],
  [/appl|submitted|\bsent\b|pending|waiting|in progress|awaiting/, 'applied'],
]
export function mapStatusWord(word: string): StageChoice | null {
  const text = word.toLowerCase().replace(/\s+/g, ' ').trim()
  if (!text) return null
  for (const [pattern, choice] of wordRules) if (pattern.test(text)) return choice
  return null
}

// ---- Dates ----

const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
function valid(year: number, month: number, day: number) {
  if (year < 1990 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.toISOString().slice(0, 10) : null
}
export type DateOrder = 'mdy' | 'dmy'
export function parseDate(raw: string, order: DateOrder = 'mdy'): { date: string | null; ambiguous: boolean } {
  const text = raw.trim()
  if (!text) return { date: null, ambiguous: false }
  let match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/)
  if (match) return { date: valid(+match[1], +match[2], +match[3]), ambiguous: false }
  match = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/)
  if (match) {
    const a = +match[1], b = +match[2], year = +match[3] < 100 ? 2000 + +match[3] : +match[3]
    if (a > 12) return { date: valid(year, b, a), ambiguous: false }
    if (b > 12) return { date: valid(year, a, b), ambiguous: false }
    return { date: order === 'dmy' ? valid(year, b, a) : valid(year, a, b), ambiguous: a !== b }
  }
  match = text.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/)
  if (match) { const month = months.indexOf(match[2].slice(0, 3).toLowerCase()) + 1; return { date: month ? valid(+match[3], month, +match[1]) : null, ambiguous: false } }
  match = text.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/)
  if (match) { const month = months.indexOf(match[1].slice(0, 3).toLowerCase()) + 1; return { date: month ? valid(+match[3], month, +match[2]) : null, ambiguous: false } }
  if (/^\d{5}$/.test(text) && +text > 20000 && +text < 80000) return { date: new Date(Date.UTC(1899, 11, 30) + +text * 86_400_000).toISOString().slice(0, 10), ambiguous: false }
  return { date: null, ambiguous: false }
}

// ---- Planning ----

export type RowVerdict = 'new' | 'duplicate' | 'skipped'
export interface RowPlan {
  row: number; company: string; title: string; location: string; url: string; contacts: string; notes: string
  status: StageChoice; statusWord: string
  applied: string | null; appliedFromSheet: boolean; followUp: string | null
  verdict: RowVerdict; reason?: string; warning?: string
}
export interface PlanOptions { mapping: Mapping; rowNumbers?: number[]; statusMap?: Record<string, string>; dateOrder?: DateOrder; today?: string }
export interface Plan { rows: RowPlan[]; counts: { total: number; new: number; duplicate: number; skipped: number }; statusWords: Array<{ word: string; count: number; choice: StageChoice; known: boolean }>; ambiguousDates: number }

const cap = (text: string, max: number) => text.trim().slice(0, max)
const beyondApplied = (status: StageChoice) => status !== 'saved' && status !== 'skipped'
const wordKey = (word: string) => word.toLowerCase().replace(/\s+/g, ' ').trim()

export function planImport(sqlite: Database.Database, dataRows: string[][], options: PlanOptions): Plan {
  const today = options.today ?? calendarDate(), order = options.dateOrder ?? 'mdy', get = (row: string[], field: Field) => { const index = options.mapping[field]; return index === undefined ? '' : (row[index] ?? '').trim() }
  // What is already saved, to spot rows that are the same job.
  const urlKeys = new Set<string>(), byCompany = new Map<string, string[]>()
  for (const job of sqlite.prepare('SELECT company,title,source_url,canonical_url,apply_url FROM jobs').all() as Array<{ company: string; title: string; source_url: string | null; canonical_url: string | null; apply_url: string | null }>) {
    for (const url of [job.source_url, job.canonical_url, job.apply_url]) { const key = url && normalizeFeedUrl(url); if (key) urlKeys.add(key) }
    const company = squash(job.company), list = byCompany.get(company) ?? []; list.push(job.title); byCompany.set(company, list)
  }
  const words = new Map<string, { count: number; choice: StageChoice; known: boolean }>()
  let ambiguousDates = 0
  const rows = dataRows.map((cells, index): RowPlan => {
    const company = cap(get(cells, 'company'), 200), title = cap(get(cells, 'title'), 300), statusWord = get(cells, 'status')
    const plan: RowPlan = { row: options.rowNumbers?.[index] ?? index + 2, company, title, location: cap(get(cells, 'location'), 200), url: '', contacts: cap(get(cells, 'contacts'), 5000), notes: cap(get(cells, 'notes'), 5000), status: 'applied', statusWord, applied: null, appliedFromSheet: false, followUp: null, verdict: 'new' }
    const appliedRaw = get(cells, 'applied'), applied = parseDate(appliedRaw, order)
    if (applied.ambiguous) ambiguousDates++
    // Status: the person's own choice for a word wins, then the known words. A blank or unknown word is guessed from whether an applied date is given.
    const chosen = statusWord ? options.statusMap?.[wordKey(statusWord)] : undefined
    const mapped = (stageChoices as readonly string[]).includes(chosen as string) ? chosen as StageChoice : mapStatusWord(statusWord)
    plan.status = mapped ?? (appliedRaw ? 'applied' : 'saved')
    if (statusWord) { const key = wordKey(statusWord), seen = words.get(key); words.set(key, { count: (seen?.count ?? 0) + 1, choice: plan.status, known: mapped !== null }) }
    const link = get(cells, 'url')
    if (link) { try { const parsed = new URL(link); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(); parsed.hash = ''; plan.url = parsed.toString().slice(0, 2000) } catch { plan.warning = 'The link was not a web address, so it was left out.' } }
    if (!company) { plan.verdict = 'skipped'; plan.reason = 'No company'; return plan }
    if (!title) { plan.verdict = 'skipped'; plan.reason = 'No role'; return plan }
    if (appliedRaw && !applied.date) { plan.verdict = 'skipped'; plan.reason = `Date not understood: "${appliedRaw.slice(0, 30)}"`; return plan }
    if (applied.date && applied.date > today) { plan.verdict = 'skipped'; plan.reason = 'Applied date is in the future'; return plan }
    // The sheet's date is used; when it has none, a job that was applied to gets the day of the import.
    if (beyondApplied(plan.status)) { plan.applied = applied.date ?? today; plan.appliedFromSheet = Boolean(applied.date) } else if (applied.date) plan.applied = applied.date
    const followRaw = get(cells, 'followUp')
    if (followRaw) { const follow = parseDate(followRaw, order); if (follow.date) plan.followUp = follow.date; else plan.warning = plan.warning ?? 'The follow-up date was not understood, so it was left out.' }
    return plan
  })
  // Duplicates: the same web address, or the same company with a very similar role, among what is saved and earlier in this sheet.
  const seenInSheet = new Map<string, string[]>()
  for (const plan of rows) {
    if (plan.verdict !== 'new') continue
    const key = plan.url && normalizeFeedUrl(plan.url), company = squash(plan.company)
    const known = [...(byCompany.get(company) ?? []), ...(seenInSheet.get(company) ?? [])]
    if (key && urlKeys.has(key)) { plan.verdict = 'duplicate'; plan.reason = 'Already saved (same link)'; continue }
    if (known.some((title) => similarity(plan.title, title) >= 0.86)) { plan.verdict = 'duplicate'; plan.reason = 'Already saved or listed above (same company and role)'; continue }
    if (key) urlKeys.add(key)
    const list = seenInSheet.get(company) ?? []; list.push(plan.title); seenInSheet.set(company, list)
  }
  const count = (verdict: RowVerdict) => rows.filter((plan) => plan.verdict === verdict).length
  return {
    rows, counts: { total: rows.length, new: count('new'), duplicate: count('duplicate'), skipped: count('skipped') },
    statusWords: [...words.entries()].map(([word, value]) => ({ word, ...value })).sort((a, b) => b.count - a.count), ambiguousDates,
  }
}

// ---- Applying and undoing ----

const noon = (day: string) => `${day}T12:00:00.000Z`
export function applyImport(sqlite: Database.Database, plan: Plan, includeDuplicates = false, now = new Date()) {
  const batch = randomUUID(), chosen = plan.rows.filter((row) => row.verdict === 'new' || (includeDuplicates && row.verdict === 'duplicate'))
  if (!chosen.length) throw new Error('There are no rows to import.')
  const nowIso = now.toISOString(), insertJob = sqlite.prepare("INSERT INTO jobs(id,company,title,captured_at,source_url,raw_snapshot,text,canonical_url,location,source,capture_method,import_batch) VALUES(?,?,?,?,?,'','',?,?,'import','import',?)")
  const insertApplication = sqlite.prepare('INSERT INTO applications(id,job_id,status,outcome,applied_at,notes,contacts,follow_up_date) VALUES(?,?,?,?,?,?,?,?)')
  const insertEvent = sqlite.prepare('INSERT INTO status_events(id,application_id,status,outcome,created_at) VALUES(?,?,?,?,?)')
  sqlite.transaction(() => {
    chosen.forEach((row, index) => {
      const jobId = randomUUID(), applicationId = randomUUID(), [status, outcome] = row.status.split(':') as [string, string | undefined]
      const when = row.applied ? noon(row.applied) : nowIso
      insertJob.run(jobId, row.company, row.title, when, row.url || null, row.url || null, row.location, batch)
      insertApplication.run(applicationId, jobId, status, outcome ?? null, status === 'saved' || status === 'skipped' ? null : when, row.notes, row.contacts, row.followUp)
      const event = (suffix: string, kind: string, kindOutcome: string | null, at: string) => insertEvent.run(`imp-${batch}-${index}-${suffix}`, applicationId, kind, kindOutcome, at)
      if (status === 'saved' || status === 'skipped') event('a', status, null, when)
      else { event('a', 'applied', null, when); if (status !== 'applied') event('b', status, outcome ?? null, when) }
    })
    sqlite.prepare('INSERT INTO imports(id,created_at,added,skipped) VALUES(?,?,?,?)').run(batch, nowIso, chosen.length, plan.rows.length - chosen.length)
  })()
  return { batch, added: chosen.length, skipped: plan.rows.length - chosen.length }
}

export function recentImports(sqlite: Database.Database) {
  return sqlite.prepare('SELECT id,created_at AS createdAt,added,skipped,undone_at AS undoneAt FROM imports ORDER BY created_at DESC,rowid DESC LIMIT 5').all()
}

// Removes the jobs an import made, except any that have been worked on since: an answer, a run, an exported file,
// a status change of its own, or a recorded contact. Those stay and are counted.
export function undoImport(sqlite: Database.Database, batch: string) {
  const record = sqlite.prepare('SELECT id,undone_at FROM imports WHERE id=?').get(batch) as { id: string; undone_at: string | null } | undefined
  if (!record) throw new Error('That import was not found.')
  if (record.undone_at) throw new Error('That import was already undone.')
  const jobs = sqlite.prepare('SELECT j.id,a.id AS applicationId,a.last_contact_at AS lastContact FROM jobs j LEFT JOIN applications a ON a.job_id=j.id WHERE j.import_batch=?').all(batch) as Array<{ id: string; applicationId: string | null; lastContact: string | null }>
  const touched = sqlite.prepare(`SELECT (
    EXISTS(SELECT 1 FROM job_answers WHERE job_id=@id) OR EXISTS(SELECT 1 FROM runs WHERE job_id=@id) OR EXISTS(SELECT 1 FROM artifacts WHERE job_id=@id)
    OR EXISTS(SELECT 1 FROM requirements WHERE job_id=@id) OR EXISTS(SELECT 1 FROM tailored WHERE job_id=@id)
    OR EXISTS(SELECT 1 FROM status_events WHERE application_id=@app AND id NOT LIKE @mark)) AS touched`)
  const remove = sqlite.prepare('DELETE FROM jobs WHERE id=?')
  let removed = 0, kept = 0
  sqlite.transaction(() => {
    for (const job of jobs) {
      const worked = job.lastContact || (touched.get({ id: job.id, app: job.applicationId ?? '', mark: `imp-${batch}-%` }) as { touched: number }).touched
      if (worked) { kept++; continue }
      remove.run(job.id); removed++
    }
    sqlite.prepare('UPDATE imports SET undone_at=? WHERE id=?').run(new Date().toISOString(), batch)
  })()
  return { removed, kept }
}

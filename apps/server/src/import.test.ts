import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { calendarDate } from '../../../packages/shared/src/index.js'
import { createApp } from './app.js'
import { createDatabase } from './db.js'
import { guessMapping, mapStatusWord, parseDate, parseDelimited, unpackedSize } from './import.js'

const fixtures: Array<{ directory: string; sqlite: ReturnType<typeof createDatabase>['sqlite'] }> = []
afterEach(async () => { for (const f of fixtures.splice(0)) { if (f.sqlite.open) f.sqlite.close(); await rm(f.directory, { recursive: true, force: true }) } })
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'clinic-import-')), { sqlite, db } = createDatabase(directory); fixtures.push({ directory, sqlite })
  const app = createApp({ dataDirectory: directory, sqlite, db, port: 3000 })
  const send = (path: string, value?: unknown) => app.request(`http://127.0.0.1:3000${path}`, { method: value === undefined ? 'GET' : 'POST', headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) })
  return { sqlite, send }
}
const tsv = (rows: string[][]) => rows.map((row) => row.join('\t')).join('\n')
const header = ['Company', 'Role', 'Status', 'Date applied', 'Follow up', 'Link', 'Notes']

describe('reading and matching', () => {
  it('reads quoted cells, byte-order marks, semicolons, tabs and Windows line endings', () => {
    expect(parseDelimited('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"']])
    expect(parseDelimited('a;b\n1;2')).toEqual([['a', 'b'], ['1', '2']])
    expect(parseDelimited('a\tb\n1\t"2\n3"')).toEqual([['a', 'b'], ['1', '2\n3']])
  })
  it('matches columns by common header names, each column once', () => {
    expect(guessMapping(['Employer', 'Position', 'Stage', 'Applied On', 'Next follow-up', 'Job link', 'Comments', 'Recruiter'])).toEqual({ company: 0, title: 1, status: 2, applied: 3, followUp: 4, url: 5, notes: 6, contacts: 7 })
    expect(guessMapping(['Foo', 'Bar'])).toEqual({})
  })
  it('maps common status wording to stages and outcomes', () => {
    const cases: Array<[string, string | null]> = [
      ['Applied', 'applied'], ['submitted', 'applied'], ['Awaiting response', 'applied'], ['Phone screen', 'interviewing'], ['2nd round', 'interviewing'], ['On-site', 'interviewing'], ['Take-home assignment', 'interviewing'],
      ['Offer', 'offer'], ['Offer received', 'offer'], ['Offer accepted', 'closed:accepted'], ['Hired', 'closed:accepted'], ['Offer declined', 'closed:withdrawn'],
      ['Rejected', 'closed:rejected'], ['Not selected', 'closed:rejected'], ['Ghosted', 'closed:no_reply'], ['No response', 'closed:no_reply'], ['Withdrew', 'closed:withdrawn'], ['Not interested', 'closed:withdrawn'],
      ['Interested', 'saved'], ['To apply', 'saved'], ['Wishlist', 'saved'], ['Skipped', 'skipped'], ['Not applying', 'skipped'], ['', null], ['banana', null],
    ]
    for (const [word, expected] of cases) expect([word, mapStatusWord(word)]).toEqual([word, expected])
  })
  it('reads dates from the sheet, asks about day and month only when it cannot tell, and refuses what is not a date', () => {
    expect(parseDate('2026-11-03')).toEqual({ date: '2026-11-03', ambiguous: false })
    expect(parseDate('2026/11/3')).toEqual({ date: '2026-11-03', ambiguous: false })
    expect(parseDate('3 Nov 2026')).toEqual({ date: '2026-11-03', ambiguous: false })
    expect(parseDate('November 3rd, 2026')).toEqual({ date: '2026-11-03', ambiguous: false })
    expect(parseDate('13/11/2026')).toEqual({ date: '2026-11-13', ambiguous: false })
    expect(parseDate('11/13/2026')).toEqual({ date: '2026-11-13', ambiguous: false })
    expect(parseDate('03/04/2026')).toEqual({ date: '2026-03-04', ambiguous: true })
    expect(parseDate('03/04/2026', 'dmy')).toEqual({ date: '2026-04-03', ambiguous: true })
    expect(parseDate('46329')).toEqual({ date: '2026-11-03', ambiguous: false })
    expect(parseDate('2026-02-30').date).toBeNull()
    expect(parseDate('soon').date).toBeNull()
    expect(parseDate('').date).toBeNull()
  })
})

describe('importing', () => {
  it('previews without saving, then imports with dates from the sheet, the import day where a date is missing, and one history entry per stage reached', async () => {
    const { sqlite, send } = await setup()
    const today = calendarDate()
    const content = tsv([header,
      ['Acme', 'Engineer', 'Interviewing', '2026-10-05', '2026-11-30', 'https://acme.test/jobs/1', 'Phone screen done'],
      ['Beta', 'Analyst', 'Applied', '', '', '', ''],
      ['Gamma', 'Designer', 'Interested', '', '', '', 'Saw it on a board'],
      ['Delta', 'Writer', 'Ghosted', '3 Oct 2026', '', '', ''],
      ['', 'Nobody', 'Applied', '2026-10-01', '', '', ''],
      ['Epsilon', 'Tester', 'Applied', '2099-01-01', '', '', ''],
      ['Zeta', 'Planner', 'Applied', 'soon', '', '', ''],
      ['Eta', 'Gardener', 'On hold-ish?', '2026-10-09', '', '', '']])
    const preview = await (await send('/api/import/preview', { format: 'paste', content })).json() as { counts: Record<string, number>; mapping: Record<string, number>; missing: string[]; rows: Array<{ company: string; verdict: string; reason?: string; status: string }>; statusWords: Array<{ word: string; known: boolean; choice: string }> }
    expect(preview.missing).toEqual([])
    expect(preview.counts).toEqual({ total: 8, new: 5, duplicate: 0, skipped: 3 })
    expect(preview.rows.filter((row) => row.verdict === 'skipped').map((row) => row.reason)).toEqual(['No company', 'Applied date is in the future', 'Date not understood: "soon"'])
    // A blank line in the sheet does not shift the row numbers shown.
    const gapped = await (await send('/api/import/preview', { format: 'paste', content: tsv([header, ['Acme', 'Engineer', '', '', '', '', ''], ['', '', '', '', '', '', ''], ['Beta', '', '', '', '', '', '']]) })).json() as { rows: Array<{ row: number }> }
    expect(gapped.rows.map((row) => row.row)).toEqual([2, 4])
    expect(preview.statusWords.find((w) => w.word === 'on hold-ish?')).toMatchObject({ known: false, choice: 'applied' })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get()).toEqual({ n: 0 })

    const done = await send('/api/import/apply', { format: 'paste', content })
    expect(done.status).toBe(201)
    expect(await done.json()).toMatchObject({ added: 5, skipped: 3 })
    const job = (company: string) => sqlite.prepare('SELECT j.id,j.source,j.source_url AS url,j.captured_at AS capturedAt,a.status,a.outcome,a.applied_at AS appliedAt,a.follow_up_date AS followUp,a.notes FROM jobs j JOIN applications a ON a.job_id=j.id WHERE j.company=?').get(company) as Record<string, string | null>
    expect(job('Acme')).toMatchObject({ source: 'import', url: 'https://acme.test/jobs/1', status: 'interviewing', appliedAt: '2026-10-05T12:00:00.000Z', followUp: '2026-11-30', notes: 'Phone screen done' })
    expect(job('Beta')).toMatchObject({ status: 'applied', appliedAt: `${today}T12:00:00.000Z` })
    expect(job('Gamma')).toMatchObject({ status: 'saved', appliedAt: null, notes: 'Saw it on a board' })
    expect(job('Delta')).toMatchObject({ status: 'closed', outcome: 'no_reply', appliedAt: '2026-10-03T12:00:00.000Z' })
    const events = (company: string) => sqlite.prepare('SELECT e.status,e.outcome,e.created_at AS at FROM status_events e JOIN applications a ON a.id=e.application_id JOIN jobs j ON j.id=a.job_id WHERE j.company=? ORDER BY e.rowid').all(company)
    expect(events('Acme')).toEqual([{ status: 'applied', outcome: null, at: '2026-10-05T12:00:00.000Z' }, { status: 'interviewing', outcome: null, at: '2026-10-05T12:00:00.000Z' }])
    expect(events('Delta')).toMatchObject([{ status: 'applied' }, { status: 'closed', outcome: 'no_reply' }])
    expect(events('Gamma')).toHaveLength(1)
    // The tracker sees them like any other application.
    const tracker = await (await send('/api/tracker')).json() as { jobs: Array<{ company: string; status: string }> }
    expect(tracker.jobs.find((j) => j.company === 'Acme')?.status).toBe('interviewing')
  })

  it('uses the person’s own choices for status words, column matches and day-first dates', async () => {
    const { sqlite, send } = await setup()
    const content = tsv([['Org', 'Job', 'Where we are', 'When'], ['Acme', 'Engineer', 'in limbo', '03/04/2026'], ['Beta', 'Analyst', 'fine', '13/04/2026']])
    const first = await (await send('/api/import/preview', { format: 'paste', content })).json() as { missing: string[]; mapping: Record<string, number>; ambiguousDates: number }
    expect(first.missing).toEqual(['company'])
    expect((await send('/api/import/apply', { format: 'paste', content })).status).toBe(400)
    const mapping = { company: 0, title: 1, status: 2, applied: 3 }
    const second = await (await send('/api/import/preview', { format: 'paste', content, mapping, statusMap: { 'in limbo': 'closed:withdrawn' }, dateOrder: 'dmy' })).json() as { ambiguousDates: number; rows: Array<{ status: string; applied: string }> }
    expect(second.ambiguousDates).toBe(1)
    expect(second.rows.map((row) => [row.status, row.applied])).toEqual([['closed:withdrawn', '2026-04-03'], ['applied', '2026-04-13']])
    await send('/api/import/apply', { format: 'paste', content, mapping, statusMap: { 'in limbo': 'closed:withdrawn' }, dateOrder: 'dmy' })
    expect(sqlite.prepare("SELECT a.status,a.outcome FROM applications a JOIN jobs j ON j.id=a.job_id WHERE j.company='Acme'").get()).toEqual({ status: 'closed', outcome: 'withdrawn' })
  })

  it('skips duplicates of saved jobs and of earlier rows, unless asked to keep them', async () => {
    const { sqlite, send } = await setup()
    sqlite.prepare("INSERT INTO jobs(id,company,title,captured_at,source_url,raw_snapshot) VALUES('old','Acme','Platform Engineer','2026-09-01T00:00:00.000Z','https://acme.test/jobs/9','x')").run()
    const content = tsv([header,
      ['Acme Inc', 'Platform Engineer', 'Applied', '2026-10-01', '', '', ''],
      ['Acme', 'Platform Engineer', 'Applied', '2026-10-01', '', '', ''],
      ['Beta', 'Analyst', 'Applied', '2026-10-01', '', 'https://acme.test/jobs/9', ''],
      ['Gamma', 'Designer', 'Applied', '2026-10-01', '', '', ''],
      ['Gamma', 'Designer', 'Applied', '2026-10-02', '', '', '']])
    const preview = await (await send('/api/import/preview', { format: 'paste', content })).json() as { counts: Record<string, number>; rows: Array<{ verdict: string; reason?: string }> }
    expect(preview.counts).toMatchObject({ new: 2, duplicate: 3 })
    expect(preview.rows[2].reason).toBe('Already saved (same link)')
    const done = await (await send('/api/import/apply', { format: 'paste', content })).json() as { added: number }
    expect(done.added).toBe(2)
    expect((await send('/api/import/apply', { format: 'paste', content })).status).toBe(400)
    expect(((await (await send('/api/import/apply', { format: 'paste', content, includeDuplicates: true })).json()) as { added: number }).added).toBe(5)
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM jobs WHERE source='import'").get()).toEqual({ n: 7 })
  })

  it('undoes an import: it removes what is untouched and keeps jobs that have been worked on since', async () => {
    const { sqlite, send } = await setup()
    const content = tsv([header, ['Acme', 'Engineer', 'Applied', '2026-10-01', '', '', ''], ['Beta', 'Analyst', 'Applied', '2026-10-01', '', '', ''], ['Gamma', 'Designer', 'Saved', '', '', '', '']])
    const { batch } = await (await send('/api/import/apply', { format: 'paste', content })).json() as { batch: string }
    sqlite.prepare("INSERT INTO job_answers(id,job_id,question,answer,created_at) VALUES('q1',(SELECT id FROM jobs WHERE company='Acme'),'Why?','Because.','2026-11-01T00:00:00.000Z')").run()
    // A status change of its own on Beta counts as work too.
    sqlite.prepare("INSERT INTO status_events(id,application_id,status,created_at) VALUES('later',(SELECT a.id FROM applications a JOIN jobs j ON j.id=a.job_id WHERE j.company='Beta'),'interviewing','2026-11-02T00:00:00.000Z')").run()
    const undone = await send(`/api/import/${batch}/undo`, {})
    expect(await undone.json()).toEqual({ removed: 1, kept: 2 })
    expect((sqlite.prepare('SELECT company FROM jobs ORDER BY company').all() as Array<{ company: string }>).map((row) => row.company)).toEqual(['Acme', 'Beta'])
    expect((await send(`/api/import/${batch}/undo`, {})).status).toBe(409)
    expect((await send('/api/import/nope/undo', {})).status).toBe(409)
    expect(((await (await send('/api/imports')).json()) as { imports: Array<{ undoneAt: string | null }> }).imports[0].undoneAt).toBeTruthy()
  })

  it('reads an Excel workbook, using real dates and the chosen sheet', async () => {
    const { send } = await setup()
    const workbook = new ExcelJS.Workbook()
    workbook.addWorksheet('Ignore').addRow(['Nothing', 'here'])
    const sheet = workbook.addWorksheet('Applications')
    sheet.addRow(header)
    sheet.addRow(['Acme', 'Engineer', 'Applied', new Date(Date.UTC(2026, 9, 5)), '', { text: 'link', hyperlink: 'https://acme.test/jobs/1' }, { formula: 'A2', result: 'from a formula' }])
    const content = Buffer.from(await workbook.xlsx.writeBuffer()).toString('base64')
    const preview = await (await send('/api/import/preview', { format: 'xlsx', content, sheet: 'Applications' })).json() as { sheets: string[]; sheet: string; counts: Record<string, number>; rows: Array<{ applied: string; url: string; notes: string }> }
    expect(preview.sheets).toEqual(['Ignore', 'Applications'])
    expect(preview.sheet).toBe('Applications')
    expect(preview.counts).toMatchObject({ new: 1 })
    expect(preview.rows[0]).toMatchObject({ applied: '2026-10-05', url: 'https://acme.test/jobs/1', notes: 'from a formula' })
    expect((await send('/api/import/preview', { format: 'xlsx', content: Buffer.from('not a workbook').toString('base64') })).status).toBe(400)
  })

  it('refuses empty input, a file with no rows under the headings, and too many rows', async () => {
    const { send } = await setup()
    expect((await send('/api/import/preview', { format: 'paste', content: '' })).status).toBe(400)
    expect((await send('/api/import/preview', { format: 'paste', content: tsv([header]) })).status).toBe(400)
    const many = tsv([header, ...Array.from({ length: 5001 }, (_, i) => [`Co ${i}`, 'Role', '', '', '', '', ''])])
    const response = await send('/api/import/preview', { format: 'paste', content: many })
    expect(response.status).toBe(400); expect(((await response.json()) as { error: string }).error).toContain('more than 5000')
  })
})

// A minimal zip whose table of contents claims one part of the given unpacked size; nothing in it is real data.
function zipClaiming(size: number) {
  const name = Buffer.from('xl/sheet.xml'), central = Buffer.alloc(46 + name.length), end = Buffer.alloc(22)
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt32LE(size, 24); central.writeUInt16LE(name.length, 28); name.copy(central, 46)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(0, 16)
  return Buffer.concat([central, end])
}

describe('Excel size guard', () => {
  it('reads the unpacked size from the zip table of contents, and says when a file is not a zip', async () => {
    expect(unpackedSize(zipClaiming(1234))).toBe(1234)
    expect(unpackedSize(zipClaiming(0xffffffff))).toBe(Number.POSITIVE_INFINITY)
    expect(unpackedSize(Buffer.from('plain text, not a zip'))).toBeNull()
    const workbook = new ExcelJS.Workbook(); workbook.addWorksheet('Sheet').addRow(['Company', 'Role'])
    const real = Buffer.from(await workbook.xlsx.writeBuffer())
    expect(unpackedSize(real)).toBeGreaterThan(real.length)
  })
  it('refuses a workbook that would unpack to more than 50 MB before opening it', async () => {
    const { send } = await setup()
    for (const size of [60_000_000, 0xffffffff]) {
      const response = await send('/api/import/preview', { format: 'xlsx', content: zipClaiming(size).toString('base64') })
      expect(response.status).toBe(400)
      expect(((await response.json()) as { error: string }).error).toContain('too large to import')
    }
  })
})

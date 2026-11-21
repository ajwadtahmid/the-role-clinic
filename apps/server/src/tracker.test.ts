import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import ExcelJS from 'exceljs'
import { createApp } from './app.js'
import { createDatabase } from './db.js'
import { trackerSummary, csv } from './tracker.js'
import { answerCompanyWarnings, calendarDate, suggestAnswerCategory, type TrackerSummary } from '../../../packages/shared/src/index.js'
import { renderDocx } from './resume-output.js'

const fixtures: Array<{ directory: string; sqlite: ReturnType<typeof createDatabase>['sqlite'] }> = []
afterEach(async () => { for (const f of fixtures.splice(0)) { if (f.sqlite.open) f.sqlite.close(); await rm(f.directory, { recursive: true, force: true }) } })
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'clinic-tracker-')), { sqlite, db } = createDatabase(directory); fixtures.push({ directory, sqlite })
  const modelRouter = { async complete() { throw new Error('The tracker must not call a model') } }
  const app = createApp({ dataDirectory: directory, sqlite, db, port: 3000, modelRouter })
  const request = (path: string, init: RequestInit = {}) => app.request(`http://127.0.0.1:3000${path}`, { ...init, headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', ...init.headers } })
  const send = (path: string, value: unknown, method = 'POST') => request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
  function job(company: string, status = 'new', captured = '2026-10-01T12:00:00.000Z') {
    const id = randomUUID(), applicationId = randomUUID()
    sqlite.prepare('INSERT INTO jobs(id,company,title,captured_at,raw_snapshot,text) VALUES(?,?,?,?,?,?)').run(id, company, 'Software Engineer', captured, 'Raw original', 'Original job description requiring TypeScript and reliable software systems.')
    if (status !== 'new') {
      sqlite.prepare('INSERT INTO applications(id,job_id,status,applied_at,notes) VALUES(?,?,?,?,?)').run(applicationId, id, status, ['applied', 'interviewing', 'closed', 'offer'].includes(status) ? captured : null, '')
      sqlite.prepare('INSERT INTO status_events(id,application_id,status,created_at) VALUES(?,?,?,?)').run(randomUUID(), applicationId, status, captured)
    }
    return id
  }
  return { directory, sqlite, request, send, job }
}
describe('tracker and answers', () => {
  it('migrates v6 submission records to v7 without changing stored answers or artifacts', async () => {
    const f = await setup(), jobId = f.job('Legacy', 'saved')
    await f.send(`/api/jobs/${jobId}/answers`, { question: 'Legacy question?', answer: 'Legacy submitted answer.', category: 'project' })
    await f.send(`/api/jobs/${jobId}/status`, { status: 'applied', submittedText: 'Legacy résumé' }, 'PUT')
    f.sqlite.exec(`BEGIN IMMEDIATE;
      DROP TABLE imports; DROP INDEX jobs_import_batch_idx; ALTER TABLE jobs DROP COLUMN import_batch; DROP TABLE feed_runs; ALTER TABLE applications DROP COLUMN remind_off; ALTER TABLE applications DROP COLUMN outcome; ALTER TABLE status_events DROP COLUMN outcome;
      DROP TABLE tracker_preferences; DROP INDEX job_answers_job_idx;
      ALTER TABLE applications DROP COLUMN follow_up_date;
      DROP TABLE feed_imports;
      DROP INDEX jobs_origin_idx;
      ALTER TABLE jobs DROP COLUMN origin;
      ALTER TABLE jobs DROP COLUMN found_at;
      ALTER TABLE jobs DROP COLUMN posted_at;
      ALTER TABLE jobs DROP COLUMN finder_priority;
      ALTER TABLE jobs DROP COLUMN finder_note;
      ALTER TABLE jobs DROP COLUMN posting_state;
      ALTER TABLE applications DROP COLUMN last_contact_at;
      ALTER TABLE applications DROP COLUMN contacts;
      ALTER TABLE applications DROP COLUMN submitted_job_text;
      ALTER TABLE job_answers DROP COLUMN submitted_question;
      ALTER TABLE job_answers DROP COLUMN submitted_category;
      PRAGMA user_version=6;
    COMMIT;`)
    f.sqlite.close()
    const migrated = createDatabase(f.directory).sqlite
    fixtures.find((entry) => entry.directory === f.directory)!.sqlite = migrated
    expect(migrated.pragma('user_version', { simple: true })).toBe(12)
    expect(migrated.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(migrated.prepare('SELECT submitted_question,submitted_category,submitted_answer FROM job_answers').get()).toEqual({ submitted_question: 'Legacy question?', submitted_category: 'project', submitted_answer: 'Legacy submitted answer.' })
    expect(migrated.prepare('SELECT submitted_text,submitted_job_text FROM applications').get()).toEqual({ submitted_text: 'Legacy résumé', submitted_job_text: 'Original job description requiring TypeScript and reliable software systems.' })
  })
  it('migrates a version 9 database to the current one with the reminder defaults and keeps the saved no-reply days', async () => {
    const f = await setup()
    f.sqlite.exec(`DROP TABLE imports; DROP INDEX jobs_import_batch_idx; ALTER TABLE jobs DROP COLUMN import_batch; DROP TABLE feed_runs; ALTER TABLE applications DROP COLUMN remind_off; ${['reminders_on', 'apply_on', 'apply_days', 'interview_on', 'interview_days', 'noreply_on', 'snooze_days'].map((c) => `ALTER TABLE tracker_preferences DROP COLUMN ${c};`).join(' ')} UPDATE tracker_preferences SET ghosted_days=21; PRAGMA user_version = 9;`)
    f.sqlite.close()
    const migrated = createDatabase(f.directory).sqlite
    fixtures.find((entry) => entry.directory === f.directory)!.sqlite = migrated
    expect(migrated.pragma('user_version', { simple: true })).toBe(12)
    expect(migrated.prepare('SELECT reminders_on,apply_on,apply_days,interview_on,interview_days,noreply_on,ghosted_days,snooze_days FROM tracker_preferences').get()).toEqual({ reminders_on: 1, apply_on: 1, apply_days: 7, interview_on: 1, interview_days: 2, noreply_on: 1, ghosted_days: 21, snooze_days: 3 })
  })
  it('sets follow-up dates from the rules without replacing a date the person chose, and the master switch hides every reminder', async () => {
    const f = await setup(), today = calendarDate(), plus = (n: number) => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
    const date = (id: string) => (f.sqlite.prepare('SELECT follow_up_date AS d FROM applications WHERE job_id=?').get(id) as { d: string | null }).d
    const plain = f.job('Plain', 'saved'), own = f.job('Own', 'saved')
    await f.send(`/api/jobs/${own}/tracker`, { followUpDate: plus(30), lastContactAt: null, contacts: '', notes: '' }, 'PUT')
    await f.send(`/api/jobs/${plain}/status`, { status: 'applied', submittedText: '' }, 'PUT')
    await f.send(`/api/jobs/${own}/status`, { status: 'applied', submittedText: '' }, 'PUT')
    expect(date(plain)).toBe(plus(7)); expect(date(own)).toBe(plus(30))
    await f.send(`/api/jobs/${plain}/status`, { status: 'interviewing' }, 'PUT')
    await f.send(`/api/jobs/${own}/status`, { status: 'interviewing' }, 'PUT')
    // A later date already set is kept; an empty one gets the interview rule.
    const direct = f.job('Direct', 'saved'); await f.send(`/api/jobs/${direct}/status`, { status: 'interviewing' }, 'PUT')
    expect(date(plain)).toBe(plus(7)); expect(date(own)).toBe(plus(30)); expect(date(direct)).toBe(plus(2))
    // Rules off: nothing is set.
    await f.send('/api/tracker/preferences', { applyOn: false }, 'PUT')
    const quiet = f.job('Quiet', 'saved'); await f.send(`/api/jobs/${quiet}/status`, { status: 'applied', submittedText: '' }, 'PUT')
    expect(date(quiet)).toBeNull()
    // Master off hides due follow-ups and suggestions but keeps the dates.
    await f.send(`/api/jobs/${plain}/tracker`, { followUpDate: '2020-01-01', lastContactAt: null, contacts: '', notes: '' }, 'PUT')
    expect(trackerSummary(f.sqlite).followUps.map((j) => j.id)).toContain(plain)
    await f.send('/api/tracker/preferences', { remindersOn: false }, 'PUT')
    const off = trackerSummary(f.sqlite); expect(off.followUps).toEqual([]); expect(off.ghostedSuggestions).toEqual([]); expect(date(plain)).toBe('2020-01-01')
    await f.send('/api/tracker/preferences', { remindersOn: true }, 'PUT')
    expect(trackerSummary(f.sqlite).followUps.map((j) => j.id)).toContain(plain)
    // One application can be silenced.
    await f.send(`/api/jobs/${plain}/tracker`, { followUpDate: '2020-01-01', lastContactAt: null, contacts: '', notes: '', remindOff: true }, 'PUT')
    expect(trackerSummary(f.sqlite).followUps.map((j) => j.id)).not.toContain(plain)
  })
  it('undoing Mark as applied removes the follow-up date the rule set, but keeps one the person chose', async () => {
    const f = await setup(), ruled = f.job('Ruled', 'saved'), chosen = f.job('Chosen', 'saved')
    const date = (id: string) => (f.sqlite.prepare('SELECT follow_up_date AS d FROM applications WHERE job_id=?').get(id) as { d: string | null }).d
    for (const id of [ruled, chosen]) await f.send(`/api/jobs/${id}/status`, { status: 'applied', submittedText: '' }, 'PUT')
    expect(date(ruled)).toBeTruthy()
    await f.send(`/api/jobs/${chosen}/tracker`, { followUpDate: '2099-01-01', lastContactAt: null, contacts: '', notes: '' }, 'PUT')
    for (const id of [ruled, chosen]) expect((await f.send(`/api/jobs/${id}/status`, { status: 'saved', undoApplied: true }, 'PUT')).status).toBe(200)
    expect(date(ruled)).toBeNull(); expect(date(chosen)).toBe('2099-01-01')
  })
  it('returns one application exactly as the full summary shows it, and 404 for an unknown job', async () => {
    const f = await setup(), id = f.job('Acme', 'applied'), other = f.job('Beta', 'interviewing')
    await f.send(`/api/jobs/${id}/tracker`, { followUpDate: '2026-12-01', lastContactAt: null, contacts: 'Jane', notes: 'Call back', remindOff: true }, 'PUT')
    const one = await (await f.request(`/api/tracker/jobs/${id}`)).json() as { job: unknown; preferences: unknown }
    const all = trackerSummary(f.sqlite)
    expect(one.job).toEqual(JSON.parse(JSON.stringify(all.jobs.find((job) => job.id === id))))
    expect(one.preferences).toEqual(all.preferences)
    expect((one.job as { id: string }).id).not.toBe(other)
    expect((await f.request('/api/tracker/jobs/nope')).status).toBe(404)
  })
  it('counts applications sent this week from Monday to today', async () => {
    const f = await setup()
    f.job('Monday', 'applied', '2026-11-16T12:00:00.000Z'); f.job('Wednesday', 'applied', '2026-11-18T12:00:00.000Z'); f.job('Last week', 'applied', '2026-11-15T12:00:00.000Z')
    expect(trackerSummary(f.sqlite, '2026-11-18').appliedThisWeek).toBe(2)
  })
  it('does not suggest closing an application that is snoozed to a future date, or when the no-reply rule is off', async () => {
    const f = await setup(), id = f.job('Quiet Co', 'applied', '2026-09-01T12:00:00.000Z')
    expect(trackerSummary(f.sqlite, '2026-11-06').ghostedSuggestions.map((j) => j.id)).toEqual([id])
    await f.send(`/api/jobs/${id}/tracker`, { followUpDate: '2026-11-09', lastContactAt: null, contacts: '', notes: '' }, 'PUT')
    expect(trackerSummary(f.sqlite, '2026-11-06').ghostedSuggestions).toEqual([])
    expect(trackerSummary(f.sqlite, '2026-11-10').ghostedSuggestions.map((j) => j.id)).toEqual([id])
    await f.send('/api/tracker/preferences', { noReplyOn: false }, 'PUT')
    expect(trackerSummary(f.sqlite, '2026-11-10').ghostedSuggestions).toEqual([])
  })
  it('makes a calendar file for a follow-up date and refuses when there is none', async () => {
    const f = await setup(), id = f.job('Acme, Inc.', 'applied')
    expect((await f.request(`/api/jobs/${id}/follow-up.ics`)).status).toBe(404)
    await f.send(`/api/jobs/${id}/tracker`, { followUpDate: '2026-12-03', lastContactAt: null, contacts: '', notes: '' }, 'PUT')
    const response = await f.request(`/api/jobs/${id}/follow-up.ics`), body = await response.text()
    expect(response.headers.get('content-type')).toContain('text/calendar')
    expect(body).toContain('DTSTART;VALUE=DATE:20261203'); expect(body).toContain('DTEND;VALUE=DATE:20261204'); expect(body).toContain('SUMMARY:Follow up: Software Engineer at Acme\\, Inc.'); expect(body).toContain(`#tracker?job=${id}`)
  })
  it('counts replies this week: interviews, offers and rejections, once per application, and nothing from earlier weeks', async () => {
    const f = await setup(), today = '2026-11-18' // a Wednesday; the week began Monday 2026-11-16
    const event = (id: string, status: string, outcome: string | null, at: string) => f.sqlite.prepare('INSERT INTO status_events(id,application_id,status,outcome,created_at) VALUES(?,(SELECT id FROM applications WHERE job_id=?),?,?,?)').run(randomUUID(), id, status, outcome, at)
    const interview = f.job('A', 'interviewing'), both = f.job('B', 'offer'), rejected = f.job('C', 'closed'), old = f.job('D', 'interviewing'), noReply = f.job('E', 'closed'), applied = f.job('F', 'applied')
    event(interview, 'interviewing', null, '2026-11-17T10:00:00.000Z')
    event(both, 'interviewing', null, '2026-11-16T10:00:00.000Z'); event(both, 'offer', null, '2026-11-18T09:00:00.000Z')
    event(rejected, 'closed', 'rejected', '2026-11-18T12:00:00.000Z')
    event(old, 'interviewing', null, '2026-11-13T10:00:00.000Z')
    event(noReply, 'closed', 'no_reply', '2026-11-17T10:00:00.000Z')
    event(applied, 'applied', null, '2026-11-17T10:00:00.000Z')
    expect(trackerSummary(f.sqlite, today).repliesThisWeek).toBe(3)
    expect(trackerSummary(f.sqlite, '2026-11-22').repliesThisWeek).toBe(3)
    expect(trackerSummary(f.sqlite, '2026-11-23').repliesThisWeek).toBe(0)
  })
  it('keeps due follow-ups separate from quiet suggestions, excludes closed jobs, and requires explicit status changes', async () => {
    const f = await setup(), active = f.job('Acme', 'applied'), closed = f.job('Closed', 'closed')
    for (const id of [active, closed]) expect((await f.send(`/api/jobs/${id}/tracker`, { followUpDate: '2026-11-01', lastContactAt: null, contacts: 'Recruiter', notes: 'Ask about next steps' }, 'PUT')).status).toBe(200)
    let summary = trackerSummary(f.sqlite, '2026-11-06')
    expect(summary.followUps.map((j) => j.id)).toEqual([active]); expect(summary.ghostedSuggestions.map((j) => j.id)).toEqual([active])
    expect(summary.jobs.find((j) => j.id === active)?.status).toBe('applied')
    await f.send(`/api/jobs/${active}/tracker`, { followUpDate: null, lastContactAt: '2026-11-05', contacts: 'Recruiter', notes: 'Heard back' }, 'PUT')
    summary = trackerSummary(f.sqlite, '2026-11-06'); expect(summary.followUps).toEqual([]); expect(summary.ghostedSuggestions).toEqual([])
    expect((await f.send('/api/tracker/preferences', { ghostedDays: 1 }, 'PUT')).status).toBe(200)
    expect(trackerSummary(f.sqlite, '2026-11-06').ghostedSuggestions.map((j) => j.id)).toEqual([active])
    expect((await f.send('/api/tracker/preferences', { ghostedDays: 0 }, 'PUT')).status).toBe(400)
    expect((await f.send(`/api/jobs/${active}/tracker`, { followUpDate: '2026-02-30', lastContactAt: null, contacts: '', notes: '' }, 'PUT')).status).toBe(400)
    expect((await f.send(`/api/jobs/${active}/tracker`, { followUpDate: null, lastContactAt: '2099-01-01', contacts: '', notes: '' }, 'PUT')).status).toBe(400)
  })
  it('keeps cumulative funnel history after rejection and filters tracker rows and export rows consistently', async () => {
    const f = await setup(), first = f.job('Acme', 'interviewing'), second = f.job('Globex', 'saved')
    await f.send(`/api/jobs/${first}/status`, { status: 'closed', outcome: 'rejected' }, 'PUT')
    const response = await f.request('/api/tracker?status=tracker&company=Acme&after=2026-10-01&before=2026-10-01')
    const result = await response.json() as TrackerSummary
    expect(result.jobs.map((j) => j.id)).toEqual([first])
    expect(result.funnel.find((s) => s.status === 'applied')?.count).toBe(1); expect(result.funnel.find((s) => s.status === 'interviewing')?.count).toBe(1); expect(result.funnel[0].count).toBe(2)
    expect((await f.request('/api/tracker?after=2026-11-01&before=2026-10-01')).status).toBe(400)
    const csv = await (await f.request('/api/tracker/export/applications.csv?company=Acme')).text()
    expect(csv).toContain('Acme'); expect(csv).not.toContain('Globex'); expect(second).toBeTruthy()
  })
  it('reads old status history (screening, accepted) as interviewing and an accepted ending in the funnel', async () => {
    const f = await setup(), legacy = f.job('Legacy', 'closed'), current = f.job('Current', 'closed')
    const application = (jobId: string) => (f.sqlite.prepare('SELECT id FROM applications WHERE job_id=?').get(jobId) as { id: string }).id
    f.sqlite.prepare('INSERT INTO status_events(id,application_id,status,created_at) VALUES(?,?,?,?)').run(randomUUID(), application(legacy), 'screening', '2026-10-02T00:00:00.000Z')
    f.sqlite.prepare('INSERT INTO status_events(id,application_id,status,created_at) VALUES(?,?,?,?)').run(randomUUID(), application(legacy), 'accepted', '2026-10-03T00:00:00.000Z')
    expect((await f.send(`/api/jobs/${current}/status`, { status: 'interviewing' }, 'PUT')).status).toBe(200)
    expect((await f.send(`/api/jobs/${current}/status`, { status: 'closed', outcome: 'withdrawn' }, 'PUT')).status).toBe(200)
    const funnel = Object.fromEntries(trackerSummary(f.sqlite, '2026-11-06').funnel.map((step) => [step.status, step.count]))
    expect(funnel).toEqual({ saved: 2, applied: 2, interviewing: 2, offer: 1, accepted: 1 })
  })
  it('counts each latest-draft gap once per tracked job and omits superseded runs and skipped jobs', async () => {
    const f = await setup(), one = f.job('Acme', 'saved'), two = f.job('Globex', 'applied'), skipped = f.job('Skipped', 'skipped')
    const gap = { requirementId: randomUUID(), quote: 'TypeScript', reason: 'No demonstrated evidence', evidenceIds: [] }
    function draft(jobId: string, gaps: unknown[]) {
      const id = randomUUID(); f.sqlite.prepare('INSERT INTO runs(id,job_id,kind,status,step,created_at) VALUES(?,?,?,?,?,?)').run(id, jobId, 'tailor', 'done', 'complete', '2026-10-01')
      f.sqlite.prepare('INSERT INTO tailored(id,job_id,run_id,snapshot_hash,document,created_at) VALUES(?,?,?,?,?,?)').run(id, jobId, id, 'x'.repeat(64), JSON.stringify({ gaps }), '2026-10-01')
    }
    draft(one, [{ ...gap, quote: 'Rust' }]); draft(one, [gap, gap]); draft(two, [gap]); draft(skipped, [gap])
    const summary = trackerSummary(f.sqlite)
    expect(summary.analyzedJobs).toBe(2); expect(summary.gaps).toHaveLength(1); expect(summary.gaps[0].count).toBe(2); expect(summary.gaps[0].label).toBe('TypeScript')
  })
  it('suggests categories, ranks same-category answers and validates provenance and company boundaries', async () => {
    const f = await setup(), acme = f.job('Acme', 'interviewing'), globex = f.job('Globex', 'saved'), extra = f.job('C++ Co.', 'saved')
    const answer = await (await f.send(`/api/jobs/${acme}/answers`, { question: 'Why join our company?', answer: 'I want to join Acme to build APIs.', charLimit: 100 })).json() as { id: string }
    await f.send(`/api/jobs/${extra}/answers`, { question: 'Expected salary?', answer: 'Discuss compensation.', category: 'salary' })
    const similar = await (await f.request(`/api/answers/similar?jobId=${globex}&question=Why%20join%20our%20company`)).json() as { answers: Array<{ id: string; category: string; status: string }> }
    expect(similar.answers[0]).toMatchObject({ id: answer.id, category: 'why-us', status: 'interviewing' })
    const reused = await f.send(`/api/jobs/${globex}/answers`, { question: 'Why Globex?', answer: 'I want to join Acme.', category: 'why-us', reusedFrom: answer.id })
    expect(reused.status).toBe(201)
    expect((f.sqlite.prepare('SELECT reused_from FROM job_answers WHERE job_id=?').get(globex) as { reused_from: string }).reused_from).toBe(answer.id)
    expect((await f.send(`/api/jobs/${globex}/answers`, { question: 'Why?', answer: 'Example', reusedFrom: randomUUID() })).status).toBe(400)
    const warnings = await (await f.send('/api/answers/reuse-check', { jobId: globex, answer: 'Acme and C++ Co. are interesting; MacroAcme is different.' })).json() as { warnings: string[] }
    expect(warnings.warnings).toHaveLength(2)
    expect(answerCompanyWarnings('MacroAcme and globex', 'Globex', ['Acme', 'Globex'])).toEqual([])
    expect(suggestAnswerCategory('When are you available?')).toBe('availability')
    expect(suggestAnswerCategory('Why are you leaving?')).toBe('why-leaving')
    const punctuation = await (await f.request('/api/answers?q=%22%20OR%20%28')).json() as { answers: unknown[] }; expect(punctuation.answers).toEqual([])
  })
  it('freezes submitted questions, categories, answers, résumé and JD while working answers continue to change', async () => {
    const f = await setup(), id = f.job('Acme', 'saved')
    const answer = await (await f.send(`/api/jobs/${id}/answers`, { question: 'Original question?', answer: 'Original answer.', category: 'project' })).json() as { id: string }
    await f.send(`/api/jobs/${id}/status`, { status: 'applied', submittedText: 'Original submitted résumé' }, 'PUT')
    await f.send(`/api/jobs/${id}/answers/${answer.id}`, { question: 'Changed working question?', answer: 'Changed working answer.', category: 'salary' }, 'PUT')
    await f.send(`/api/jobs/${id}/answers`, { question: 'After submission?', answer: 'This was not sent.' })
    f.sqlite.prepare('UPDATE jobs SET text=? WHERE id=?').run('Changed JD after submission', id)
    const submitted = await (await f.request(`/api/jobs/${id}/submitted`)).json() as { submittedText: string; jobText: string; answers: Array<{ question: string; answer: string; category: string }> }
    expect(submitted.submittedText).toBe('Original submitted résumé'); expect(submitted.jobText).toContain('Original job description'); expect(submitted.answers).toEqual([expect.objectContaining({ question: 'Original question?', answer: 'Original answer.', category: 'project' })])
    const csv = await (await f.request('/api/tracker/export/qa.csv')).text()
    expect(csv).toContain('Original question?'); expect(csv).toContain('Original answer.'); expect(csv).toContain('Changed working answer.')
    const workbook = new ExcelJS.Workbook(), exported = await f.request('/api/tracker/export/xlsx')
    expect(exported.status).toBe(200); await workbook.xlsx.load(Buffer.from(await exported.arrayBuffer()) as unknown as Parameters<typeof workbook.xlsx.load>[0])
    expect(workbook.worksheets.map((s) => s.name)).toEqual(['Applications', 'Q&A'])
    const qa = workbook.getWorksheet('Q&A')!; expect(qa.rowCount).toBe(3)
    const late = [qa.getRow(2), qa.getRow(3)].find((r) => r.getCell(5).value === 'After submission?')!
    expect(late.getCell(6).value).toBe(''); expect(late.getCell(11).value).toBe('This was not sent.')
  })
  it('attaches a real sent copy without marking applied, then records only a same-job artifact', async () => {
    const f = await setup(), id = f.job('Acme', 'saved'), other = f.job('Globex', 'saved')
    const file = await renderDocx([{ id: 'name', kind: 'name', text: 'Example Candidate' }, { id: 'line', kind: 'text', text: 'Built reliable TypeScript software systems and APIs.' }])
    const form = new FormData(); form.set('file', new File([new Uint8Array(file.buffer)], 'actual-sent.docx'))
    const response = await f.request(`/api/jobs/${id}/submitted-resume`, { method: 'POST', body: form }); expect(response.status).toBe(201)
    const artifact = await response.json() as { id: string }
    expect((f.sqlite.prepare('SELECT status FROM applications WHERE job_id=?').get(id) as { status: string }).status).toBe('saved')
    expect((await f.send(`/api/jobs/${other}/status`, { status: 'applied', submittedArtifactId: artifact.id }, 'PUT')).status).toBe(422)
    expect((await f.send(`/api/jobs/${id}/status`, { status: 'applied', submittedArtifactId: artifact.id }, 'PUT')).status).toBe(200)
    const download = await f.request(`/api/jobs/${id}/artifacts/${artifact.id}`); expect(Buffer.from(await download.arrayBuffer()).equals(file.buffer)).toBe(true)
    const submitted = await (await f.request(`/api/jobs/${id}/submitted`)).json() as { submittedText: string; filename: string }
    expect(submitted.submittedText).toContain('Built reliable TypeScript'); expect(submitted.filename).toBe('actual-sent.docx')
  })
  it('exports formulas as literal text and protects CSV quoting and multiline fields', async () => {
    const f = await setup(), id = f.job('=HYPERLINK("bad")', 'saved')
    await f.send(`/api/jobs/${id}/tracker`, { followUpDate: null, lastContactAt: null, contacts: '+contact', notes: 'Line 1, "quoted"\nLine 2' }, 'PUT')
    const output = await (await f.request('/api/tracker/export/applications.csv')).text()
    expect(output).toContain('"\'=HYPERLINK(""bad"")"'); expect(output).toContain('"\'+contact"'); expect(output).toContain('"Line 1, ""quoted""\nLine 2"')
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(Buffer.from(await (await f.request('/api/tracker/export/xlsx')).arrayBuffer()) as unknown as Parameters<typeof workbook.xlsx.load>[0])
    expect(workbook.getWorksheet('Applications')!.getCell('A2').value).toBe('=HYPERLINK("bad")')
    expect(csv([['@test', '\t=1', 'ordinary']])).toContain('"\'@test","\'\t=1","ordinary"')
    await f.send(`/api/jobs/${id}/status`, { status: 'applied', submittedText: 'x'.repeat(33000) }, 'PUT')
    expect((await f.request('/api/tracker/export/xlsx')).status).toBe(422)
    expect((await f.request('/api/tracker/export/applications.csv')).status).toBe(200)
  })

  it('treats % and _ in a job search as literal text, and only the word "us" as a why-us cue', async () => {
    const f = await setup()
    const literal = f.job('Acme 100% Remote'), other = f.job('Acme 1000 Remote')
    const ids = async (q: string) => ((await (await f.request(`/api/jobs?q=${encodeURIComponent(q)}`)).json()) as { jobs: Array<{ id: string }> }).jobs.map((j) => j.id)
    expect(await ids('100%')).toEqual([literal])
    expect(await ids('Acme 100_ Remote')).toEqual([])
    expect(await ids('Acme')).toHaveLength(2)
    expect(other).toBeTruthy()
    expect(suggestAnswerCategory('Why do you want to work with us?')).toBe('why-us')
    expect(suggestAnswerCategory('Why did you choose a career in business?')).toBe('other')
  })

  it('reads the job list and tracker with a fixed number of queries however many jobs exist', async () => {
    const f = await setup()
    const withKnockout = f.job('Acme', 'applied')
    const requirement = { id: randomUUID(), quote: '5+ years required', kind: 'knockout', category: 'years', skill: '', years: 5, start: 0, end: 17, assessment: 'unknown', basis: '' }
    f.sqlite.prepare('INSERT INTO requirements(id,job_id,document,created_at) VALUES(?,?,?,?)').run(randomUUID(), withKnockout, JSON.stringify({ requirements: [requirement], seniority: '', vocabulary: [], partial: false }), '2026-10-02T00:00:00.000Z')
    const countQueries = async () => {
      let count = 0
      const original = f.sqlite.prepare.bind(f.sqlite)
      f.sqlite.prepare = ((sql: string) => { count++; return original(sql) }) as typeof f.sqlite.prepare
      try { trackerSummary(f.sqlite); await f.request('/api/jobs') } finally { f.sqlite.prepare = original as typeof f.sqlite.prepare }
      return count
    }
    const few = await countQueries()
    for (let i = 0; i < 40; i++) f.job(`Company ${i}`, i % 2 ? 'saved' : 'new')
    expect(await countQueries()).toBe(few)
    const tracked = await (await f.request('/api/tracker')).json() as TrackerSummary
    expect(tracked.jobs.find((j) => j.id === withKnockout)?.knockouts).toHaveLength(1)
    const listed = await (await f.request('/api/jobs')).json() as { jobs: Array<{ id: string; knockouts: unknown[] }> }
    expect(listed.jobs.find((j) => j.id === withKnockout)?.knockouts).toHaveLength(1)
    expect(listed.jobs).toHaveLength(41)
  })
})

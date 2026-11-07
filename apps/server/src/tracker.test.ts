import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import ExcelJS from 'exceljs'
import { createApp } from './app.js'
import { createDatabase } from './db.js'
import { trackerSummary, csv } from './tracker.js'
import { answerCompanyWarnings, suggestAnswerCategory, type TrackerSummary } from '../../../packages/shared/src/index.js'
import { renderDocx } from './resume-output.js'

const fixtures: Array<{ directory: string; sqlite: ReturnType<typeof createDatabase>['sqlite'] }> = []
afterEach(async () => { for (const f of fixtures.splice(0)) { if (f.sqlite.open) f.sqlite.close(); await rm(f.directory, { recursive: true, force: true }) } })
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'clinic-tracker-')), { sqlite, db } = createDatabase(directory); fixtures.push({ directory, sqlite })
  const modelRouter = { async complete() { throw new Error('Phase 6 must not call a model') } }
  const app = createApp({ dataDirectory: directory, sqlite, db, port: 3000, modelRouter })
  const request = (path: string, init: RequestInit = {}) => app.request(`http://127.0.0.1:3000${path}`, { ...init, headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', ...init.headers } })
  const send = (path: string, value: unknown, method = 'POST') => request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
  function job(company: string, status = 'new', captured = '2026-10-01T12:00:00.000Z') {
    const id = randomUUID(), applicationId = randomUUID()
    sqlite.prepare('INSERT INTO jobs(id,company,title,captured_at,raw_snapshot,text) VALUES(?,?,?,?,?,?)').run(id, company, 'Software Engineer', captured, 'Raw original', 'Original job description requiring TypeScript and reliable software systems.')
    if (status !== 'new') {
      sqlite.prepare('INSERT INTO applications(id,job_id,status,applied_at,notes) VALUES(?,?,?,?,?)').run(applicationId, id, status, ['applied', 'interviewing', 'rejected', 'offer'].includes(status) ? captured : null, '')
      sqlite.prepare('INSERT INTO status_events(id,application_id,status,created_at) VALUES(?,?,?,?)').run(randomUUID(), applicationId, status, captured)
    }
    return id
  }
  return { directory, sqlite, request, send, job }
}
describe('Phase 6 tracker and answers', () => {
  it('migrates v6 submission records to v7 without changing stored answers or artifacts', async () => {
    const f = await setup(), jobId = f.job('Legacy', 'saved')
    await f.send(`/api/jobs/${jobId}/answers`, { question: 'Legacy question?', answer: 'Legacy submitted answer.', category: 'project' })
    await f.send(`/api/jobs/${jobId}/status`, { status: 'applied', submittedText: 'Legacy résumé' }, 'PUT')
    f.sqlite.exec(`BEGIN IMMEDIATE;
      DROP TABLE tracker_preferences; DROP INDEX job_answers_job_idx;
      ALTER TABLE applications DROP COLUMN follow_up_date;
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
    expect(migrated.pragma('user_version', { simple: true })).toBe(7)
    expect(migrated.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(migrated.prepare('SELECT submitted_question,submitted_category,submitted_answer FROM job_answers').get()).toEqual({ submitted_question: 'Legacy question?', submitted_category: 'project', submitted_answer: 'Legacy submitted answer.' })
    expect(migrated.prepare('SELECT submitted_text,submitted_job_text FROM applications').get()).toEqual({ submitted_text: 'Legacy résumé', submitted_job_text: 'Original job description requiring TypeScript and reliable software systems.' })
  })
  it('keeps due follow-ups separate from quiet suggestions, excludes closed jobs, and requires explicit status changes', async () => {
    const f = await setup(), active = f.job('Acme', 'applied'), closed = f.job('Closed', 'rejected')
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
    await f.send(`/api/jobs/${first}/status`, { status: 'rejected' }, 'PUT')
    const response = await f.request('/api/tracker?status=tracker&company=Acme&after=2026-10-01&before=2026-10-01')
    const result = await response.json() as TrackerSummary
    expect(result.jobs.map((j) => j.id)).toEqual([first])
    expect(result.funnel.find((s) => s.status === 'applied')?.count).toBe(1); expect(result.funnel.find((s) => s.status === 'interviewing')?.count).toBe(1); expect(result.funnel[0].count).toBe(2)
    expect((await f.request('/api/tracker?after=2026-11-01&before=2026-10-01')).status).toBe(400)
    const csv = await (await f.request('/api/tracker/export/applications.csv?company=Acme')).text()
    expect(csv).toContain('Acme'); expect(csv).not.toContain('Globex'); expect(second).toBeTruthy()
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

import type { Context, Hono } from 'hono'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import ExcelJS from 'exceljs'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { applicationStatuses, calendarDate, answerCompanyWarnings } from '../../../packages/shared/src/index.js'
import { parseResumeFile } from './master.js'
import { addDays, csv, dateOnly, filterTrackerJobs, followUpPreferences, libraryAnswers, similarAnswers, trackerJob, trackerSummary } from './tracker.js'

const date = z.string().refine(dateOnly, 'Use a real calendar date (YYYY-MM-DD).')
const metadataSchema = z.object({ followUpDate: date.nullable(), lastContactAt: date.nullable(), contacts: z.string().trim().max(5000), notes: z.string().trim().max(5000), remindOff: z.boolean().optional() }).strict()
export function registerTrackerRoutes(app: Hono, sqlite: Database.Database, dataDirectory: string) {
  const safe = (fn: (context: Context) => Promise<Response>) => async (context: Context) => {
    try { return await fn(context) }
    catch (error) { if (error instanceof z.ZodError) return context.json({ error: error.issues.map((i) => i.message).join(' ') }, 400); throw error }
  }
  const exists = (jobId: string) => Boolean(sqlite.prepare('SELECT 1 FROM jobs WHERE id=?').get(jobId))
  function filters(context: Context) {
    const value = z.object({ q: z.string().max(200).optional(), status: z.enum([...applicationStatuses, 'tracker', '']).optional(), company: z.string().max(200).optional(), after: date.optional(), before: date.optional() }).parse(context.req.query())
    if (value.after && value.before && value.after > value.before) throw new z.ZodError([{ code: 'custom', path: [], message: 'The start date must precede the end date.' }])
    return value
  }
  app.get('/api/tracker', safe(async (context) => {
    const result = trackerSummary(sqlite)
    return context.json({ ...result, jobs: filterTrackerJobs(result.jobs, filters(context)) })
  }))
  app.get('/api/tracker/jobs/:id', safe(async (context) => { const found = trackerJob(sqlite, context.req.param('id')!); return found ? context.json(found) : context.json({ error: 'Job not found.' }, 404) }))
  app.get('/api/tracker/preferences', safe(async (context) => context.json(followUpPreferences(sqlite))))
  // What the open-app message needs: how many follow-ups are due and how many applications might be closed.
  app.get('/api/tracker/reminders', safe(async (context) => { const summary = trackerSummary(sqlite); return context.json({ on: summary.preferences.remindersOn, due: summary.followUps.length, suggestions: summary.ghostedSuggestions.length }) }))
  const days = (max: number) => z.number().int().min(1).max(max)
  const preferenceSchema = z.object({ remindersOn: z.boolean(), applyOn: z.boolean(), applyDays: days(90), interviewOn: z.boolean(), interviewDays: days(90), noReplyOn: z.boolean(), ghostedDays: days(365), snoozeDays: days(60) }).partial().strict()
  app.put('/api/tracker/preferences', safe(async (context) => {
    const value = preferenceSchema.parse(await context.req.json().catch(() => null))
    const columns: Record<string, string> = { remindersOn: 'reminders_on', applyOn: 'apply_on', applyDays: 'apply_days', interviewOn: 'interview_on', interviewDays: 'interview_days', noReplyOn: 'noreply_on', ghostedDays: 'ghosted_days', snoozeDays: 'snooze_days' }
    for (const [key, column] of Object.entries(columns)) {
      const given = (value as Record<string, number | boolean | undefined>)[key]
      if (given !== undefined) sqlite.prepare(`UPDATE tracker_preferences SET ${column}=? WHERE id=1`).run(typeof given === 'boolean' ? Number(given) : given)
    }
    return context.json(followUpPreferences(sqlite))
  }))
  // One calendar entry for the follow-up date, made here and downloaded; it holds only what the job page already shows.
  app.get('/api/jobs/:id/follow-up.ics', safe(async (context) => {
    const row = sqlite.prepare('SELECT j.id,j.company,j.title,a.follow_up_date AS day FROM jobs j JOIN applications a ON a.job_id=j.id WHERE j.id=?').get(context.req.param('id')!) as { id: string; company: string; title: string; day: string | null } | undefined
    if (!row?.day) return context.json({ error: 'This job has no follow-up date.' }, 404)
    const escape = (text: string) => text.replace(/[\\;,]/g, '\\$&').replace(/\r\n|\r|\n/g, '\\n')
    const origin = new URL(context.req.url).origin, compact = row.day.replaceAll('-', ''), next = addDays(row.day, 1).replaceAll('-', '')
    const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//The Role Clinic//Follow-up//EN', 'BEGIN:VEVENT', `UID:${row.id}-${compact}@role-clinic.local`,
      `DTSTAMP:${new Date().toISOString().replace(/[-:]|\.\d{3}/g, '')}`, `DTSTART;VALUE=DATE:${compact}`, `DTEND;VALUE=DATE:${next}`,
      `SUMMARY:${escape(`Follow up: ${row.title} at ${row.company}`)}`, `DESCRIPTION:${escape(`Open in Role Clinic: ${origin}/#tracker?job=${row.id}`)}`, 'END:VEVENT', 'END:VCALENDAR']
    return new Response(body.join('\r\n') + '\r\n', { headers: { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'attachment; filename="follow-up.ics"' } })
  }))
  app.put('/api/jobs/:id/tracker', safe(async (context) => {
    const jobId = context.req.param('id')!
    if (!exists(jobId)) return context.json({ error: 'Job not found.' }, 404)
    const value = metadataSchema.parse(await context.req.json().catch(() => null))
    if (value.lastContactAt && value.lastContactAt > calendarDate()) return context.json({ error: 'Last contact cannot be in the future.' }, 400)
    sqlite.prepare(`INSERT INTO applications(id,job_id,status,notes,contacts,follow_up_date,last_contact_at,remind_off) VALUES(?,?,'new',?,?,?,?,?)
      ON CONFLICT(job_id) DO UPDATE SET notes=excluded.notes,contacts=excluded.contacts,follow_up_date=excluded.follow_up_date,last_contact_at=excluded.last_contact_at,remind_off=COALESCE(?,remind_off)`).run(randomUUID(), jobId, value.notes, value.contacts, value.followUpDate, value.lastContactAt, Number(value.remindOff ?? 0), value.remindOff === undefined ? null : Number(value.remindOff))
    return context.json({ ok: true })
  }))
  app.get('/api/jobs/:id/submitted', safe(async (context) => {
    const jobId = context.req.param('id')!
    const row = sqlite.prepare(`SELECT j.company,j.title,j.text AS originalJobText,a.submitted_job_text AS jobText,a.applied_at AS appliedAt,a.submitted_text AS submittedText,a.submitted_artifact_id AS artifactId,json_extract(art.document,'$.filename') AS filename FROM jobs j LEFT JOIN applications a ON a.job_id=j.id LEFT JOIN artifacts art ON art.id=a.submitted_artifact_id WHERE j.id=?`).get(jobId) as { jobText: string | null; originalJobText: string; [key: string]: unknown } | undefined
    if (!row) return context.json({ error: 'Job not found.' }, 404)
    const { originalJobText, ...record } = row
    const answers = sqlite.prepare('SELECT id,COALESCE(submitted_question,question) AS question,submitted_answer AS answer,submitted_at AS submittedAt,COALESCE(submitted_category,category) AS category FROM job_answers WHERE job_id=? AND submitted_at IS NOT NULL ORDER BY created_at,rowid').all(jobId)
    return context.json({ ...record, jobText: row.jobText ?? originalJobText, answers })
  }))
  app.post('/api/jobs/:id/submitted-resume', safe(async (context) => {
    const jobId = context.req.param('id')!
    if (!exists(jobId)) return context.json({ error: 'Job not found.' }, 404)
    const form = await context.req.formData().catch(() => null), file = form?.get('file')
    if (!file || typeof file === 'string' || !('arrayBuffer' in file)) return context.json({ error: 'Choose a PDF or DOCX résumé.' }, 400)
    if (file.size > 8_000_000) return context.json({ error: 'Résumé files must be 8 MB or smaller.' }, 413)
    const bytes = Buffer.from(await file.arrayBuffer())
    let sourceText: string
    try { sourceText = (await parseResumeFile(bytes, file.name)).sourceText } catch (error) { return context.json({ error: (error as Error).message }, 422) }
    const extension = file.name.toLowerCase().endsWith('.pdf') ? 'pdf' : 'docx'
    const filename = file.name.replace(/[^\p{L}\p{N}_.-]+/gu, '-').slice(-180) || `submitted.${extension}`
    const id = randomUUID(), directory = join(dataDirectory, 'artifacts'), filePath = join(directory, `${id}.${extension}`)
    await mkdir(directory, { recursive: true, mode: 0o700 }); await writeFile(filePath, bytes, { mode: 0o600, flag: 'wx' })
    const mediaType = extension === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    try { sqlite.prepare('INSERT INTO artifacts(id,job_id,file_path,media_type,parse_check,created_at,document) VALUES(?,?,?,?,?,?,?)').run(id, jobId, filePath, mediaType, JSON.stringify({ ok: true, kind: 'uploaded-readable-text' }), new Date().toISOString(), JSON.stringify({ source: 'attached', filename, blocks: [{ text: sourceText }] })) }
    catch (error) { await rm(filePath, { force: true }); throw error }
    return context.json({ id, filename }, 201)
  }))
  app.get('/api/answers', safe(async (context) => {
    const query = z.string().max(200).parse(context.req.query('q') ?? ''), category = z.string().max(80).parse(context.req.query('category') ?? '')
    const answers = libraryAnswers(sqlite, query, category), categories = sqlite.prepare('SELECT DISTINCT category FROM job_answers ORDER BY category COLLATE NOCASE').all() as Array<{ category: string }>
    return context.json({ answers, categories: categories.map((c) => c.category) })
  }))
  app.get('/api/answers/similar', safe(async (context) => {
    const jobId = context.req.query('jobId') ?? '', question = z.string().max(2000).parse(context.req.query('question') ?? ''), category = z.string().max(80).parse(context.req.query('category') ?? '')
    if (!exists(jobId)) return context.json({ error: 'Choose a saved target job.' }, 404)
    return context.json({ answers: similarAnswers(sqlite, jobId, question, category) })
  }))
  app.post('/api/answers/reuse-check', safe(async (context) => {
    const value = z.object({ jobId: z.string().min(1), answer: z.string().max(20000) }).strict().parse(await context.req.json().catch(() => null))
    const job = sqlite.prepare('SELECT company FROM jobs WHERE id=?').get(value.jobId) as { company: string } | undefined
    if (!job) return context.json({ error: 'Job not found.' }, 404)
    const companies = (sqlite.prepare('SELECT DISTINCT company FROM jobs').all() as Array<{ company: string }>).map((row) => row.company)
    return context.json({ warnings: answerCompanyWarnings(value.answer, job.company, companies) })
  }))
  app.get('/api/tracker/export/:format', safe(async (context) => {
    const format = context.req.param('format')
    if (!['xlsx', 'applications.csv', 'qa.csv'].includes(format!)) return context.json({ error: 'Choose XLSX, applications.csv or qa.csv.' }, 400)
    const jobs = filterTrackerJobs(trackerSummary(sqlite).jobs, filters(context)), jobIds = new Set(jobs.map((j) => j.id))
    const answers = libraryAnswers(sqlite).filter((a) => jobIds.has(a.jobId))
    const applications: unknown[][] = [['Company', 'Role', 'Status', 'Outcome', 'URL', 'Source', 'Location', 'Remote', 'Salary', 'Captured', 'Applied', 'Follow-up', 'Last contact', 'Contacts', 'Notes', 'Version sent', 'Submitted text', 'Q&A count', 'API cost USD']]
    const submitted = sqlite.prepare('SELECT submitted_text AS text FROM applications WHERE job_id=?')
    for (const j of jobs) applications.push([j.company, j.title, j.status, j.outcome, j.sourceUrl, j.source, j.location, j.remote, j.salary, j.capturedAt, j.appliedAt, j.followUpDate, j.lastContactAt, j.contacts, j.notes, j.submittedFilename || (j.hasSubmittedText ? 'Recorded text' : ''), (submitted.get(j.id) as { text: string | null } | undefined)?.text, j.answerCount, j.costUsd])
    const frozenAnswer = sqlite.prepare('SELECT submitted_question AS question,submitted_category AS category FROM job_answers WHERE id=?')
    const qa: unknown[][] = [['Company', 'Role', 'Status', 'Category', 'Question', 'Submitted answer or current if not applied', 'Applied', 'Reused from', 'Character limit', 'Submitted', 'Current working answer']]
    for (const a of answers) { const frozen = frozenAnswer.get(a.id) as { question: string | null; category: string | null }; qa.push([a.company, a.title, a.status, a.appliedAt && a.submittedAt ? frozen.category ?? a.category : a.category, a.appliedAt && a.submittedAt ? frozen.question ?? a.question : a.question, a.appliedAt ? a.submittedAnswer ?? '' : a.answer, a.appliedAt, a.reusedFrom, a.charLimit, a.submittedAt, a.answer]) }
    context.header('Cache-Control', 'no-store')
    context.header('Content-Disposition', `attachment; filename="${format === 'xlsx' ? 'role-clinic.xlsx' : format}"`)
    if (format !== 'xlsx') { context.header('Content-Type', 'text/csv; charset=utf-8'); return context.body(csv(format === 'qa.csv' ? qa : applications)) }
    if ([...applications, ...qa].some((row) => row.some((value) => typeof value === 'string' && value.length > 32767))) return context.json({ error: 'A field exceeds the XLSX cell text limit. Use CSV to preserve the complete text.' }, 422)
    const workbook = new ExcelJS.Workbook()
    for (const [name, rows] of [['Applications', applications], ['Q&A', qa]] as const) {
      const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] })
      sheet.addRows(rows); sheet.getRow(1).font = { bold: true }; sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(rows.length, 1), column: rows[0].length } }
      sheet.columns.forEach((column, i) => { column.width = i === 0 ? 24 : i === 1 ? 35 : 22 }); sheet.eachRow((row) => { row.alignment = { vertical: 'top', wrapText: true } })
    }
    context.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    return context.body(new Uint8Array(await workbook.xlsx.writeBuffer()))
  }))
}

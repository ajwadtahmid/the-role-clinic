import type Database from 'better-sqlite3'
import { type Extraction, type Gap, type LibraryAnswer, type TrackerJob, type TrackerSummary, suggestAnswerCategory, calendarDate } from '../../../packages/shared/src/index.js'
import { listSynonyms, readMaster, readProfile } from './master.js'
import { assessRequirement } from './pipeline-core.js'

export const dateOnly = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
export const quietStatuses = new Set(['applied', 'screening', 'interviewing'])
// The newest row of `requirements` or `tailored` for every job, in one query (not one query per job).
// `expression` picks what to read from each row, for example 't.document' or a json_extract of it.
export function latestByJob(sqlite: Database.Database, table: 'requirements' | 'tailored', expression: string): Map<string, string | null> {
  const rows = sqlite.prepare(`SELECT t.job_id AS jobId, ${expression} AS value FROM ${table} t WHERE t.rowid=(SELECT t2.rowid FROM ${table} t2 WHERE t2.job_id=t.job_id ORDER BY t2.created_at DESC,t2.rowid DESC LIMIT 1)`).all() as Array<{ jobId: string; value: string | null }>
  return new Map(rows.map((row) => [row.jobId, row.value]))
}
export function trackerSummary(sqlite: Database.Database, today = calendarDate()): TrackerSummary {
  const jobs = sqlite.prepare(`SELECT j.id,j.company,j.title,j.source_url AS sourceUrl,j.source,j.location,j.remote,j.salary,j.captured_at AS capturedAt,
    COALESCE(a.status,'new') AS status,a.applied_at AS appliedAt,a.follow_up_date AS followUpDate,a.last_contact_at AS lastContactAt,
    COALESCE(a.notes,'') AS notes,COALESCE(a.contacts,'') AS contacts,a.submitted_artifact_id AS submittedArtifactId,
    json_extract(art.document,'$.filename') AS submittedFilename,a.submitted_text IS NOT NULL AS hasSubmittedText,
    (SELECT COUNT(*) FROM job_answers WHERE job_id=j.id) AS answerCount,
    MAX(COALESCE(a.last_contact_at,''),COALESCE((SELECT MAX(created_at) FROM status_events WHERE application_id=a.id),j.captured_at)) AS lastActivityAt,
    COALESCE((SELECT SUM(COALESCE(json_extract(usage,'$.totalUsd'),0)) FROM runs WHERE job_id=j.id),0) AS costUsd
    FROM jobs j LEFT JOIN applications a ON a.job_id=j.id LEFT JOIN artifacts art ON art.id=a.submitted_artifact_id
    ORDER BY j.captured_at DESC,j.rowid DESC`).all() as TrackerJob[]
  const master = readMaster(sqlite).document, profile = readProfile(sqlite).document, synonyms = listSynonyms(sqlite)
  const requirementDocuments = latestByJob(sqlite, 'requirements', 't.document')
  const gapDocuments = latestByJob(sqlite, 'tailored', "json_extract(t.document,'$.gaps')")
  const gaps = new Map<string, TrackerSummary['gaps'][number]>()
  let analyzedJobs = 0
  for (const job of jobs) {
    job.hasSubmittedText = Boolean(job.hasSubmittedText)
    const requirementDocument = requirementDocuments.get(job.id)
    const requirements = requirementDocument ? (JSON.parse(requirementDocument) as Extraction).requirements : []
    job.knockouts = requirements.filter((r) => r.kind === 'knockout').map((r) => ({ quote: r.quote, ...assessRequirement(r, master, profile, synonyms) }))
    if (['new', 'skipped'].includes(job.status)) continue
    if (!gapDocuments.has(job.id)) continue
    analyzedJobs++
    const seen = new Set<string>()
    for (const gap of JSON.parse(gapDocuments.get(job.id) ?? '[]') as Gap[]) {
      const requirement = requirements.find((r) => r.id === gap.requirementId)
      const label = requirement?.skill || gap.quote
      const key = label.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}+#.]+/gu, ' ').trim()
      if (!key || seen.has(key)) continue
      seen.add(key)
      const entry = gaps.get(key) ?? { key, label, count: 0, jobs: [] }
      entry.count++; entry.jobs.push({ id: job.id, company: job.company, title: job.title, reason: gap.reason }); gaps.set(key, entry)
    }
  }
  const preferences = sqlite.prepare('SELECT ghosted_days AS ghostedDays FROM tracker_preferences WHERE id=1').get() as { ghostedDays: number }
  const funnelStages = ['saved', 'applied', 'screening', 'interviewing', 'offer', 'accepted']
  const stagesByJob = new Map<string, number>()
  for (const event of sqlite.prepare('SELECT a.job_id AS jobId,e.status FROM status_events e JOIN applications a ON a.id=e.application_id').all() as Array<{ jobId: string; status: string }>) stagesByJob.set(event.jobId, Math.max(stagesByJob.get(event.jobId) ?? -1, funnelStages.indexOf(event.status)))
  for (const job of jobs) stagesByJob.set(job.id, Math.max(stagesByJob.get(job.id) ?? -1, funnelStages.indexOf(job.status), job.appliedAt ? 1 : -1))
  return {
    jobs, preferences,
    followUps: jobs.filter((j) => j.followUpDate && j.followUpDate <= today && !['new', 'skipped', 'accepted', 'rejected', 'withdrawn', 'ghosted'].includes(j.status)).sort((a, b) => a.followUpDate!.localeCompare(b.followUpDate!)),
    ghostedSuggestions: jobs.filter((j) => quietStatuses.has(j.status) && Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${calendarDate(j.lastActivityAt)}T00:00:00Z`)) / 86400000) >= preferences.ghostedDays),
    funnel: funnelStages.map((status, index) => ({ status, count: [...stagesByJob.values()].filter((stage) => stage >= index).length })),
    gaps: [...gaps.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)), analyzedJobs,
  }
}
export function filterTrackerJobs(jobs: TrackerJob[], filters: { q?: string; status?: string; company?: string; after?: string; before?: string }) {
  return jobs.filter((j) => (!filters.q || `${j.company} ${j.title} ${j.notes} ${j.contacts}`.toLowerCase().includes(filters.q.toLowerCase())) &&
    (!filters.status || (filters.status === 'tracker' ? !['new', 'skipped'].includes(j.status) : j.status === filters.status)) &&
    (!filters.company || j.company === filters.company) && (!filters.after || calendarDate(j.capturedAt) >= filters.after) && (!filters.before || calendarDate(j.capturedAt) <= filters.before))
}
export function ftsQuery(query: string) {
  return [...new Set(query.match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, 15).map((token) => `"${token}"`).join(' OR ')
}
export function libraryAnswers(sqlite: Database.Database, query = '', category = ''): LibraryAnswer[] {
  const terms = ftsQuery(query), clauses: string[] = [], params: string[] = []
  if (query.trim() && !terms) return []
  if (terms) { clauses.push('a.id IN (SELECT answer_id FROM job_answers_fts WHERE job_answers_fts MATCH ?)'); params.push(terms) }
  if (category) { clauses.push('lower(a.category)=lower(?)'); params.push(category) }
  return sqlite.prepare(`SELECT a.id,a.job_id AS jobId,j.company,j.title,COALESCE(app.status,'new') AS status,a.question,a.answer,a.category,a.char_limit AS charLimit,
    a.submitted_answer AS submittedAnswer,a.submitted_at AS submittedAt,a.created_at AS createdAt,COALESCE(a.updated_at,a.created_at) AS updatedAt,app.applied_at AS appliedAt,a.reused_from AS reusedFrom
    FROM job_answers a JOIN jobs j ON j.id=a.job_id LEFT JOIN applications app ON app.job_id=j.id
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY a.created_at DESC,a.rowid DESC`).all(...params) as LibraryAnswer[]
}
export function similarAnswers(sqlite: Database.Database, jobId: string, question: string, category?: string) {
  const inferred = category || suggestAnswerCategory(question)
  const terms = new Set((question.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 2 && !['the', 'you', 'your', 'and', 'for', 'this', 'what', 'why', 'are', 'our', 'with'].includes(t)))
  const fullTextMatches = new Set(libraryAnswers(sqlite, question).map((a) => a.id))
  return libraryAnswers(sqlite).filter((a) => a.jobId !== jobId).map((answer) => {
    const sameCategory = inferred.toLowerCase() !== 'other' && answer.category.toLowerCase() === inferred.toLowerCase()
    const overlap = [...terms].filter((term) => `${answer.question} ${answer.answer}`.toLowerCase().includes(term)).length
    return { ...answer, score: (sameCategory ? 100 : 0) + overlap * 10 + (fullTextMatches.has(answer.id) ? 1 : 0) }
  }).filter((a) => a.score > 0).sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt)).slice(0, 8)
}
export function csv(rows: unknown[][]) {
  return '\uFEFF' + rows.map((row) => row.map((value) => {
    const raw = String(value ?? '')
    const safe = /^[\s\u0000-\u001f]*[=+@-]/.test(raw) || /^[\t\r\n]/.test(raw) ? `'${raw}` : raw
    return `"${safe.replaceAll('"', '""')}"`
  }).join(',')).join('\r\n')
}

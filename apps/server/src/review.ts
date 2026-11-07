import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { reviewSchema, tailoredDocumentSchema, type Master, type Review, type TailoredDocument } from '../../../packages/shared/src/index.js'
import { evidenceRows, antiSlop, verifyLayer1 } from './pipeline-core.js'
import { listSynonyms, readMaster, saveMaster } from './master.js'

export class ReviewError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 | 422 = 422) { super(message) }
}
export function loadReview(sqlite: Database.Database, jobId: string, runId?: string): Review {
  const row = (runId
    ? sqlite.prepare('SELECT document FROM tailored WHERE job_id=? AND run_id=?').get(jobId, runId)
    : sqlite.prepare('SELECT document FROM tailored WHERE job_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(jobId)) as { document: string } | undefined
  if (!row) throw new ReviewError('No tailored draft exists for this job yet.', 404)
  const tailored = tailoredDocumentSchema.parse(JSON.parse(row.document))
  const existing = sqlite.prepare('SELECT document FROM review_drafts WHERE run_id=?').get(tailored.runId) as { document: string } | undefined
  if (existing) return reviewSchema.parse(JSON.parse(existing.document))
  const snapshot = sqlite.prepare('SELECT document FROM master_snapshots WHERE hash=?').get(tailored.snapshotHash) as { document: string } | undefined
  if (!snapshot) throw new ReviewError('The source snapshot for this draft is missing.')
  const master = JSON.parse(snapshot.document) as Master
  const sections = [...master.roles, ...master.projects]
  const review = reviewSchema.parse({ jobId, runId: tailored.runId, revision: 1, snapshotHash: tailored.snapshotHash, master,
    summaryId: tailored.summary?.variantId ?? null, skills: tailored.skillsLine,
    lines: tailored.lines.map((line) => {
      const section = sections.find((s) => s.bullets.some((b) => b.id === line.sourceIds[0]))
      if (!section) throw new ReviewError('A draft line has no resolvable source section.')
      return { ...line, originalText: line.text, rationale: tailored.scores.filter((score) => line.sourceIds.includes(score.bulletId)).map((score) => score.rationale).join(' '), sectionId: section.id, decision: 'pending', verification: 'checked' }
    }),
  })
  sqlite.prepare('INSERT OR IGNORE INTO review_drafts(run_id,job_id,revision,document,updated_at) VALUES(?,?,?,?,?)').run(review.runId, jobId, 1, JSON.stringify(review), new Date().toISOString())
  return review
}
export function saveReview(sqlite: Database.Database, review: Review, expectedRevision: number) {
  review.revision = expectedRevision + 1
  reviewSchema.parse(review)
  const result = sqlite.prepare('UPDATE review_drafts SET revision=?,document=?,updated_at=? WHERE run_id=? AND revision=?').run(review.revision, JSON.stringify(review), new Date().toISOString(), review.runId, expectedRevision)
  if (!result.changes) throw new ReviewError('This draft changed in another window. Reload it before saving.', 409)
  return review
}
export function checkReview(sqlite: Database.Database, review: Review) {
  const synonyms = listSynonyms(sqlite)
  const slop = antiSlop(review.lines, review.master, [])
  review.lines.forEach((line, i) => { line.layer1Flags = verifyLayer1(line.text, line.sourceIds, review.master, synonyms); line.slopFlags = slop[i] })
}
export function alternatives(sqlite: Database.Database, review: Review) {
  const original = JSON.parse((sqlite.prepare('SELECT document FROM tailored WHERE run_id=?').get(review.runId) as { document: string }).document) as TailoredDocument
  const used = new Set(review.lines.filter((line) => line.decision !== 'rejected').flatMap((line) => line.sourceIds))
  return evidenceRows(review.master).filter((row) => !used.has(row.bullet.id)).map((row) => {
    const section = [...review.master.roles, ...review.master.projects].find((s) => s.bullets.some((b) => b.id === row.bullet.id))!
    const score = original.scores.find((s) => s.bulletId === row.bullet.id)
    return { id: row.bullet.id, sectionId: section.id, label: row.context, text: row.bullet.text, rationale: score?.rationale ?? 'Original master evidence; review its relevance.', score: score?.score ?? 0 }
  }).sort((a, b) => b.score - a.score)
}
export function addLineToMaster(sqlite: Database.Database, review: Review, outId: string, sectionId: string) {
  const line = review.lines.find((l) => l.outId === outId)
  if (!line || line.author !== 'user') throw new ReviewError('Edit and confirm your own text before adding it to the master.')
  const current = readMaster(sqlite).document
  const section = [...current.roles, ...current.projects].find((s) => s.id === sectionId)
  if (!section) throw new ReviewError('Choose an existing role or project in the current master.')
  let bullet = section.bullets.find((b) => !b.retired && b.text === line.text)
  if (!bullet) {
    bullet = { id: randomUUID(), rev: 1, text: line.text, skills: [], metrics: [], verbs: [], sourceRef: 'User-confirmed in tailoring workspace' }
    section.bullets.push(bullet)
    saveMaster(sqlite, current)
  }
  // Extend this draft's frozen evidence without replacing other historical source text.
  let target = [...review.master.roles, ...review.master.projects].find((s) => s.id === sectionId)
  if (!target) {
    if ('company' in section) { const copy = { ...section, bullets: [] }; review.master.roles.push(copy); target = copy }
    else { const copy = { ...section, bullets: [] }; review.master.projects.push(copy); target = copy }
  }
  if (!target.bullets.some((b) => b.id === bullet.id)) target.bullets.push(structuredClone(bullet))
  line.sectionId = sectionId; line.sourceIds = [bullet.id]; line.verification = 'pending'; line.verdict = 'stretch'
  review.snapshotHash = createHash('sha256').update(JSON.stringify(review.master)).digest('hex')
  sqlite.prepare('INSERT OR IGNORE INTO master_snapshots(hash,document,created_at) VALUES(?,?,?)').run(review.snapshotHash, JSON.stringify(review.master), new Date().toISOString())
  checkReview(sqlite, review)
}

import type { Hono, Context } from 'hono'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Review, ReviewWorkspace } from '../../../packages/shared/src/index.js'
import { listSynonyms, readMaster, readProfile } from './master.js'
import { verifyLayer1 } from './pipeline-core.js'
import { addLineToMaster, alternatives, checkReview, loadReview, ReviewError, saveReview } from './review.js'
import { exportBlockers, renderDocx, renderPdf, resumeBlocks, sourceSections } from './resume-output.js'
import type { PipelineService } from './pipeline.js'

const id = z.string().uuid()
const editSchema = z.object({ runId: id, revision: z.number().int().positive(), action: z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('decision'), outId: id, decision: z.enum(['pending', 'accepted', 'rejected']) }).strict(),
  z.object({ kind: z.literal('edit'), outId: id, text: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ kind: z.literal('replace'), outId: id, bulletId: id }).strict(),
  z.object({ kind: z.literal('summary'), summaryId: id.nullable() }).strict(),
  z.object({ kind: z.literal('skills'), skills: z.array(z.string().max(100)).max(300) }).strict(),
  z.object({ kind: z.literal('add-to-master'), outId: id, sectionId: id }).strict(),
]) }).strict()
const versionSchema = z.object({ runId: id, revision: z.number().int().positive() }).strict()

export function registerReviewRoutes(app: Hono, sqlite: Database.Database, dataDirectory: string, pipeline: PipelineService) {
  const safe = (fn: (context: Context) => Promise<Response>) => async (context: Context) => {
    try { return await fn(context) }
    catch (error) {
      if (error instanceof z.ZodError) return context.json({ error: 'Invalid review request.' }, 400)
      if (error instanceof ReviewError) return context.json({ error: error.message }, error.status)
      throw error
    }
  }
  async function workspace(review: Review, verificationError?: string): Promise<ReviewWorkspace> {
    const profile = readProfile(sqlite).document, blockers = exportBlockers(review)
    let verificationEstimate = null
    try { verificationEstimate = await pipeline.estimateReview(review) } catch (error) { verificationError ??= (error as Error).message }
    const summary = review.master.summaries.find((s) => s.id === review.summaryId)
    const summaryWarnings = summary ? verifyLayer1(summary.text, [...new Set(review.lines.filter((l) => l.decision === 'accepted').flatMap((l) => l.sourceIds))], review.master, listSynonyms(sqlite)) : []
    return { review, profile, summaryWarnings, blocks: resumeBlocks(review, profile), exportReady: !blockers.length, blockers, replacements: alternatives(sqlite, review), sections: sourceSections(readMaster(sqlite).document), verificationEstimate, verificationError }
  }
  function exact(context: Context, value: z.infer<typeof versionSchema>) {
    const review = loadReview(sqlite, context.req.param('id')!, value.runId)
    if (review.revision !== value.revision) throw new ReviewError('This draft changed. Reload it before continuing.', 409)
    return review
  }
  app.get('/api/jobs/:id/review', safe(async (context) => {
    const runId = context.req.query('runId')
    if (runId) id.parse(runId)
    return context.json(await workspace(loadReview(sqlite, context.req.param('id')!, runId)))
  }))
  app.get('/api/jobs/:id/review/versions', safe(async (context) => context.json({ versions: sqlite.prepare('SELECT run_id AS runId,created_at AS createdAt FROM tailored WHERE job_id=? ORDER BY created_at DESC,rowid DESC').all(context.req.param('id')!) })))
  app.put('/api/jobs/:id/review', safe(async (context) => {
    const value = editSchema.parse(await context.req.json().catch(() => null)), review = exact(context, value), { action } = value
    const line = 'outId' in action ? review.lines.find((l) => l.outId === action.outId) : undefined
    if ('outId' in action && !line) throw new ReviewError('Line not found.', 404)
    if (action.kind === 'decision') line!.decision = action.decision
    if (action.kind === 'edit' && line!.text !== action.text) {
      line!.text = action.text; line!.author = 'user'; line!.verification = 'pending'; line!.verdict = 'stretch'; line!.layer2Reason = 'Edited text awaits semantic verification.'
    }
    if (action.kind === 'replace') {
      const replacement = alternatives(sqlite, review).find((item) => item.id === action.bulletId)
      if (!replacement || replacement.sectionId !== line!.sectionId || line!.decision !== 'rejected') throw new ReviewError('Choose an unused replacement from the same role or project after rejecting this line.')
      line!.rationale = replacement.rationale; line!.text = replacement.text; line!.sourceIds = [replacement.id]; line!.author = 'user'; line!.decision = 'pending'; line!.verification = 'pending'; line!.verdict = 'stretch'; line!.layer2Reason = 'Original master wording; verification queued.'
    }
    if (action.kind === 'summary') {
      if (action.summaryId && !review.master.summaries.some((s) => s.id === action.summaryId)) throw new ReviewError('Choose a summary from this master snapshot.')
      review.summaryId = action.summaryId
    }
    if (action.kind === 'skills') {
      if (new Set(action.skills).size !== action.skills.length || action.skills.some((name) => !review.master.skills.some((s) => s.name === name))) throw new ReviewError('Choose skills already recorded in this master snapshot.')
      review.skills = action.skills
    }
    sqlite.transaction(() => {
      if (action.kind === 'add-to-master') addLineToMaster(sqlite, review, action.outId, action.sectionId)
      checkReview(sqlite, review)
      saveReview(sqlite, review, value.revision)
    })()
    let verificationError: string | undefined
    try { await pipeline.enqueueReview(structuredClone(review)) } catch (error) { verificationError = (error as Error).message }
    return context.json(await workspace(loadReview(sqlite, review.jobId, review.runId), verificationError))
  }))
  app.post('/api/jobs/:id/review/reverify', safe(async (context) => {
    const value = versionSchema.parse(await context.req.json().catch(() => null)), review = exact(context, value)
    for (const line of review.lines) if (line.author === 'user' || line.verification !== 'checked') line.verification = 'pending'
    checkReview(sqlite, review)
    saveReview(sqlite, review, value.revision)
    let verificationError: string | undefined
    try { await pipeline.enqueueReview(structuredClone(review)) } catch (error) { verificationError = (error as Error).message }
    return context.json(await workspace(loadReview(sqlite, review.jobId, review.runId), verificationError))
  }))
  app.post('/api/jobs/:id/review/preview', safe(async (context) => {
    const value = versionSchema.parse(await context.req.json().catch(() => null)), review = exact(context, value)
    const blocks = resumeBlocks(review, readProfile(sqlite).document), pdf = await renderPdf(blocks)
    exact(context, value)
    context.header('Cache-Control', 'no-store')
    return context.json({ revision: review.revision, pages: pdf.pages, lastPagePercent: pdf.lastPagePercent, parseCheck: pdf.parseCheck, pdfBase64: pdf.buffer.toString('base64') })
  }))
  app.post('/api/jobs/:id/review/export', safe(async (context) => {
    const value = versionSchema.extend({ format: z.enum(['docx', 'pdf']) }).parse(await context.req.json().catch(() => null)), review = exact(context, value)
    const blockers = exportBlockers(review)
    if (blockers.length) throw new ReviewError(blockers.join('\n'))
    const profile = readProfile(sqlite).document, blocks = resumeBlocks(review, profile)
    const output = value.format === 'pdf' ? await renderPdf(blocks) : await renderDocx(blocks)
    if (!output.parseCheck.ok) throw new ReviewError(`Export text check failed. Missing or out-of-order text: ${output.parseCheck.missing.join('; ')}`)
    // Recheck after rendering so a concurrent edit cannot be mistaken for this exported version.
    exact(context, value)
    const job = sqlite.prepare('SELECT company,title FROM jobs WHERE id=?').get(review.jobId) as { company: string; title: string }
    const filename = [profile.name || 'Resume', job.company, job.title].join('-').normalize('NFKC').replace(/[^\p{L}\p{N}_.-]+/gu, '-').slice(0, 160).replace(/^-+|-+$/g, '') + `.${value.format}`
    const artifactId = randomUUID(), directory = join(dataDirectory, 'artifacts'), filePath = join(directory, `${artifactId}.${value.format}`)
    await mkdir(directory, { recursive: true, mode: 0o700 }); await writeFile(filePath, output.buffer, { mode: 0o600, flag: 'wx' })
    const mediaType = value.format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    sqlite.prepare('INSERT INTO artifacts(id,job_id,run_id,file_path,media_type,parse_check,created_at,document) VALUES(?,?,?,?,?,?,?,?)').run(artifactId, review.jobId, review.runId, filePath, mediaType, JSON.stringify(output.parseCheck), new Date().toISOString(), JSON.stringify({ review, blocks, filename }))
    return context.json({ id: artifactId, filename, parseCheck: output.parseCheck, downloadUrl: `/api/jobs/${review.jobId}/artifacts/${artifactId}` }, 201)
  }))
  app.get('/api/jobs/:id/artifacts', safe(async (context) => context.json({ artifacts: sqlite.prepare('SELECT id,media_type AS mediaType,created_at AS createdAt,parse_check AS parseCheck,json_extract(document,\'$.filename\') AS filename,json_extract(document,\'$.review.revision\') AS revision FROM artifacts WHERE job_id=? AND document IS NOT NULL ORDER BY created_at DESC').all(context.req.param('id')!) })))
  app.get('/api/jobs/:id/artifacts/:artifactId', safe(async (context) => {
    const row = sqlite.prepare('SELECT file_path,media_type,document FROM artifacts WHERE id=? AND job_id=?').get(context.req.param('artifactId'), context.req.param('id')!) as { file_path: string; media_type: string; document: string } | undefined
    if (!row) throw new ReviewError('Export not found.', 404)
    const filename = JSON.parse(row.document).filename as string
    context.header('Content-Type', row.media_type)
    context.header('Content-Disposition', `attachment; filename="resume.${row.media_type === 'application/pdf' ? 'pdf' : 'docx'}"; filename*=UTF-8''${encodeURIComponent(filename)}`)
    context.header('Cache-Control', 'no-store')
    return context.body(new Uint8Array(await readFile(row.file_path)))
  }))
}

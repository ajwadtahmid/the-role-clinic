import { outputBudget, outputBudgetForChars, TruncatedModelOutput } from './model-wire.js'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import { tailoredDocumentSchema, tailoredLineSchema, type AppSettings, type BulletScore, type Extraction, type Gap, type Master, type TailoredDocument, type TailoredLine, type TaskName, type Review } from '../../../packages/shared/src/index.js'
import { readMaster, readProfile, listSynonyms, snapshotMaster } from './master.js'
import { readSettings } from './settings.js'
import { taskOutputLimits, type ModelRouter, type ModelRequest, type ModelResponse } from './model-adapters.js'
import { scoreResponseSchema, verdictResponseSchema, slopResponseSchema, modelFormats, requireIds, parseDraft } from './model-schemas.js'
import { type RunContext, type RunRecord, SerialRunQueue } from './queue.js'
import { prompts } from './prompts.js'
import { bestMatches, computeFit } from './fit.js'
import { antiSlop, assessRequirement, chooseSummary, evidenceRows, findGaps, normalizeExtraction, parseModelJson, scoreEvidence, selectSkillsLine, verifyLayer1 } from './pipeline-core.js'

const promptVersions = { requirementExtraction: prompts.requirementExtraction.version, bulletScoring: prompts.bulletScoring.version, resumeDrafting: prompts.resumeDrafting.version, claimVerification: prompts.claimVerification.version, antiSlop: prompts.antiSlop.version }
const MAX_JD_CHARS = 18_000
const jobRow = (sqlite: Database.Database, id: string) => sqlite.prepare('SELECT id,company,title,text,location FROM jobs WHERE id=?').get(id) as { id: string; company: string; title: string; text: string; location: string } | undefined
const selectLatest = (sqlite: Database.Database, table: 'requirements' | 'tailored', jobId: string) => sqlite.prepare(`SELECT document FROM ${table} WHERE job_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(jobId) as { document: string } | undefined
const extractionFormat = modelFormats.extraction, draftFormat = modelFormats.draft, scoreFormat = modelFormats.score, verdictFormat = modelFormats.verdict, slopFormat = modelFormats.slop

interface CostLine { task: TaskName; provider: string; model: string; estimatedInputTokens: number; maxOutputTokens: number; estimatedUsd: number }
function estimateTask(settings: AppSettings, task: TaskName, inputChars: number, maxOutputTokens: number): CostLine {
  const choice = settings.taskModels[task]
  const estimatedInputTokens = Math.ceil(inputChars / 3) + 400
  if (choice.provider === 'ollama') return { task, provider: choice.provider, model: choice.model, estimatedInputTokens, maxOutputTokens, estimatedUsd: 0 }
  const price = settings.modelPrices[choice.model]
  if (!price) throw new Error(`Set input and output prices for ${choice.model} in Settings before using the Anthropic API.`)
  const estimatedUsd = Math.ceil(((estimatedInputTokens * price.inputPerMillion + maxOutputTokens * price.outputPerMillion) / 1_000_000) * 10_000) / 10_000
  return { task, provider: choice.provider, model: choice.model, estimatedInputTokens, maxOutputTokens, estimatedUsd }
}
function actualCost(settings: AppSettings, task: TaskName, response: ModelResponse) {
  if (response.provider !== 'anthropic' || !response.usage) return 0
  const price = settings.modelPrices[response.model] ?? settings.modelPrices[settings.taskModels[task].model]
  if (!price) throw new Error(`Price for ${response.model} is missing; cost cannot be tracked.`)
  return (response.usage.inputTokens * price.inputPerMillion + response.usage.outputTokens * price.outputPerMillion) / 1_000_000
}
function checkpoint<T>(sqlite: Database.Database, runId: string, step: string): T | null {
  const row = sqlite.prepare('SELECT document FROM run_checkpoints WHERE run_id=? AND step=?').get(runId, step) as { document: string } | undefined
  return row ? JSON.parse(row.document) as T : null
}
function saveCheckpoint(sqlite: Database.Database, runId: string, step: string, value: unknown) {
  sqlite.prepare('INSERT INTO run_checkpoints(run_id,step,document,created_at) VALUES(?,?,?,?) ON CONFLICT(run_id,step) DO UPDATE SET document=excluded.document,created_at=excluded.created_at').run(runId, step, JSON.stringify(value), new Date().toISOString())
}
function getUsage(sqlite: Database.Database, runId: string): { totalUsd: number; calls: Array<{ task: TaskName; model: string; provider: string; inputTokens: number; outputTokens: number; usd: number }> } {
  const row = sqlite.prepare('SELECT usage FROM runs WHERE id=?').get(runId) as { usage: string | null }
  return row.usage ? JSON.parse(row.usage) : { totalUsd: 0, calls: [] }
}

// API spend recorded by every run created since the first of this month (local time). Local models record 0.
function spentThisMonth(sqlite: Database.Database): number {
  const now = new Date(), start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
  return (sqlite.prepare("SELECT COALESCE(SUM(COALESCE(json_extract(usage,'$.totalUsd'),0)),0) AS spent FROM runs WHERE created_at >= ?").get(start) as { spent: number }).spent
}
// Only paid work is limited: a local model (estimate 0) is never blocked by a cap.
const withinCaps = (settings: AppSettings, estimatedUsd: number, spentUsd: number) => estimatedUsd <= settings.costCapUsd && (estimatedUsd === 0 || spentUsd + estimatedUsd <= settings.monthlyCapUsd)
function capError(what: string, settings: AppSettings, estimatedUsd: number, spentUsd: number) {
  return estimatedUsd > settings.costCapUsd
    ? new Error(`Estimated ${what} cost $${estimatedUsd} exceeds the $${settings.costCapUsd} run cap.`)
    : new Error(`Estimated ${what} cost $${estimatedUsd} would take this month's API spend ($${spentUsd.toFixed(4)} so far) past the $${settings.monthlyCapUsd} monthly cap. Raise the cap in Settings or choose a local model.`)
}

export class PipelineService {
  private reviewRequests = new Set<string>()
  constructor(private sqlite: Database.Database, private dataDirectory: string, private queue: SerialRunQueue, private router: Pick<ModelRouter, 'complete'> & Partial<Pick<ModelRouter, 'countInputTokens'>>) {
    sqlite.prepare("UPDATE runs SET status='failed',error='Server restarted before this run completed.',finished_at=? WHERE status IN ('queued','running') AND kind IN ('extract','tailor','reverify')").run(new Date().toISOString())
    for (const row of sqlite.prepare('SELECT run_id,document FROM review_drafts').all() as Array<{ run_id: string; document: string }>) {
      const review = JSON.parse(row.document) as Review
      const pending = review.lines.filter((line) => line.verification === 'pending')
      if (!pending.length) continue
      for (const line of pending) { line.verification = 'failed'; line.layer2Reason = 'Verification was interrupted by a server restart. Reverify edited lines to retry.' }
      sqlite.prepare('UPDATE review_drafts SET document=? WHERE run_id=?').run(JSON.stringify(review), row.run_id)
    }
  }

  getAnalysis(jobId: string) {
    const job = jobRow(this.sqlite, jobId)
    if (!job) return null
    const extractionRow = selectLatest(this.sqlite, 'requirements', jobId)
    const extraction = extractionRow ? JSON.parse(extractionRow.document) as Extraction : null
    const master = readMaster(this.sqlite).document, profile = readProfile(this.sqlite).document, synonyms = listSynonyms(this.sqlite)
    if (extraction) for (const requirement of extraction.requirements) Object.assign(requirement, assessRequirement(requirement, master, profile, synonyms))
    const scores = extraction ? scoreEvidence(master, extraction, synonyms) : []
    const preliminaryGaps = extraction ? findGaps(extraction, scores, master) : []
    const tailoredRow = selectLatest(this.sqlite, 'tailored', jobId)
    const tailored = tailoredRow ? tailoredDocumentSchema.parse(JSON.parse(tailoredRow.document)) : null
    const runs = this.sqlite.prepare('SELECT id,kind,status,step,error,usage,cost_estimate AS costEstimate,created_at AS createdAt,finished_at AS finishedAt FROM runs WHERE job_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20').all(jobId)
    const fit = extraction ? computeFit(extraction, preliminaryGaps) : null, matches = extraction ? bestMatches(extraction, preliminaryGaps, scores, master) : []
    return { extraction, preliminaryGaps, fit, matches, tailored, runs }
  }

  async estimate(jobId: string, kind: 'extract' | 'tailor') {
    const job = jobRow(this.sqlite, jobId)
    if (!job) throw new Error('Job not found.')
    const settings = await readSettings(this.dataDirectory)
    let lines: CostLine[]
    // Same output budgets the calls themselves use, so the estimate does not understate a paid run.
    const budget = (task: TaskName, inputChars: number) => outputBudgetForChars(task, inputChars, taskOutputLimits[task], settings.taskModels[task].model)
    if (kind === 'extract') { const chars = Math.min(job.text.length, MAX_JD_CHARS) + 2000; lines = [estimateTask(settings, 'requirementExtraction', chars, budget('requirementExtraction', chars))] }
    else {
      const extraction = this.getAnalysis(jobId)?.extraction
      if (!extraction) throw new Error('Extract requirements before tailoring.')
      const master = readMaster(this.sqlite).document
      if (!evidenceRows(master).length) throw new Error('Add at least one active master résumé bullet before tailoring.')
      const sourceChars = evidenceRows(master).map((row) => row.bullet.text.length + row.context.length).reduce((a,b) => a+b, 0)
      const scoringChars = Math.min(sourceChars, 20_000) + 24_000, draftChars = Math.min(sourceChars, 25_000) + 6000, verifyChars = Math.min(sourceChars, 25_000) + 8000
      lines = [
        // Scoring runs in four batches, each with its own budget.
        estimateTask(settings, 'bulletScoring', scoringChars, budget('bulletScoring', scoringChars / 4) * 4),
        estimateTask(settings, 'resumeDrafting', draftChars, budget('resumeDrafting', draftChars)),
        estimateTask(settings, 'claimVerification', verifyChars, budget('claimVerification', verifyChars)),
        estimateTask(settings, 'antiSlop', 8000, budget('antiSlop', 8000)),
      ]
    }
    const estimatedUsd = Math.ceil(lines.reduce((sum, line) => sum + line.estimatedUsd, 0) * 10_000) / 10_000
    const spentThisMonthUsd = spentThisMonth(this.sqlite)
    return { kind, lines, estimatedUsd, capUsd: settings.costCapUsd, monthlyCapUsd: settings.monthlyCapUsd, spentThisMonthUsd, allowed: withinCaps(settings, estimatedUsd, spentThisMonthUsd), note: 'Estimated from text length and output limits; actual token use can differ.' }
  }

  // A new job is checked on its own only when the user turned that on and the check runs on this computer; a paid check is always asked for.
  async maybeAutoExtract(jobId: string) {
    if (!existsSync(join(this.dataDirectory, 'settings.json'))) return null
    const settings = await readSettings(this.dataDirectory)
    if (!settings.autoFitCheck || settings.taskModels.requirementExtraction.provider !== 'ollama') return null
    const existing = this.sqlite.prepare("SELECT 1 FROM runs WHERE job_id=? AND kind='extract' AND status IN ('queued','running','done') LIMIT 1").get(jobId)
    if (existing) return null
    try { return await this.enqueueExtract(jobId) } catch { return null }
  }
  async enqueueExtract(jobId: string, quiet = false) {
    const estimate = await this.estimate(jobId, 'extract')
    if (!estimate.allowed) throw capError('extraction', await readSettings(this.dataDirectory), estimate.estimatedUsd, estimate.spentThisMonthUsd)
    const run = this.queue.enqueueWork('extract', jobId, (record, context) => this.extract(record, context), quiet)
    this.sqlite.prepare('UPDATE runs SET cost_estimate=?,prompt_versions=? WHERE id=?').run(estimate.estimatedUsd, JSON.stringify({ requirementExtraction: promptVersions.requirementExtraction }), run.id)
    return run
  }
  async enqueueTailor(jobId: string) {
    const estimate = await this.estimate(jobId, 'tailor')
    if (!estimate.allowed) throw capError('tailoring', await readSettings(this.dataDirectory), estimate.estimatedUsd, estimate.spentThisMonthUsd)
    const run = this.queue.enqueueWork('tailor', jobId, (record, context) => this.tailor(record, context))
    this.sqlite.prepare('UPDATE runs SET cost_estimate=?,prompt_versions=? WHERE id=?').run(estimate.estimatedUsd, JSON.stringify(promptVersions), run.id)
    return run
  }
  retry(id: string) {
    const row = this.sqlite.prepare('SELECT id,kind,job_id AS jobId,status,step,created_at AS createdAt FROM runs WHERE id=?').get(id) as RunRecord | undefined
    if (!row || !row.jobId || !['extract','tailor'].includes(row.kind)) throw new Error('Run not found or not retryable.')
    if (this.sqlite.prepare("SELECT 1 FROM runs WHERE job_id=? AND kind=? AND status IN ('queued','running') AND id<>? LIMIT 1").get(row.jobId, row.kind, row.id)) throw new Error(`A ${row.kind} run is already queued or running for this job.`)
    return this.queue.retryWork(row, row.kind === 'extract' ? (record, context) => this.extract(record, context) : (record, context) => this.tailor(record, context))
  }

  private mergeReviewVerification(checked: Review) {
    const row = this.sqlite.prepare('SELECT document FROM review_drafts WHERE run_id=?').get(checked.runId) as { document: string } | undefined
    if (!row) return
    const current = JSON.parse(row.document) as Review
    if (current.snapshotHash !== checked.snapshotHash) return
    for (const result of checked.lines) {
      const line = current.lines.find((item) => item.outId === result.outId)
      if (!line || line.verification !== 'pending' || line.text !== result.text || JSON.stringify(line.sourceIds) !== JSON.stringify(result.sourceIds)) continue
      Object.assign(line, { verdict: result.verdict, verification: result.verification, layer2Reason: result.layer2Reason })
    }
    this.sqlite.prepare('UPDATE review_drafts SET document=? WHERE run_id=? AND revision=?').run(JSON.stringify(current), current.runId, current.revision)
  }

  async estimateReview(review: Review) {
    const settings = await readSettings(this.dataDirectory)
    const chars = this.reviewRequest({ ...review, lines: review.lines.map((line) => ({ ...line, verification: 'pending' as const })) }).user.length
    const lines = [estimateTask(settings, 'claimVerification', chars + 2000, outputBudgetForChars('claimVerification', chars, taskOutputLimits.claimVerification, settings.taskModels.claimVerification.model))]
    const estimatedUsd = lines.reduce((sum, line) => sum + line.estimatedUsd, 0)
    return { estimatedUsd, capUsd: settings.costCapUsd, allowed: withinCaps(settings, estimatedUsd, spentThisMonth(this.sqlite)) }
  }

  private reviewRequest(review: Review): ModelRequest {
    const rows = evidenceRows(review.master)
    return { tier: 'strong', system: prompts.reviewVerification.system,
      user: JSON.stringify({ lines: review.lines.filter((line) => line.verification === 'pending').map((line) => ({ outId: line.outId, text: line.text, sources: rows.filter((row) => line.sourceIds.includes(row.bullet.id)).map((row) => ({ id: row.bullet.id, text: row.bullet.text, context: row.context })) })) }), schema: verdictFormat }
  }

  async enqueueReview(review: Review) {
    if (!review.lines.some((line) => line.verification === 'pending')) return null
    const estimate = await this.estimateReview(review)
    if (!estimate.allowed) throw new Error('Estimated verification cost exceeds the run or monthly spending cap. Your edits were saved.')
    const key = JSON.stringify([review.runId, review.snapshotHash, this.reviewRequest(review).user])
    if (this.reviewRequests.has(key)) return null
    this.reviewRequests.add(key)
    const run = this.queue.enqueueWork('reverify', review.jobId, async (record, context) => {
      try {
        const row = this.sqlite.prepare('SELECT document FROM review_drafts WHERE run_id=?').get(review.runId) as { document: string } | undefined
        const current = row ? JSON.parse(row.document) as Review : null
        if (!current || current.snapshotHash !== review.snapshotHash) return
        const matching = new Set(current.lines.filter((line) => line.verification === 'pending' && review.lines.some((prior) => prior.outId === line.outId && prior.text === line.text && JSON.stringify(prior.sourceIds) === JSON.stringify(line.sourceIds))).map((line) => line.outId))
        review.lines = review.lines.filter((line) => matching.has(line.outId))
        if (!review.lines.some((line) => line.verification === 'pending')) return
        context.progress('claimVerification', 'Checking edited lines against their frozen evidence.')
        const verdicts = await this.callParsed(record, 'claimVerification', this.reviewRequest(review), taskOutputLimits.claimVerification, (text) => { const value = verdictResponseSchema.parse(parseModelJson(text)); requireIds(value.verdicts.map((item) => item.outId), new Set(review.lines.filter((line) => line.verification === 'pending').map((line) => line.outId)), 'Verification lines', true); return new Map(value.verdicts.map((item) => [item.outId, item])) })
        for (const line of review.lines.filter((line) => line.verification === 'pending')) {
          const result = verdicts.get(line.outId)
          line.verdict = line.layer1Flags.length ? 'unsupported' : result?.verdict ?? 'stretch'
          line.layer2Reason = result?.reason ?? 'No semantic verdict returned. Review required.'
          line.verification = result ? 'checked' : 'failed'
        }
        this.mergeReviewVerification(review)
      } catch (error) {
        for (const line of review.lines.filter((line) => line.verification === 'pending')) { line.verification = 'failed'; line.layer2Reason = 'Semantic verification failed. Retry or review manually.' }
        this.mergeReviewVerification(review)
        throw error
      } finally { this.reviewRequests.delete(key) }
    })
    this.sqlite.prepare('UPDATE runs SET cost_estimate=?,prompt_versions=? WHERE id=?').run(estimate.estimatedUsd, JSON.stringify({ claimVerification: prompts.reviewVerification.version }), run.id)
    return run
  }

  private async call(run: RunRecord, task: TaskName, request: ModelRequest, outputLimit: number): Promise<ModelResponse> {
    const settings = await readSettings(this.dataDirectory)
    const estimate = estimateTask(settings, task, request.system.length + request.user.length, outputLimit)
    const usage = getUsage(this.sqlite, run.id)
    if (usage.totalUsd + estimate.estimatedUsd > settings.costCapUsd) throw new Error(`The next model step may exceed the $${settings.costCapUsd} run cap.`)
    // This run's spend so far is already part of the month total, so only the next step is added.
    const monthSpent = spentThisMonth(this.sqlite)
    if (estimate.estimatedUsd > 0 && monthSpent + estimate.estimatedUsd > settings.monthlyCapUsd) throw new Error(`The next model step may exceed the $${settings.monthlyCapUsd} monthly cap ($${monthSpent.toFixed(4)} spent this month).`)
    if (settings.taskModels[task].provider === 'anthropic') {
      if (!this.router.countInputTokens) throw new Error('Input token counting is required before a paid model call.')
      const counted = await this.router.countInputTokens(task, { ...request, maxOutputTokens: outputLimit })
      if (counted == null) throw new Error('Could not count input tokens before the paid model call.')
      const price = settings.modelPrices[settings.taskModels[task].model]
      const guardedCost = ((Math.ceil(counted * 1.05) + 32) * price.inputPerMillion + outputLimit * price.outputPerMillion) / 1_000_000
      if (usage.totalUsd + guardedCost > settings.costCapUsd) throw new Error(`Token-counted cost could exceed the $${settings.costCapUsd} run cap. Increase the cap or choose a local model.`)
      if (monthSpent + guardedCost > settings.monthlyCapUsd) throw new Error(`Token-counted cost could take this month's API spend past the $${settings.monthlyCapUsd} monthly cap. Increase the cap or choose a local model.`)
    }
    const response = await this.router.complete(task, { ...request, maxOutputTokens: outputLimit, allowTruncatedResponse: true })
    const usd = actualCost(settings, task, response)
    usage.calls.push({ task, model: response.model, provider: response.provider, inputTokens: response.usage?.inputTokens ?? 0, outputTokens: response.usage?.outputTokens ?? 0, usd })
    usage.totalUsd += usd
    this.sqlite.prepare('UPDATE runs SET usage=? WHERE id=?').run(JSON.stringify(usage), run.id)
    if (usage.totalUsd > settings.costCapUsd) throw new Error(`The $${settings.costCapUsd} run cap was reached after ${task}; remaining steps were stopped.`)
    if (usd > 0 && spentThisMonth(this.sqlite) > settings.monthlyCapUsd) throw new Error(`The $${settings.monthlyCapUsd} monthly cap was reached after ${task}; remaining steps were stopped.`)
    if (response.finishReason === 'max_tokens' || response.finishReason === 'length') throw new TruncatedModelOutput(outputLimit)
    return response
  }

  // Model output is untrusted. If it cannot be parsed or validated, give the model one chance to repair it,
  // showing it what was wrong. Both attempts are billed and counted against the cost caps by `call`.
  private async callParsed<T>(run: RunRecord, task: TaskName, request: ModelRequest, outputLimit: number, parse: (text: string) => T): Promise<T> {
    const settings = await readSettings(this.dataDirectory)
    let budget = outputBudget(task, request, outputLimit, settings.taskModels[task].model)
    let next = request
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: ModelResponse
      try { response = await this.call(run, task, next, budget) }
      catch (error) {
        if (!(error instanceof TruncatedModelOutput)) throw error
        if (attempt === 1) throw new Error('Model output is still too long after a retry; shorten the input.')
        budget = Math.min(8192, budget * 2)
        next = { ...request, user: request.user + '\n\nThe previous output was truncated. Return the complete JSON again from the original evidence, concisely. Do not continue or splice partial JSON.' }
        continue
      }
      try { return parse(response.text) }
      catch (error) {
        if (attempt === 1) throw error
        const reason = error instanceof z.ZodError ? error.issues.slice(0, 5).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') : String(error)
        next = { ...request, user: request.user + `\n\nYour previous reply could not be used (${reason.slice(0, 600)}). Reply again with only the corrected JSON.` }
      }
    }
    throw new Error('No valid model response.')
  }

  private async extract(run: RunRecord, context: RunContext) {
    const job = jobRow(this.sqlite, run.jobId!)!
    let extraction = checkpoint<Extraction>(this.sqlite, run.id, 'extraction')
    if (!extraction) {
      context.progress('requirementExtraction', 'Extracting cited requirements from the job description.')
      const excerpt = job.text.slice(0, MAX_JD_CHARS)
      const master = readMaster(this.sqlite).document, profile = readProfile(this.sqlite).document, synonyms = listSynonyms(this.sqlite)
      extraction = await this.callParsed(run, 'requirementExtraction', { tier: 'fast', system: prompts.requirementExtraction.system, user: JSON.stringify({ company: job.company, title: job.title, jobText: excerpt }), schema: extractionFormat }, taskOutputLimits.requirementExtraction, (text) => normalizeExtraction(text, excerpt, master, profile, synonyms))
      extraction.partial ||= job.text.length > MAX_JD_CHARS
      saveCheckpoint(this.sqlite, run.id, 'extraction', extraction)
    }
    context.progress('saving', 'Saving extracted requirements and their source locations.')
    const document = JSON.stringify(extraction)
    this.sqlite.prepare('INSERT OR IGNORE INTO requirements(id,job_id,document,created_at) VALUES(?,?,?,?)').run(run.id, job.id, document, new Date().toISOString())
  }

  private async tailor(run: RunRecord, context: RunContext) {
    const job = jobRow(this.sqlite, run.jobId!)!
    let extraction = checkpoint<Extraction>(this.sqlite, run.id, 'jobRequirements')
    if (!extraction) {
      extraction = this.getAnalysis(job.id)?.extraction ?? null
      if (extraction) saveCheckpoint(this.sqlite, run.id, 'jobRequirements', extraction)
    }
    if (!extraction) throw new Error('Extract requirements before tailoring.')
    let snap = checkpoint<{ hash: string; master: Master; synonyms: ReturnType<typeof listSynonyms> }>(this.sqlite, run.id, 'snapshot')
    if (!snap) {
      context.progress('snapshot', 'Saving the master version used for this run.')
      const hash = snapshotMaster(this.sqlite), master = readMaster(this.sqlite).document
      snap = { hash, master, synonyms: listSynonyms(this.sqlite) }; saveCheckpoint(this.sqlite, run.id, 'snapshot', snap)
    }
    const master = snap.master, synonyms = snap.synonyms ?? listSynonyms(this.sqlite)
    const rows = evidenceRows(master)
    if (!rows.length) throw new Error('No active evidence bullets in the master résumé.')
    let scoring = checkpoint<{ scores: BulletScore[]; gaps: Gap[] }>(this.sqlite, run.id, 'scoring')
    if (!scoring) {
      context.progress('bulletScoring', 'Ranking cited master bullets and identifying gaps.')
      const deterministic = scoreEvidence(master, extraction, synonyms)
      const shortlist = deterministic.slice(0, 16)
      const parsedBatches: Array<z.infer<typeof scoreResponseSchema>> = []
      for (let offset = 0; offset < shortlist.length; offset += 4) {
        const batchIds = new Set(shortlist.slice(offset, offset + 4).map((score) => score.bulletId))
        const parsed = await this.callParsed(run, 'bulletScoring', { tier: 'fast', system: prompts.bulletScoring.system, user: JSON.stringify({ requirements: extraction.requirements.slice(0, 40).map((r) => ({ id: r.id, quote: r.quote.slice(0, 400), kind: r.kind })), bullets: rows.filter((row) => batchIds.has(row.bullet.id)).map((row) => ({ id: row.bullet.id, text: row.bullet.text.slice(0, 700), context: row.context.slice(0, 200) })) }), schema: scoreFormat }, taskOutputLimits.bulletScoring, (text) => {
          const value = scoreResponseSchema.parse(parseModelJson(text))
          requireIds(value.scores.map((score) => score.bulletId), batchIds, 'Scoring bullets', true)
          for (const score of value.scores) requireIds(score.requirementIds, new Set(extraction.requirements.map((requirement) => requirement.id)), 'Scoring requirements')
          return value
        })
        parsedBatches.push(parsed)
      }
      const parsed = { scores: parsedBatches.flatMap((batch) => batch.scores) }
      const allowedIds = new Set(shortlist.map((s) => s.bulletId)), requirementIds = new Set(extraction.requirements.map((r) => r.id))
      const modelScores = new Map(parsed.scores.filter((s) => allowedIds.has(s.bulletId) && s.requirementIds.every((id) => requirementIds.has(id))).map((s) => [s.bulletId, s]))
      const scores = deterministic.map((score) => {
        const model = modelScores.get(score.bulletId)
        return model ? { ...score, score: Math.round((score.score + model.score) / 2), rationale: model.rationale } : score
      }).sort((a,b) => b.score - a.score)
      scoring = { scores, gaps: findGaps(extraction, deterministic, master) }
      saveCheckpoint(this.sqlite, run.id, 'scoring', scoring)
    }
    let draft = checkpoint<Array<{ text: string; sourceIds: string[] }>>(this.sqlite, run.id, 'draft')
    if (!draft) {
      context.progress('resumeDrafting', 'Drafting from selected, cited evidence.')
      const selected = scoring.scores.filter((s) => s.score > 0).slice(0, 10)
      const selectedIds = new Set((selected.length ? selected : scoring.scores.slice(0, 8)).map((s) => s.bulletId))
      draft = await this.callParsed(run, 'resumeDrafting', { tier: 'strong', system: prompts.resumeDrafting.system, user: JSON.stringify({ job: { company: job.company, title: job.title }, requirements: extraction.requirements.slice(0, 40).map((r) => ({ id: r.id, quote: r.quote.slice(0, 400) })), bullets: rows.filter((row) => selectedIds.has(row.bullet.id)).map((row) => ({ id: row.bullet.id, text: row.bullet.text.slice(0, 2000), context: row.context.slice(0, 200), kind: row.kind })) }), schema: draftFormat }, taskOutputLimits.resumeDrafting, (text) => {
        return parseDraft(parseModelJson(text), selectedIds)
      })
      saveCheckpoint(this.sqlite, run.id, 'draft', draft)
    }
    let claims = checkpoint<{ lines: TailoredLine[]; summaryVerdict: 'grounded' | 'stretch' | 'unsupported' }>(this.sqlite, run.id, 'claims')
    const selectedSummary = chooseSummary(master, `${job.title} ${extraction.requirements.map((r) => r.quote).join(' ')}`)
    if (!claims) {
      context.progress('claimVerification', 'Checking changed facts and implied scope against cited sources.')
      const lines: TailoredLine[] = draft.map((line) => tailoredLineSchema.parse({ outId: randomUUID(), text: line.text, sourceIds: line.sourceIds, author: 'model', verdict: 'stretch', layer1Flags: verifyLayer1(line.text, line.sourceIds, master, synonyms), layer2Reason: '', slopFlags: [] }))
      const sourceMap = new Map(rows.map((row) => [row.bullet.id, row]))
      const summarySources = [...new Set(lines.flatMap((line) => line.sourceIds))]
      const verificationItems = [...lines.map((line) => ({ outId: line.outId, text: line.text, sourceIds: line.sourceIds })), ...(selectedSummary ? [{ outId: selectedSummary.id, text: selectedSummary.text, sourceIds: summarySources }] : [])]
      const verdicts = await this.callParsed(run, 'claimVerification', { tier: 'strong', system: prompts.claimVerification.system, user: JSON.stringify({ lines: verificationItems.map((line) => ({ outId: line.outId, text: line.text, sources: line.sourceIds.map((id) => ({ id, text: sourceMap.get(id)?.bullet.text.slice(0, 2000), context: sourceMap.get(id)?.context.slice(0, 200) })) })) }), schema: verdictFormat }, taskOutputLimits.claimVerification, (text) => { const value = verdictResponseSchema.parse(parseModelJson(text)); requireIds(value.verdicts.map((item) => item.outId), new Set(verificationItems.map((line) => line.outId)), 'Verification lines', true); return new Map(value.verdicts.map((item) => [item.outId, item])) })
      for (const line of lines) {
        const semantic = verdicts.get(line.outId)
        line.verdict = line.layer1Flags.length ? 'unsupported' : semantic?.verdict ?? 'stretch'
        line.layer2Reason = semantic?.reason ?? 'No semantic verdict returned; review required.'
      }
      const summaryFlags = selectedSummary ? verifyLayer1(selectedSummary.text, summarySources, master, synonyms) : []
      const summaryVerdict = summaryFlags.length ? 'unsupported' : selectedSummary ? verdicts.get(selectedSummary.id)?.verdict ?? 'stretch' : 'grounded'
      claims = { lines, summaryVerdict }
      saveCheckpoint(this.sqlite, run.id, 'claims', claims)
    }
    let verified = checkpoint<TailoredDocument>(this.sqlite, run.id, 'verified')
    if (!verified) {
      context.progress('antiSlop', 'Flagging generic or repetitive wording.')
      const lines = claims.lines
      const deterministic = antiSlop(lines, master, extraction.vocabulary)
      const modelFlags = await this.callParsed(run, 'antiSlop', { tier: 'fast', system: prompts.antiSlop.system, user: JSON.stringify({ lines: lines.map((line) => ({ outId: line.outId, text: line.text })) }), schema: slopFormat }, taskOutputLimits.antiSlop, (text) => new Map(slopResponseSchema.parse(parseModelJson(text)).flags.map((f) => [f.outId, f.flags])))
      lines.forEach((line, i) => { line.slopFlags = [...new Set([...deterministic[i], ...(modelFlags.get(line.outId) ?? [])])] })
      const summarySources = lines.flatMap((line) => line.sourceIds)
      const summaryFlags = selectedSummary ? verifyLayer1(selectedSummary.text, summarySources, master, synonyms) : []
      const summary = selectedSummary ? { variantId: selectedSummary.id, text: selectedSummary.text, sourceIds: [...new Set(summarySources)], verdict: claims.summaryVerdict, flags: summaryFlags } : null
      const skillsLine = selectSkillsLine(master, extraction, job.title, synonyms)
      verified = tailoredDocumentSchema.parse({ jobId: job.id, runId: run.id, snapshotHash: snap.hash, summary, skillsLine, lines, scores: scoring.scores, gaps: scoring.gaps, exportReady: lines.every((line) => line.verdict !== 'unsupported') && summary?.verdict !== 'unsupported' })
      saveCheckpoint(this.sqlite, run.id, 'verified', verified)
    }
    context.progress('saving', 'Saving the tailored draft with its cited master snapshot.')
    this.sqlite.prepare('INSERT OR IGNORE INTO tailored(id,job_id,run_id,snapshot_hash,document,created_at) VALUES(?,?,?,?,?,?)').run(run.id, job.id, run.id, verified.snapshotHash, JSON.stringify(verified), new Date().toISOString())
  }
}

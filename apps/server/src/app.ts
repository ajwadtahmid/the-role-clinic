import { Hono, type Context, type Next } from 'hono'
import { streamSSE } from 'hono/streaming'
import { bodyLimit } from 'hono/body-limit'
import { serveStatic } from '@hono/node-server/serve-static'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type Database from 'better-sqlite3'
import type { ClinicDatabase } from './db.js'
import { appSettingsSchema, taskNames, suggestAnswerCategory, type AppSettings } from '../../../packages/shared/src/index.js'
import { readSettings, toPublicSettings, writeSettings } from './settings.js'
import { SerialRunQueue } from './queue.js'
import { ModelRouter } from './model-adapters.js'
import { captureJobUrl } from './capture.js'
import { databaseBackup } from './database-backups.js'
import { registerRuntimeRoutes, type RuntimeInfo } from './runtime-routes.js'
import { registerMasterRoutes } from './master-routes.js'
import { registerTrackerRoutes } from './tracker-routes.js'
import { latestByJob } from './tracker.js'
import { registerReviewRoutes } from './review-routes.js'
import { PipelineService } from './pipeline.js'
import { listSynonyms, readMaster, readProfile } from './master.js'
import { assessRequirement } from './pipeline-core.js'
import type { Requirement } from '../../../packages/shared/src/index.js'

const isLoopback = (host: string) => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host.toLowerCase())
const applicationStatuses = ['new', 'saved', 'applied', 'screening', 'interviewing', 'offer', 'accepted', 'rejected', 'withdrawn', 'ghosted', 'skipped'] as const
const id = () => crypto.randomUUID()
const cleanText = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : ''
function similarity(left: string, right: string) {
  const a = left.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(), b = right.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  if (a === b) return 1
  if (!a || !b) return 0
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1)
  const am = Array(a.length).fill(false), bm = Array(b.length).fill(false)
  let matches = 0
  for (let i = 0; i < a.length; i++) for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) if (!bm[j] && a[i] === b[j]) { am[i] = true; bm[j] = true; matches++; break }
  if (!matches) return 0
  let k = 0, transpositions = 0
  for (let i = 0; i < a.length; i++) if (am[i]) { while (!bm[k]) k++; if (a[i] !== b[k]) transpositions++; k++ }
  const jaro = (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3
  let prefix = 0; while (prefix < Math.min(4, a.length, b.length) && a[prefix] === b[prefix]) prefix++
  return jaro + prefix * 0.1 * (1 - jaro)
}
function parseAnswer(payload: Record<string, unknown> | null) {
  if (typeof payload?.question === 'string' && payload.question.length > 2000) return { error: 'Question exceeds the 2,000 character limit.' } as const
  if (typeof payload?.answer === 'string' && payload.answer.length > 20_000) return { error: 'Answer exceeds the 20,000 character limit.' } as const
  const question = cleanText(payload?.question, 2000), answer = cleanText(payload?.answer, 20_000), category = cleanText(payload?.category, 80) || suggestAnswerCategory(question)
  const limitValue = payload?.charLimit
  const charLimit = limitValue == null || limitValue === '' ? null : Number(limitValue)
  if (!question || !answer) return { error: 'Question and answer are required.' } as const
  if (charLimit !== null && (!Number.isInteger(charLimit) || charLimit < 1 || charLimit > 100_000)) return { error: 'Character limit must be between 1 and 100,000.' } as const
  if (charLimit !== null && answer.length > charLimit) return { error: `Answer exceeds the ${charLimit} character limit.` } as const
  return { question, answer, category, charLimit }
}

export interface AppOptions {
  dataDirectory: string
  sqlite: Database.Database
  db: ClinicDatabase
  port?: number
  webPort?: number
  development?: boolean
  runtime?: RuntimeInfo
  queue?: SerialRunQueue
  modelRouter?: Pick<ModelRouter, 'complete'> & Partial<Pick<ModelRouter, 'countInputTokens'>>
}

function getRequestOrigin(context: Context): string | undefined {
  const origin = context.req.header('origin')
  return origin
}

function securityMiddleware(options: Required<Pick<AppOptions, 'port' | 'webPort' | 'development'>>) {
  return async (context: Context, next: Next) => {
    const host = context.req.header('host') ?? ''
    const hostSeparator = host.lastIndexOf(':')
    const hostName = hostSeparator >= 0 ? host.slice(0, hostSeparator).replace(/^\[|\]$/g, '') : host
    const hostPort = hostSeparator >= 0 ? Number(host.slice(hostSeparator + 1)) : 80
    if (!isLoopback(hostName) || hostPort !== options.port) return context.json({ error: 'This local app only accepts requests addressed to its loopback server.' }, 403)

    const remoteAddress = (context.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress
    if (remoteAddress && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress)) {
      return context.json({ error: 'This local app only accepts loopback connections.' }, 403)
    }

    const method = context.req.method.toUpperCase()
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const origin = getRequestOrigin(context)
      if (!origin) return context.json({ error: 'A same-origin request is required.' }, 403)
      let parsed: URL
      try { parsed = new URL(origin) } catch { return context.json({ error: 'Invalid request origin.' }, 403) }
      const allowed = new Set([
        `http://127.0.0.1:${options.port}`, `http://localhost:${options.port}`,
        ...(options.development ? [`http://127.0.0.1:${options.webPort}`, `http://localhost:${options.webPort}`] : []),
      ])
      if (!allowed.has(parsed.origin)) return context.json({ error: 'Cross-origin state changes are not allowed.' }, 403)
    }

    context.header('X-Content-Type-Options', 'nosniff')
    context.header('Referrer-Policy', 'no-referrer')
    context.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    await next()
  }
}

function localOllamaUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !isLoopback(url.hostname) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('Ollama must use a plain HTTP URL on this computer (localhost or 127.0.0.1).')
  }
  return url
}

async function testOllama(settings: AppSettings) {
  const base = localOllamaUrl(settings.ollamaBaseUrl).origin
  const response = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}. Check that Ollama is running.`)
  const payload = await response.json() as { models?: Array<{ name?: string }> }
  const models = Array.isArray(payload.models) ? payload.models.flatMap((model) => model.name ? [model.name] : []) : []
  return { ok: true, detail: models.length ? `Connected. ${models.length} model${models.length === 1 ? '' : 's'} available.` : 'Connected, but no models are installed.', models }
}

async function testAnthropic(settings: AppSettings) {
  if (!settings.anthropicApiKey) throw new Error('Add an Anthropic API key in Settings first.')
  const response = await fetch('https://api.anthropic.com/v1/models?limit=1', {
    method: 'GET',
    headers: { 'x-api-key': settings.anthropicApiKey, 'anthropic-version': '2023-06-01' },
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) {
    if (response.status === 401) throw new Error('Anthropic rejected this API key. Check the key and try again.')
    throw new Error(`Anthropic model-list request failed (HTTP ${response.status}).`)
  }
  return { ok: true, detail: 'Anthropic API key accepted. No model request was sent.' }
}

export function createApp(options: AppOptions) {
  const port = options.port ?? 3000
  const webPort = options.webPort ?? 5173
  const development = options.development ?? process.env.NODE_ENV !== 'production'
  const queue = options.queue ?? new SerialRunQueue(options.db)
  const modelRouter = options.modelRouter ?? new ModelRouter(() => readSettings(options.dataDirectory))
  const pipeline = new PipelineService(options.sqlite, options.dataDirectory, queue, modelRouter)
  const app = new Hono()
  app.use('*', securityMiddleware({ port, webPort, development }))
  app.use('/api/*', (context, next) => {
    const masterRequest = context.req.path.startsWith('/api/master/') || context.req.path === '/api/master'
    const maxSize = context.req.path === '/api/master/import-preview' || context.req.path.endsWith('/submitted-resume') ? 8_100_000 : masterRequest ? 8_000_000 : context.req.path === '/api/jobs' && context.req.method === 'POST' ? 5_000_000 : 1024 * 1024
    return bodyLimit({ maxSize, onError: (limitedContext) => limitedContext.json({ error: `Request body exceeds the ${maxSize >= 8_000_000 ? '8 MB' : maxSize === 5_000_000 ? '5 MB' : '1 MB'} limit.` }, 413) })(context, next)
  })

  app.onError((error, context) => {
    console.error(`[api] ${context.req.method} ${context.req.path}: ${error.message}`)
    return context.json({ error: 'The request could not be completed.' }, 500)
  })

  app.use('/api/*', async (context, next) => { context.header('Cache-Control', 'no-store'); await next() })
  registerRuntimeRoutes(app, options.sqlite, options.dataDirectory, options.runtime)
  app.get('/api/health', (context) => context.json({ ok: true, app: 'the-role-clinic', database: options.sqlite.open ? 'connected' : 'unavailable' }))
  registerMasterRoutes(app, options.sqlite, options.dataDirectory)
  registerReviewRoutes(app, options.sqlite, options.dataDirectory, pipeline)
  registerTrackerRoutes(app, options.sqlite, options.dataDirectory)
  app.get('/api/jobs/:id/analysis', (context) => {
    const analysis = pipeline.getAnalysis(context.req.param('id'))
    return analysis ? context.json(analysis) : context.json({ error: 'Job not found.' }, 404)
  })
  app.get('/api/jobs/:id/estimate', async (context) => {
    const kind = context.req.query('kind')
    if (kind !== 'extract' && kind !== 'tailor') return context.json({ error: 'Choose extract or tailor.' }, 400)
    try { return context.json(await pipeline.estimate(context.req.param('id'), kind)) }
    catch (error) { return context.json({ error: (error as Error).message }, 422) }
  })
  app.post('/api/jobs/:id/extract', async (context) => {
    const jobId = context.req.param('id')
    if (!options.sqlite.prepare('SELECT 1 FROM jobs WHERE id=?').get(jobId)) return context.json({ error: 'Job not found.' }, 404)
    if (options.sqlite.prepare("SELECT 1 FROM runs WHERE job_id=? AND kind='extract' AND status IN ('queued','running') LIMIT 1").get(jobId)) return context.json({ error: 'Extraction is already queued or running.' }, 409)
    try { return context.json({ run: await pipeline.enqueueExtract(jobId) }, 202) }
    catch (error) { return context.json({ error: (error as Error).message }, 422) }
  })
  app.post('/api/jobs/:id/tailor', async (context) => {
    const jobId = context.req.param('id')
    if (!options.sqlite.prepare('SELECT 1 FROM jobs WHERE id=?').get(jobId)) return context.json({ error: 'Job not found.' }, 404)
    if (options.sqlite.prepare("SELECT 1 FROM runs WHERE job_id=? AND kind='tailor' AND status IN ('queued','running') LIMIT 1").get(jobId)) return context.json({ error: 'Tailoring is already queued or running.' }, 409)
    try { return context.json({ run: await pipeline.enqueueTailor(jobId) }, 202) }
    catch (error) { return context.json({ error: (error as Error).message }, 422) }
  })
  app.post('/api/runs/:id/retry', (context) => {
    try { return context.json({ run: pipeline.retry(context.req.param('id')) }, 202) }
    catch (error) { return context.json({ error: (error as Error).message }, 409) }
  })

  app.get('/api/jobs', (context) => {
    const query = cleanText(context.req.query('q'), 200)
    const status = cleanText(context.req.query('status'), 30)
    if (status && status !== 'tracker' && !applicationStatuses.includes(status as typeof applicationStatuses[number])) return context.json({ error: 'Unknown status filter.' }, 400)
    const clauses = [query ? "(j.company LIKE ? ESCAPE '\\' OR j.title LIKE ? ESCAPE '\\' OR j.text LIKE ? ESCAPE '\\')" : '', status === 'tracker' ? "a.status NOT IN ('new','skipped')" : status ? 'COALESCE(a.status, \'new\') = ?' : ''].filter(Boolean)
    const params: string[] = []
    // Search for the typed text itself: a literal % or _ must not act as a wildcard.
    const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`
    if (query) params.push(pattern, pattern, pattern)
    if (status && status !== 'tracker') params.push(status)
    const rows = options.sqlite.prepare(`SELECT j.id,j.company,j.title,j.captured_at AS capturedAt,j.source_url AS sourceUrl,j.canonical_url AS canonicalUrl,j.apply_url AS applyUrl,j.location,j.remote,j.salary,j.source,j.capture_method AS captureMethod,substr(j.text,1,400) AS summary,COALESCE(a.status,'new') AS status,a.applied_at AS appliedAt,a.notes FROM jobs j LEFT JOIN applications a ON a.job_id=j.id ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY j.captured_at DESC`).all(...params) as Array<{ id: string }>
    const master = readMaster(options.sqlite).document, profile = readProfile(options.sqlite).document, synonyms = listSynonyms(options.sqlite)
    const latestRequirements = latestByJob(options.sqlite, 'requirements', 't.document')
    const jobs = rows.map((row) => {
      const latest = latestRequirements.get(row.id)
      const requirements = latest ? (JSON.parse(latest) as { requirements: Requirement[] }).requirements : []
      return { ...row, knockouts: requirements.filter((item) => item.kind === 'knockout').map((item) => ({ quote: item.quote, ...assessRequirement(item, master, profile, synonyms) })) }
    })
    return context.json({ jobs })
  })

  // How many jobs each Jobs view holds. Registered before `/api/jobs/:id`, which would otherwise match "counts".
  app.get('/api/jobs/counts', (context) => {
    const rows = options.sqlite.prepare("SELECT COALESCE(a.status,'new') AS status, COUNT(*) AS n FROM jobs j LEFT JOIN applications a ON a.job_id=j.id GROUP BY 1").all() as Array<{ status: string; n: number }>
    const count = (status: string) => rows.find((row) => row.status === status)?.n ?? 0
    const all = rows.reduce((sum, row) => sum + row.n, 0)
    return context.json({ new: count('new'), tracker: all - count('new') - count('skipped'), skipped: count('skipped'), all })
  })

  app.post('/api/jobs', async (context) => {
    const payload = await context.req.json().catch(() => null) as Record<string, unknown> | null
    if (!payload || typeof payload !== 'object') return context.json({ error: 'Provide a job posting.' }, 400)
    const company = cleanText(payload.company, 200), title = cleanText(payload.title, 300), text = cleanText(payload.text, 100_000)
    if (!company || !title || text.length < 40) return context.json({ error: 'Company, title, and at least 40 characters of job description are required.' }, 400)
    const rawSnapshot = typeof payload.rawSnapshot === 'string' && payload.rawSnapshot ? payload.rawSnapshot : text
    if (Buffer.byteLength(rawSnapshot) > 3_000_000) return context.json({ error: 'The captured page exceeds the 3 MB snapshot limit.' }, 413)
    const sourceUrl = cleanText(payload.url, 2000)
    let canonicalUrl: string | null = null
    let applyUrl: string | null = null
    if (sourceUrl) {
      try {
        const parsed = new URL(sourceUrl)
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error()
        parsed.hash = ''
        canonicalUrl = parsed.toString()
      } catch { return context.json({ error: 'Job URL must be a valid http or https address without credentials.' }, 400) }
    }
    const canonicalInput = cleanText(payload.canonicalUrl, 2000)
    if (canonicalInput) {
      try {
        const parsed = new URL(canonicalInput)
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error()
        parsed.hash = ''
        canonicalUrl = parsed.toString()
      } catch { return context.json({ error: 'Canonical URL must be a valid http or https address without credentials.' }, 400) }
    }
    if (canonicalUrl || sourceUrl) {
      const existing = options.sqlite.prepare('SELECT id FROM jobs WHERE canonical_url=? OR source_url=? OR source_url=?').get(canonicalUrl, sourceUrl, canonicalUrl) as { id: string } | undefined
      if (existing) return context.json({ error: 'This job URL is already saved.', duplicateId: existing.id }, 409)
    }
    if (payload.allowSimilar !== true) {
      const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
      const candidates = options.sqlite.prepare('SELECT id,company,title FROM jobs WHERE captured_at >= ? ORDER BY captured_at DESC').all(since) as Array<{ id: string; company: string; title: string }>
      const similar = candidates.find((job) => similarity(company, job.company) >= 0.88 && similarity(title, job.title) >= 0.86)
      if (similar) return context.json({ error: 'A similar company and role were saved in the last 60 days.', similar }, 409)
    }
    const applyInput = cleanText(payload.applyUrl, 2000)
    if (applyInput) {
      try { const parsed = new URL(applyInput); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(); applyUrl = parsed.toString() }
      catch { return context.json({ error: 'Apply URL must be a valid http or https address without credentials.' }, 400) }
    }
    const jobId = id(), now = new Date().toISOString()
    options.sqlite.prepare('INSERT INTO jobs(id,company,title,captured_at,source_url,raw_snapshot,text,canonical_url,apply_url,location,remote,salary,source,capture_method) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(jobId, company, title, now, sourceUrl || null, rawSnapshot, text, canonicalUrl, applyUrl, cleanText(payload.location, 300), cleanText(payload.remote, 100), cleanText(payload.salary, 200), cleanText(payload.source, 60) || 'paste', cleanText(payload.captureMethod, 60) || 'paste')
    const autoRun = await pipeline.maybeAutoExtract(jobId)
    return context.json({ id: jobId, company, title, capturedAt: now, status: 'new', extractionRunId: autoRun?.id ?? null }, 201)
  })

  app.post('/api/capture/url', async (context) => {
    const payload = await context.req.json().catch(() => null) as { url?: unknown } | null
    const url = cleanText(payload?.url, 2000)
    if (!url) return context.json({ error: 'Enter a job URL.' }, 400)
    try { return context.json(await captureJobUrl(url)) }
    catch (error) { return context.json({ error: error instanceof Error ? error.message : 'Could not capture this job page.' }, 422) }
  })

  app.get('/api/jobs/:id/snapshot', (context) => {
    const row = options.sqlite.prepare('SELECT raw_snapshot FROM jobs WHERE id=?').get(context.req.param('id')) as { raw_snapshot: string } | undefined
    if (!row) return context.json({ error: 'Job not found.' }, 404)
    context.header('Content-Disposition', 'attachment; filename="job-capture.txt"')
    return context.text(row.raw_snapshot)
  })

  app.get('/api/jobs/:id', (context) => {
    const job = options.sqlite.prepare('SELECT j.id,j.company,j.title,j.captured_at AS capturedAt,j.source_url AS sourceUrl,j.apply_url AS applyUrl,j.canonical_url AS canonicalUrl,j.location,j.remote,j.salary,j.source,j.capture_method AS captureMethod,j.text,a.id AS applicationId,a.status,a.applied_at AS appliedAt,a.notes,a.submitted_text AS submittedText,a.submitted_artifact_id AS submittedArtifactId FROM jobs j LEFT JOIN applications a ON a.job_id=j.id WHERE j.id=?').get(context.req.param('id'))
    if (!job) return context.json({ error: 'Job not found.' }, 404)
    const answers = options.sqlite.prepare('SELECT id,question,answer,category,char_limit AS charLimit,submitted_answer AS submittedAnswer,submitted_at AS submittedAt,reused_from AS reusedFrom,created_at AS createdAt,updated_at AS updatedAt FROM job_answers WHERE job_id=? ORDER BY created_at DESC').all(context.req.param('id'))
    const events = options.sqlite.prepare('SELECT status,created_at AS createdAt FROM status_events WHERE application_id=(SELECT id FROM applications WHERE job_id=?) ORDER BY created_at').all(context.req.param('id'))
    return context.json({ job, answers, events })
  })

  app.put('/api/jobs/:id/status', async (context) => {
    const jobId = context.req.param('id')
    if (!options.sqlite.prepare('SELECT 1 FROM jobs WHERE id=?').get(jobId)) return context.json({ error: 'Job not found.' }, 404)
    const payload = await context.req.json().catch(() => null) as { status?: unknown; submittedText?: unknown; notes?: unknown; submittedArtifactId?: unknown } | null
    if (!payload || !applicationStatuses.includes(payload.status as typeof applicationStatuses[number])) return context.json({ error: 'Choose a valid application status.' }, 400)
    const status = payload.status as string, now = new Date().toISOString()
    let submittedArtifactId: string | null = null, artifactText: string | null = null
    if (payload.submittedArtifactId != null) {
      if (payload.status !== 'applied' || typeof payload.submittedArtifactId !== 'string') return context.json({ error: 'Select an exported artifact when marking applied.' }, 400)
      const artifact = options.sqlite.prepare('SELECT id,document,parse_check FROM artifacts WHERE id=? AND job_id=?').get(payload.submittedArtifactId, jobId) as { id: string; document: string | null; parse_check: string | null } | undefined
      if (!artifact?.document || !artifact.parse_check || !JSON.parse(artifact.parse_check).ok) return context.json({ error: 'Choose a verified export belonging to this job.' }, 422)
      submittedArtifactId = artifact.id
      artifactText = (JSON.parse(artifact.document).blocks as Array<{ text: string }>).map((b) => b.text).join('\n')
    }

    const application = options.sqlite.prepare('SELECT id,notes FROM applications WHERE job_id=?').get(jobId) as { id: string; notes: string } | undefined
    if (submittedArtifactId && application) {
      const prior = options.sqlite.prepare('SELECT submitted_artifact_id,submitted_text FROM applications WHERE id=?').get(application.id) as { submitted_artifact_id: string | null; submitted_text: string | null }
      if ((prior.submitted_artifact_id && prior.submitted_artifact_id !== submittedArtifactId) || (prior.submitted_text && prior.submitted_text !== artifactText)) return context.json({ error: 'The original submitted version is already frozen for this application.' }, 409)
    }
    const appId = application?.id ?? id()
    const tx = options.sqlite.transaction(() => {
      options.sqlite.prepare(`INSERT INTO applications(id,job_id,status,applied_at,notes,submitted_text) VALUES(?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET status=excluded.status,applied_at=COALESCE(applications.applied_at,excluded.applied_at),notes=excluded.notes,submitted_text=COALESCE(applications.submitted_text,excluded.submitted_text)`).run(appId, jobId, status, status === 'applied' ? now : null, payload.notes === undefined ? application?.notes ?? '' : cleanText(payload.notes, 5000), status === 'applied' ? artifactText || cleanText(payload.submittedText, 100_000) || null : null)
      if (submittedArtifactId) options.sqlite.prepare('UPDATE applications SET submitted_artifact_id=COALESCE(submitted_artifact_id,?) WHERE id=?').run(submittedArtifactId, appId)
      options.sqlite.prepare('INSERT INTO status_events(id,application_id,status,created_at) VALUES(?,?,?,?)').run(id(), appId, status, now)
      if (status === 'applied') options.sqlite.prepare('UPDATE applications SET submitted_job_text=COALESCE(submitted_job_text,(SELECT text FROM jobs WHERE id=?)) WHERE id=?').run(jobId, appId)
      if (status === 'applied') options.sqlite.prepare('UPDATE job_answers SET submitted_question=COALESCE(submitted_question,question),submitted_category=COALESCE(submitted_category,category),submitted_answer=COALESCE(submitted_answer,answer),submitted_at=COALESCE(submitted_at,?) WHERE job_id=?').run(now, jobId)
    })
    tx()
    return context.json({ ok: true, status, changedAt: now })
  })

  app.post('/api/jobs/:id/answers', async (context) => {
    const jobId = context.req.param('id')
    if (!options.sqlite.prepare('SELECT 1 FROM jobs WHERE id=?').get(jobId)) return context.json({ error: 'Job not found.' }, 404)
    const payload = await context.req.json().catch(() => null) as Record<string, unknown> | null
    const parsed = parseAnswer(payload)
    if ('error' in parsed) return context.json({ error: parsed.error }, 400)
    const reusedFrom = payload?.reusedFrom
    if (reusedFrom != null && (typeof reusedFrom !== 'string' || !options.sqlite.prepare('SELECT 1 FROM job_answers WHERE id=? AND job_id<>?').get(reusedFrom, jobId))) return context.json({ error: 'Choose a past answer from another job.' }, 400)
    const { question, answer, category, charLimit } = parsed
    const answerId = id(), now = new Date().toISOString()
    options.sqlite.transaction(() => {
      options.sqlite.prepare('INSERT INTO job_answers(id,job_id,question,answer,created_at,updated_at,category,char_limit,reused_from) VALUES(?,?,?,?,?,?,?,?,?)').run(answerId, jobId, question, answer, now, now, category, charLimit, cleanText(payload?.reusedFrom, 100) || null)
      options.sqlite.prepare('INSERT INTO job_answers_fts(answer_id,job_id,question,answer) VALUES(?,?,?,?)').run(answerId, jobId, question, answer)
    })()
    return context.json({ id: answerId, question, answer, category, charLimit, createdAt: now }, 201)
  })

  app.put('/api/jobs/:id/answers/:answerId', async (context) => {
    const jobId = context.req.param('id'), answerId = context.req.param('answerId')
    if (!options.sqlite.prepare('SELECT 1 FROM job_answers WHERE id=? AND job_id=?').get(answerId, jobId)) return context.json({ error: 'Answer not found for this job.' }, 404)
    const parsed = parseAnswer(await context.req.json().catch(() => null) as Record<string, unknown> | null)
    if ('error' in parsed) return context.json({ error: parsed.error }, 400)
    const { question, answer, category, charLimit } = parsed, now = new Date().toISOString()
    options.sqlite.transaction(() => {
      options.sqlite.prepare('UPDATE job_answers SET question=?,answer=?,category=?,char_limit=?,updated_at=? WHERE id=? AND job_id=?').run(question, answer, category, charLimit, now, answerId, jobId)
      options.sqlite.prepare('DELETE FROM job_answers_fts WHERE answer_id=?').run(answerId)
      options.sqlite.prepare('INSERT INTO job_answers_fts(answer_id,job_id,question,answer) VALUES(?,?,?,?)').run(answerId, jobId, question, answer)
    })()
    return context.json({ ok: true, updatedAt: now })
  })

  app.get('/api/answers/search', (context) => {
    const query = cleanText(context.req.query('q'), 200)
    if (!query) return context.json({ answers: [] })
    try {
      const answers = options.sqlite.prepare('SELECT f.answer_id AS id,f.job_id AS jobId,j.company,j.title,f.question,f.answer,a.category,a.char_limit AS charLimit FROM job_answers_fts f JOIN jobs j ON j.id=f.job_id JOIN job_answers a ON a.id=f.answer_id WHERE job_answers_fts MATCH ? ORDER BY rank LIMIT 30').all(query)
      return context.json({ answers })
    } catch { return context.json({ answers: [] }) }
  })

  app.get('/api/settings', async (context) => context.json(toPublicSettings(await readSettings(options.dataDirectory))))

  app.put('/api/settings', async (context) => {
    const payload = await context.req.json().catch(() => null)
    const parsed = appSettingsSchema.safeParse(payload)
    if (!parsed.success) return context.json({ error: 'Settings did not match the expected format.', issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) }, 400)
    let value = parsed.data
    const current = await readSettings(options.dataDirectory)
    if (!Object.hasOwn(payload, 'anthropicApiKey')) value = { ...value, anthropicApiKey: current.anthropicApiKey }
    try { localOllamaUrl(value.ollamaBaseUrl) } catch (error) { return context.json({ error: error instanceof Error ? error.message : 'Invalid Ollama URL.' }, 400) }
    await writeSettings(options.dataDirectory, value)
    return context.json(toPublicSettings(value))
  })

  app.delete('/api/settings/anthropic-key', async (context) => {
    const settings = await readSettings(options.dataDirectory)
    delete settings.anthropicApiKey
    await writeSettings(options.dataDirectory, settings)
    return context.json(toPublicSettings(settings))
  })

  app.post('/api/connections/:provider/test', async (context) => {
    const provider = context.req.param('provider')
    if (provider !== 'ollama' && provider !== 'anthropic') return context.json({ ok: false, error: 'Unknown provider.' }, 404)
    const settings = await readSettings(options.dataDirectory)
    try {
      return context.json(provider === 'ollama' ? await testOllama(settings) : await testAnthropic(settings))
    } catch (error) {
      const message = error instanceof Error && error.name === 'TimeoutError'
        ? `${provider === 'ollama' ? 'Ollama' : 'Anthropic'} did not respond before the connection test timed out.`
        : error instanceof Error ? error.message : 'Connection test failed.'
      return context.json({ ok: false, error: message }, 502)
    }
  })

  app.post('/api/backups', async (context) => {
    return context.json({ ok: true, ...databaseBackup(options.sqlite, options.dataDirectory) }, 201)
  })

  app.get('/api/backups', async (context) => {
    const directory = join(options.dataDirectory, 'backups')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const entries = await readdir(directory, { withFileTypes: true })
    const backups = await Promise.all(entries.filter((entry) => entry.isFile() && /^(?:clinic|auto|pre-migration-v\d+)-[\dTZ-]+(?:-[a-f0-9-]+)?\.sqlite$/.test(entry.name)).map(async (entry) => {
      const details = await stat(join(directory, entry.name))
      return { filename: entry.name, bytes: details.size, createdAt: details.mtime.toISOString() }
    }))
    return context.json({ backups: backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) })
  })

  app.get('/api/runs/events', async (context) => {
    const afterRaw = context.req.query('after') ?? '0'
    const after = Number.parseInt(afterRaw, 10)
    if (!Number.isSafeInteger(after) || after < 0) return context.json({ error: 'The after cursor must be a non-negative integer.' }, 400)
    return streamSSE(context, async (stream) => {
      let closed = false
      let writeQueue = Promise.resolve()
      const send = (event: import('../../../packages/shared/src/index.js').RunEvent) => {
        writeQueue = writeQueue.then(async () => {
          if (!closed) await stream.writeSSE({ id: String(event.id), event: 'run', data: JSON.stringify(event) })
        })
        return writeQueue
      }
      for (const event of queue.getEventsAfter(after)) await send(event)
      const unsubscribe = queue.subscribe((event) => { void send(event).catch(() => { closed = true }) })
      const keepAlive = setInterval(() => { void stream.writeSSE({ event: 'ping', data: 'keepalive' }).catch(() => { closed = true }) }, 15000)
      stream.onAbort(() => { closed = true; unsubscribe(); clearInterval(keepAlive) })
      while (!closed) await new Promise((resolve) => setTimeout(resolve, 1000))
      unsubscribe()
      clearInterval(keepAlive)
    })
  })

  if (development) {
    app.post('/api/dev/queue-demo', async (context) => {
      const payload = await context.req.json().catch(() => ({}))
      if (payload && (typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length > 0)) return context.json({ error: 'This demo endpoint does not accept data.' }, 400)
      return context.json({ run: queue.enqueueDemo(), message: 'Queue infrastructure demo only. No résumé or model operation was performed.' }, 202)
    })
  }

  app.notFound((context) => context.json({ error: 'Route not found.' }, 404))
  app.all('/api/*', (context) => context.json({ error: 'API route not found.' }, 404))
  if (!development) {
    const webDist = fileURLToPath(new URL('../../web/dist/', import.meta.url))
    app.get('/guide.html', serveStatic({ root: webDist, path: 'guide.html' }))
    app.get('/icon.svg', serveStatic({ root: webDist, path: 'icon.svg' }))
    app.use('/assets/*', serveStatic({ root: webDist }))
    app.get('*', async (context) => {
      const { readFile } = await import('node:fs/promises')
      try { return context.html(await readFile(join(webDist, 'index.html'), 'utf8')) }
      catch { return context.text('The web bundle is missing. Build it with npm run build.', 503) }
    })
  }
  return Object.assign(app, { modelRouter })
}

export const configuredTasks = taskNames

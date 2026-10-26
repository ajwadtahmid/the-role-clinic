import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.js'
import { createDatabase } from './db.js'
import { defaultSettings, readSettings } from './settings.js'
import { SerialRunQueue } from './queue.js'
import { captureJobUrl } from './capture.js'

const temporaryDirectories: string[] = []
async function fixture(development = false) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'role-clinic-test-'))
  temporaryDirectories.push(dataDirectory)
  const { sqlite, db } = createDatabase(dataDirectory)
  return { dataDirectory, sqlite, db, app: createApp({ dataDirectory, sqlite, db, development, port: 3000, webPort: 5173 }) }
}
function request(app: ReturnType<typeof createApp>, path: string, init: RequestInit = {}) {
  return app.request(`http://127.0.0.1:3000${path}`, {
    ...init,
    headers: { host: '127.0.0.1:3000', ...(init.headers ?? {}) },
  })
}
const sameOrigin = { origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' }

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('Phase 1 local foundation', () => {
  it('creates the SQLite schema and reports health', async () => {
    const { app, sqlite } = await fixture()
    const response = await request(app, '/api/health')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, database: 'connected' })
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all().map((row) => (row as { name: string }).name)
    expect(tables).toContain('job_answers_fts')
    expect(tables).toContain('applications')
    expect(tables).toContain('runs')
    sqlite.close()
  })

  it('rejects hostile Host headers and cross-origin or originless mutations', async () => {
    const { app, sqlite } = await fixture()
    const hostileHost = await request(app, '/api/health', { headers: { host: 'evil.example:3000' } })
    const noOrigin = await request(app, '/api/backups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const foreignOrigin = await request(app, '/api/backups', { method: 'POST', headers: { ...sameOrigin, origin: 'http://evil.example:3000' }, body: '{}' })
    expect(hostileHost.status).toBe(403)
    expect(noOrigin.status).toBe(403)
    expect(foreignOrigin.status).toBe(403)
    sqlite.close()
  })

  it('persists per-task model choices and never returns the API key', async () => {
    const { app, dataDirectory, sqlite } = await fixture()
    const settings = defaultSettings()
    settings.taskModels.requirementExtraction = { provider: 'ollama', model: 'qwen3.5:9b' }
    settings.taskModels.resumeDrafting = { provider: 'anthropic', model: 'claude-sonnet' }
    settings.anthropicApiKey = 'sk-ant-test-secret'
    const saved = await request(app, '/api/settings', { method: 'PUT', headers: sameOrigin, body: JSON.stringify(settings) })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ taskModels: settings.taskModels, anthropicApiKeyConfigured: true })
    const loaded = await request(app, '/api/settings')
    const response = await loaded.text()
    expect(response).not.toContain('sk-ant-test-secret')
    expect(JSON.parse(response).taskModels.requirementExtraction.model).toBe('qwen3.5:9b')
    const stored = await readFile(join(dataDirectory, 'settings.json'), 'utf8')
    expect(stored).toContain('sk-ant-test-secret')
    const permissions = (await stat(join(dataDirectory, 'settings.json'))).mode & 0o777
    expect(permissions).toBe(0o600)
    sqlite.close()
  })

  it('does not allow Ollama URLs to target remote hosts', async () => {
    const { app, sqlite } = await fixture()
    const settings = defaultSettings()
    settings.ollamaBaseUrl = 'http://192.168.1.50:11434'
    const response = await request(app, '/api/settings', { method: 'PUT', headers: sameOrigin, body: JSON.stringify(settings) })
    expect(response.status).toBe(400)
    expect((await response.json()).error).toContain('localhost or 127.0.0.1')
    sqlite.close()
  })

  it('explains that an Anthropic connection test needs a saved key without sending a request', async () => {
    const { app, sqlite } = await fixture()
    const response = await request(app, '/api/connections/anthropic/test', { method: 'POST', headers: sameOrigin, body: '{}' })
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ ok: false, error: 'Add an Anthropic API key in Settings first.' })
    sqlite.close()
  })

  it('creates a consistent database backup outside the app bundle', async () => {
    const { app, dataDirectory, sqlite } = await fixture()
    const response = await request(app, '/api/backups', { method: 'POST', headers: sameOrigin, body: '{}' })
    expect(response.status).toBe(201)
    const payload = await response.json() as { filename: string }
    const backupPath = join(dataDirectory, 'backups', payload.filename)
    const backup = await readFile(backupPath)
    expect(backup.subarray(0, 16).toString()).toBe('SQLite format 3\u0000')
    sqlite.close()
  })

  it('serializes queued work and publishes replayable run events', async () => {
    const { sqlite, db } = await fixture(true)
    const queue = new SerialRunQueue(db)
    const events: number[] = []
    queue.subscribe((event) => events.push(event.id))
    const first = queue.enqueueDemo()
    const second = queue.enqueueDemo()
    await new Promise((resolve) => setTimeout(resolve, 120))
    const statuses = sqlite.prepare('SELECT status FROM runs ORDER BY created_at, rowid').all().map((row) => (row as { status: string }).status)
    expect(statuses).toEqual(['done', 'done'])
    expect(queue.getEventsAfter(0).map((event) => event.runId)).toContain(first.id)
    expect(queue.getEventsAfter(0).map((event) => event.runId)).toContain(second.id)
    expect(events).toEqual([1, 2, 3, 4, 5, 6])
    sqlite.close()
  })

  it('replays queue events over the SSE endpoint', async () => {
    const { app, sqlite } = await fixture(true)
    const queued = await request(app, '/api/dev/queue-demo', { method: 'POST', headers: { ...sameOrigin, origin: 'http://127.0.0.1:5173' }, body: '{}' })
    expect(queued.status).toBe(202)
    await new Promise((resolve) => setTimeout(resolve, 60))
    const controller = new AbortController()
    const response = await request(app, '/api/runs/events?after=0', { signal: controller.signal })
    const reader = response.body!.getReader()
    let output = ''
    for (let index = 0; index < 5 && !output.includes('queue-smoke-test'); index += 1) {
      const chunk = await reader.read()
      if (chunk.done) break
      output += new TextDecoder().decode(chunk.value)
    }
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(output).toContain('event: run')
    expect(output).toContain('queue-smoke-test')
    controller.abort()
    await reader.cancel().catch(() => undefined)
    sqlite.close()
  })
})

describe('Phase 2 capture and tracker foundation', () => {
  it('parses deterministic fixtures for every ATS route and generic JSON-LD', async () => {
    const cases: Array<{ input: string; body: unknown; parser: string }> = [
      { input: 'https://job-boards.greenhouse.io/acme/jobs/123', body: { title: 'Greenhouse Engineer', content: '<p>Build and maintain reliable services with a collaborative engineering group and modern cloud tools.</p>', location: { name: 'Remote' }, absolute_url: 'https://example.test/apply' }, parser: 'greenhouse-api' },
      { input: 'https://jobs.lever.co/acme/123', body: { text: 'Lever Engineer', description: '<p>Design dependable systems and ship product features with a cross-functional engineering team.</p>', categories: { location: 'Remote' }, hostedUrl: 'https://example.test/apply' }, parser: 'lever-api' },
      { input: 'https://jobs.ashbyhq.com/acme/job-123', body: { jobs: [{ id: 'job-123', title: 'Ashby Engineer', descriptionHtml: '<p>Own software projects from design through delivery with an experienced engineering team.</p>', jobUrl: 'https://example.test/apply' }] }, parser: 'ashby-api' },
      { input: 'https://jobs.smartrecruiters.com/Acme/123-engineer', body: { name: 'SmartRecruiters Engineer', company: { name: 'Acme' }, jobAd: { sections: { jobDescription: { title: 'Job Description', text: '<p>Create reliable backend systems and work with product partners to deliver customer value.</p>' } } } }, parser: 'smartrecruiters-api' },
      { input: 'https://acme.wd5.myworkdayjobs.com/site/job/Remote/req-123', body: { jobPostingInfo: { title: 'Workday Engineer', jobDescription: '<p>Build software used by customers and collaborate with engineers across multiple teams.</p>', location: 'Remote' } }, parser: 'workday-cxs' },
      { input: 'https://careers.example.test/jobs/123', body: `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'JSON-LD Engineer', description: '<p>Develop accessible product features and maintain reliable services for a growing team.</p>', hiringOrganization: { name: 'Example Co' } })}</script></head><body>Job</body></html>`, parser: 'readability' },
    ]
    for (const item of cases) {
      const fetcher: Parameters<typeof captureJobUrl>[1] = async (url) => ({ url, contentType: 'application/json', body: typeof item.body === 'string' ? item.body : JSON.stringify(item.body) })
      const result = await captureJobUrl(item.input, fetcher)
      expect(result.captureMethod).toBe(item.parser)
      expect(result.title).toContain('Engineer')
      expect(result.text.length).toBeGreaterThan(40)
    }
  })

  it('follows a public apply link to an ATS posting and uses that URL for deduplication', async () => {
    const applyUrl = 'https://job-boards.greenhouse.io/acme/jobs/123'
    const fetcher: Parameters<typeof captureJobUrl>[1] = async (url) => url.hostname === 'boards-api.greenhouse.io'
      ? { url, contentType: 'application/json', body: JSON.stringify({ title: 'Platform Engineer', content: '<p>Build reliable backend systems with a collaborative engineering team and cloud services.</p>', absolute_url: applyUrl }) }
      : { url, contentType: 'text/html', body: `<html><body><a href="${applyUrl}">Apply on company site</a></body></html>` }
    const result = await captureJobUrl('https://careers.example.com/roles/123', fetcher)
    expect(result).toMatchObject({ url: 'https://careers.example.com/roles/123', canonicalUrl: applyUrl, applyUrl, captureMethod: 'apply-link-follow', title: 'Platform Engineer' })
    const { app, sqlite } = await fixture()
    const first = await request(app, '/api/jobs', { method: 'POST', headers: sameOrigin, body: JSON.stringify(result) })
    expect(first.status).toBe(201)
    const duplicate = await request(app, '/api/jobs', { method: 'POST', headers: sameOrigin, body: JSON.stringify({ ...result, url: applyUrl, canonicalUrl: '' }) })
    expect(duplicate.status).toBe(409)
    sqlite.close()
  })

  it('migrates a Phase 1 database to Phase 2 without losing saved jobs', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'role-clinic-migration-'))
    temporaryDirectories.push(dataDirectory)
    const first = createDatabase(dataDirectory)
    first.sqlite.prepare('INSERT INTO jobs(id,company,title,captured_at,source_url,raw_snapshot) VALUES(?,?,?,?,?,?)').run('legacy-job', 'Acme', 'Engineer', new Date().toISOString(), null, 'Existing Phase 1 job snapshot')
    first.sqlite.close()
    const legacy = new Database(join(dataDirectory, 'clinic.sqlite'))
    legacy.exec(`DROP INDEX jobs_canonical_url_idx; DROP INDEX applications_status_idx;
      ALTER TABLE jobs DROP COLUMN text; ALTER TABLE job_answers DROP COLUMN submitted_at;
      ALTER TABLE job_answers DROP COLUMN updated_at;
      ALTER TABLE jobs DROP COLUMN canonical_url; ALTER TABLE jobs DROP COLUMN apply_url;
      ALTER TABLE jobs DROP COLUMN location; ALTER TABLE jobs DROP COLUMN remote;
      ALTER TABLE jobs DROP COLUMN salary; ALTER TABLE jobs DROP COLUMN source;
      ALTER TABLE jobs DROP COLUMN capture_method; ALTER TABLE applications DROP COLUMN submitted_text;
      ALTER TABLE job_answers DROP COLUMN category; ALTER TABLE job_answers DROP COLUMN char_limit;
      ALTER TABLE job_answers DROP COLUMN submitted_answer; ALTER TABLE job_answers DROP COLUMN reused_from;
      PRAGMA user_version = 1;`)
    legacy.close()
    const migrated = createDatabase(dataDirectory)
    expect(migrated.sqlite.pragma('user_version', { simple: true })).toBe(3)
    expect(migrated.sqlite.prepare("SELECT company,raw_snapshot,text FROM jobs WHERE id='legacy-job'").get()).toEqual({ company: 'Acme', raw_snapshot: 'Existing Phase 1 job snapshot', text: 'Existing Phase 1 job snapshot' })
    expect(migrated.sqlite.prepare('PRAGMA table_info(jobs)').all().map((column) => (column as { name: string }).name)).toContain('canonical_url')
    migrated.sqlite.close()
  })

  it('captures pasted jobs, tracks status history, and saves searchable Q&A', async () => {
    const { app, sqlite } = await fixture()
    const captured = await request(app, '/api/jobs', { method: 'POST', headers: sameOrigin, body: JSON.stringify({ company: 'Acme', title: 'Software Engineer', location: 'Remote', text: 'Build reliable software systems with a cross-functional team. Required experience includes TypeScript, testing, and cloud services.', rawSnapshot: '<html><body>Original captured posting</body></html>' }) })
    expect(captured.status).toBe(201)
    const { id } = await captured.json() as { id: string }
    const added = await request(app, `/api/jobs/${id}/answers`, { method: 'POST', headers: sameOrigin, body: JSON.stringify({ question: 'Why Acme?', answer: 'I enjoy building reliable systems.', category: 'Motivation', charLimit: 100 }) })
    expect(added.status).toBe(201)
    const applied = await request(app, `/api/jobs/${id}/status`, { method: 'PUT', headers: sameOrigin, body: JSON.stringify({ status: 'applied', submittedText: 'Submitted résumé copy' }) })
    expect(applied.status).toBe(200)
    const results = await request(app, '/api/answers/search?q=reliable')
    expect(await results.json()).toMatchObject({ answers: [{ question: 'Why Acme?', company: 'Acme' }] })
    const detail = await request(app, `/api/jobs/${id}`)
    expect(await detail.json()).toMatchObject({ job: { status: 'applied', submittedText: 'Submitted résumé copy', text: 'Build reliable software systems with a cross-functional team. Required experience includes TypeScript, testing, and cloud services.' }, events: [{ status: 'applied' }], answers: [{ category: 'Motivation', charLimit: 100, submittedAnswer: 'I enjoy building reliable systems.' }] })
    const snapshot = await request(app, `/api/jobs/${id}/snapshot`)
    expect(snapshot.headers.get('content-disposition')).toContain('attachment')
    expect(await snapshot.text()).toBe('<html><body>Original captured posting</body></html>')
    const { id: answerId } = await added.json() as { id: string }
    const edited = await request(app, `/api/jobs/${id}/answers/${answerId}`, { method: 'PUT', headers: sameOrigin, body: JSON.stringify({ question: 'Why Acme?', answer: 'I enjoy solving hard systems problems.', category: 'Motivation', charLimit: 100 }) })
    expect(edited.status).toBe(200)
    const afterEdit = await request(app, `/api/jobs/${id}`)
    expect(await afterEdit.json()).toMatchObject({ answers: [{ answer: 'I enjoy solving hard systems problems.', submittedAnswer: 'I enjoy building reliable systems.' }] })
    const editedResults = await request(app, '/api/answers/search?q=solving')
    expect(await editedResults.json()).toMatchObject({ answers: [{ answer: 'I enjoy solving hard systems problems.' }] })
    sqlite.close()
  })

  it('rejects duplicate job URLs and answers that exceed their stated limit', async () => {
    const { app, sqlite } = await fixture()
    const job = { company: 'Acme', title: 'Engineer', url: 'https://jobs.example/role#details', text: 'A sufficiently long job description with responsibilities, qualifications, and other information for a candidate to review.' }
    const first = await request(app, '/api/jobs', { method: 'POST', headers: sameOrigin, body: JSON.stringify(job) })
    const duplicate = await request(app, '/api/jobs', { method: 'POST', headers: sameOrigin, body: JSON.stringify({ ...job, url: 'https://jobs.example/role' }) })
    expect(first.status).toBe(201)
    expect(duplicate.status).toBe(409)
    const { id } = await first.json() as { id: string }
    const tooLong = await request(app, `/api/jobs/${id}/answers`, { method: 'POST', headers: sameOrigin, body: JSON.stringify({ question: 'Q?', answer: '12345', charLimit: 4 }) })
    expect(tooLong.status).toBe(400)
    sqlite.close()
  })

  it('flags a likely company-and-role duplicate but lets the user keep it separately', async () => {
    const { app, sqlite } = await fixture()
    const base = { company: 'Acme Technologies', title: 'Senior Software Engineer', text: 'Design and maintain production systems with a collaborative engineering team. Experience with TypeScript and cloud platforms is expected.' }
    const first = await request(app, '/api/jobs', { method: 'POST', headers: sameOrigin, body: JSON.stringify(base) })
    const likelyDuplicate = await request(app, '/api/jobs', { method: 'POST', headers: sameOrigin, body: JSON.stringify({ ...base, title: 'Senior Software Engineer II' }) })
    expect(first.status).toBe(201)
    expect(likelyDuplicate.status).toBe(409)
    expect(await likelyDuplicate.json()).toMatchObject({ similar: { company: 'Acme Technologies', title: 'Senior Software Engineer' } })
    const kept = await request(app, '/api/jobs', { method: 'POST', headers: sameOrigin, body: JSON.stringify({ ...base, title: 'Senior Software Engineer II', allowSimilar: true }) })
    expect(kept.status).toBe(201)
    sqlite.close()
  })

  it('blocks local-network targets before making URL capture requests', async () => {
    const { app, sqlite } = await fixture()
    const response = await request(app, '/api/capture/url', { method: 'POST', headers: sameOrigin, body: JSON.stringify({ url: 'http://127.0.0.1/private' }) })
    expect(response.status).toBe(422)
    expect((await response.json()).error).toContain('private or reserved')
    sqlite.close()
  })
})

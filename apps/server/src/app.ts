import { Hono, type Context, type Next } from 'hono'
import { streamSSE } from 'hono/streaming'
import { bodyLimit } from 'hono/body-limit'
import { serveStatic } from '@hono/node-server/serve-static'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type Database from 'better-sqlite3'
import type { ClinicDatabase } from './db.js'
import { appSettingsSchema, taskNames, type AppSettings } from '../../../packages/shared/src/index.js'
import { readSettings, toPublicSettings, writeSettings } from './settings.js'
import { SerialRunQueue } from './queue.js'
import { ModelRouter } from './model-adapters.js'

const webDist = fileURLToPath(new URL('../../web/dist/', import.meta.url))
const isLoopback = (host: string) => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host.toLowerCase())

export interface AppOptions {
  dataDirectory: string
  sqlite: Database.Database
  db: ClinicDatabase
  port?: number
  webPort?: number
  development?: boolean
  queue?: SerialRunQueue
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
  const modelRouter = new ModelRouter(() => readSettings(options.dataDirectory))
  const app = new Hono()
  app.use('*', securityMiddleware({ port, webPort, development }))
  app.use('/api/*', bodyLimit({ maxSize: 1024 * 1024, onError: (context) => context.json({ error: 'Request body exceeds the 1 MB limit.' }, 413) }))

  app.onError((error, context) => {
    console.error(`[api] ${context.req.method} ${context.req.path}: ${error.message}`)
    return context.json({ error: 'The request could not be completed.' }, 500)
  })

  app.get('/api/health', (context) => context.json({ ok: true, app: 'the-role-clinic', database: options.sqlite.open ? 'connected' : 'unavailable' }))

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
    const backupDirectory = join(options.dataDirectory, 'backups')
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 })
    const filename = `clinic-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}.sqlite`
    const path = join(backupDirectory, filename)
    options.sqlite.prepare('VACUUM INTO ?').run(path)
    return context.json({ ok: true, filename, createdAt: new Date().toISOString() }, 201)
  })

  app.get('/api/backups', async (context) => {
    const directory = join(options.dataDirectory, 'backups')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const entries = await readdir(directory, { withFileTypes: true })
    const backups = await Promise.all(entries.filter((entry) => entry.isFile() && /^clinic-[\dTZ-]+\.sqlite$/.test(entry.name)).map(async (entry) => {
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

  if (!development) {
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

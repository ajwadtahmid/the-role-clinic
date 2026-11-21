import type { Hono } from 'hono'
import { isAbsolute } from 'node:path'
import { FeedService } from './feed.js'
import { readSettings, writeSettings } from './settings.js'

const days = (value: unknown) => { const n = Number(value); return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : null }

export function registerFeedRoutes(app: Hono, feed: FeedService, dataDirectory: string, onImported: (count: number) => void = () => {}) {
  app.get('/api/feed/runs', (context) => context.json({ runs: feed.history() }))
  app.get('/api/feed/status', async (context) => context.json(await feed.status()))

  // The feed switch. Off stops imports and hides the jobs it brought in that nobody acted on; nothing is deleted, and on shows them again.
  app.put('/api/feed/enabled', async (context) => {
    const payload = await context.req.json().catch(() => null) as { enabled?: unknown } | null
    if (typeof payload?.enabled !== 'boolean') return context.json({ error: 'Send enabled as true or false.' }, 400)
    const settings = await readSettings(dataDirectory)
    await writeSettings(dataDirectory, { ...settings, feedEnabled: payload.enabled })
    return context.json(await feed.status())
  })

  // An empty path turns the feed off. Saving the path never reads or changes the file.
  app.put('/api/feed/path', async (context) => {
    const payload = await context.req.json().catch(() => null) as { path?: unknown } | null
    const path = typeof payload?.path === 'string' ? payload.path.trim() : null
    if (path === null) return context.json({ error: 'Provide a path.' }, 400)
    if (path && (!isAbsolute(path) || !/\.csv$/i.test(path) || path.length > 1000)) return context.json({ error: 'The job feed must be the full path of a .csv file.' }, 400)
    const settings = await readSettings(dataDirectory)
    await writeSettings(dataDirectory, { ...settings, jobFeed: path ? { path } : undefined })
    return context.json(await feed.status())
  })

  app.post('/api/feed/test', async (context) => {
    const payload = await context.req.json().catch(() => null) as { path?: unknown } | null
    const status = await feed.status()
    const path = typeof payload?.path === 'string' && payload.path.trim() ? payload.path.trim() : status.path ?? status.defaultPath
    if (!path) return context.json({ error: 'Enter the path of the job feed file first.' }, 400)
    try { return context.json(await feed.test(path)) }
    catch (error) { return context.json({ error: (error as Error).message }, 422) }
  })

  app.post('/api/feed/refresh', async (context) => {
    if (!(await feed.status()).configured) return context.json({ error: 'No job feed file is set.' }, 409)
    try {
      const { importedIds, ...result } = await feed.refresh()
      if (importedIds.length) onImported(importedIds.length)
      return context.json(result)
    } catch (error) { return context.json({ error: (error as Error).message }, 422) }
  })

  app.post('/api/feed/cleanup/preview', async (context) => {
    const payload = await context.req.json().catch(() => null) as { days?: unknown } | null
    const count = days(payload?.days)
    if (!count) return context.json({ error: 'Enter a number of days between 1 and 3650.' }, 400)
    return context.json(await feed.cleanupPreview(count))
  })

  app.post('/api/feed/cleanup', async (context) => {
    const payload = await context.req.json().catch(() => null) as { days?: unknown } | null
    const count = days(payload?.days)
    if (!count) return context.json({ error: 'Enter a number of days between 1 and 3650.' }, 400)
    return context.json(await feed.cleanup(count))
  })
}

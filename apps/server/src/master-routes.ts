import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { Hono } from 'hono'
import { masterBundleSchema, masterSchema, profileSchema, synonymSchema } from '../../../packages/shared/src/index.js'
import { listSynonyms, parseResumeFile, readMaster, readProfile, reconcileMaster, saveMaster, saveProfile, validateMaster } from './master.js'

const changed = (expected: unknown, actual: string | null) => expected !== actual
const now = () => new Date().toISOString()
const parseJson = async (context: { req: { json: () => Promise<unknown> } }) => context.req.json().catch(() => null)
function checkSynonyms(synonyms: Array<{ id: string; term: string; equivalence: string }>): string | null {
  const ids = new Set<string>(), pairs = new Set<string>()
  for (const item of synonyms) {
    if (ids.has(item.id)) return 'The export contains duplicate equivalence IDs.'
    ids.add(item.id)
    if (item.term.toLowerCase() === item.equivalence.toLowerCase()) return 'An equivalence contains the same term twice.'
    const key = [item.term.toLowerCase(), item.equivalence.toLowerCase()].sort().join('|')
    if (pairs.has(key)) return 'The export contains duplicate equivalences.'
    pairs.add(key)
  }
  return null
}

export function registerMasterRoutes(app: Hono, sqlite: Database.Database, dataDirectory: string) {
  app.get('/api/onboarding', (c) => {
    const jobs = (sqlite.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number }).count
    const master = readMaster(sqlite).document
    const profile = readProfile(sqlite).document
    return c.json({ capturedJob: jobs > 0, hasMaster: master.roles.length + master.projects.length + master.education.length > 0, hasProfile: !!(profile.name || profile.email), configuredModels: existsSync(join(dataDirectory, 'settings.json')), triedTracker: !!sqlite.prepare('SELECT 1 FROM status_events LIMIT 1').get() })
  })
  app.get('/api/master', (c) => c.json(readMaster(sqlite)))
  app.put('/api/master', async (c) => {
    const body = await parseJson(c)
    const parsed = masterSchema.safeParse((body as { document?: unknown } | null)?.document)
    if (!parsed.success) return c.json({ error: 'The résumé draft is invalid.', details: parsed.error.issues.slice(0, 5) }, 400)
    const expected = (body as { expectedUpdatedAt?: unknown }).expectedUpdatedAt
    if (typeof expected !== 'string' && expected !== null) return c.json({ error: 'A résumé revision is required.' }, 400)
    const current = readMaster(sqlite)
    if (changed(expected, current.updatedAt)) return c.json({ error: 'The résumé changed in another tab. Reload before saving.' }, 409)
    try {
      const next = reconcileMaster(current.document, parsed.data)
      const updatedAt = saveMaster(sqlite, next)
      return c.json({ document: next, updatedAt })
    } catch (error) { return c.json({ error: (error as Error).message }, 400) }
  })
  app.post('/api/master/import-preview', async (c) => {
    const form = await c.req.formData().catch(() => null)
    const file = form?.get('file')
    if (!(file instanceof File)) return c.json({ error: 'Choose a PDF or DOCX résumé.' }, 400)
    if (file.size > 8_000_000) return c.json({ error: 'Résumé files must be 8 MB or smaller.' }, 413)
    try { return c.json(await parseResumeFile(Buffer.from(await file.arrayBuffer()), file.name)) }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : 'Could not read this résumé.' }, 422) }
  })
  app.get('/api/profile', (c) => c.json(readProfile(sqlite)))
  app.put('/api/profile', async (c) => {
    const body = await parseJson(c)
    const parsed = profileSchema.safeParse((body as { document?: unknown } | null)?.document)
    if (!parsed.success) return c.json({ error: 'The profile is invalid.', details: parsed.error.issues.slice(0, 5) }, 400)
    const expected = (body as { expectedUpdatedAt?: unknown }).expectedUpdatedAt
    if (typeof expected !== 'string' && expected !== null) return c.json({ error: 'A profile revision is required.' }, 400)
    if (changed(expected, readProfile(sqlite).updatedAt)) return c.json({ error: 'The profile changed in another tab. Reload before saving.' }, 409)
    return c.json({ document: parsed.data, updatedAt: saveProfile(sqlite, parsed.data) })
  })
  app.get('/api/synonyms', (c) => c.json({ synonyms: listSynonyms(sqlite) }))
  app.post('/api/synonyms', async (c) => {
    const body = await parseJson(c)
    const parsed = synonymSchema.omit({ id: true }).safeParse(body)
    if (!parsed.success) return c.json({ error: 'Enter two equivalent terms.' }, 400)
    if (parsed.data.term.toLowerCase() === parsed.data.equivalence.toLowerCase()) return c.json({ error: 'The terms must differ.' }, 400)
    const existing = listSynonyms(sqlite).some((s) => [s.term, s.equivalence].map((v) => v.toLowerCase()).sort().join('|') === [parsed.data.term, parsed.data.equivalence].map((v) => v.toLowerCase()).sort().join('|'))
    if (existing) return c.json({ error: 'This equivalence is already saved.' }, 409)
    const synonym = { id: randomUUID(), ...parsed.data }
    sqlite.prepare('INSERT INTO synonyms(id,term,equivalence,created_at) VALUES(?,?,?,?)').run(synonym.id, synonym.term, synonym.equivalence, now())
    return c.json(synonym, 201)
  })
  app.delete('/api/synonyms/:id', (c) => {
    const result = sqlite.prepare('DELETE FROM synonyms WHERE id=?').run(c.req.param('id'))
    return result.changes ? c.json({ ok: true }) : c.json({ error: 'Equivalence not found.' }, 404)
  })
  app.get('/api/master/export', (c) => {
    const bundle = { format: 'the-role-clinic-master', version: 1, exportedAt: now(), master: readMaster(sqlite).document, profile: readProfile(sqlite).document, synonyms: listSynonyms(sqlite) }
    c.header('Content-Disposition', 'attachment; filename="role-clinic-master.json"')
    return c.json(bundle)
  })
  app.post('/api/master/json-preview', async (c) => {
    const body = await parseJson(c)
    const parsed = masterBundleSchema.safeParse(body)
    if (!parsed.success) return c.json({ error: 'This is not a supported master export (version 1).' }, 400)
    try { validateMaster(parsed.data.master) } catch (error) { return c.json({ error: (error as Error).message }, 400) }
    const synonymError = checkSynonyms(parsed.data.synonyms)
    if (synonymError) return c.json({ error: synonymError }, 400)
    return c.json({ bundle: parsed.data, currentUpdatedAt: readMaster(sqlite).updatedAt, counts: { roles: parsed.data.master.roles.length, projects: parsed.data.master.projects.length, skills: parsed.data.master.skills.length, summaries: parsed.data.master.summaries.length }, willReplace: !!readMaster(sqlite).updatedAt })
  })
  app.post('/api/master/json-import', async (c) => {
    const body = await parseJson(c) as { bundle?: unknown; expectedUpdatedAt?: unknown; replace?: unknown } | null
    const parsed = masterBundleSchema.safeParse(body?.bundle)
    if (!parsed.success) return c.json({ error: 'This is not a supported master export (version 1).' }, 400)
    try { validateMaster(parsed.data.master) } catch (error) { return c.json({ error: (error as Error).message }, 400) }
    const synonymError = checkSynonyms(parsed.data.synonyms)
    if (synonymError) return c.json({ error: synonymError }, 400)
    const expected = body?.expectedUpdatedAt
    if (typeof expected !== 'string' && expected !== null) return c.json({ error: 'A résumé revision is required.' }, 400)
    if (changed(expected, readMaster(sqlite).updatedAt)) return c.json({ error: 'The résumé changed since preview. Preview the file again.' }, 409)
    if (expected && body?.replace !== true) return c.json({ error: 'Confirm that the current résumé and profile will be replaced.' }, 409)
    sqlite.transaction(() => {
      saveMaster(sqlite, parsed.data.master)
      saveProfile(sqlite, parsed.data.profile)
      sqlite.prepare('DELETE FROM synonyms').run()
      const insert = sqlite.prepare('INSERT INTO synonyms(id,term,equivalence,created_at) VALUES(?,?,?,?)')
      for (const s of parsed.data.synonyms) insert.run(s.id, s.term, s.equivalence, now())
    })()
    return c.json({ master: readMaster(sqlite), profile: readProfile(sqlite), synonyms: listSynonyms(sqlite) })
  })
}

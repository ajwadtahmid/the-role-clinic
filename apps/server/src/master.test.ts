import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createDatabase } from './db.js'
import { createApp } from './app.js'
import { draftMasterFromText, snapshotMaster } from './master.js'
import { emptyMaster, emptyProfile } from '../../../packages/shared/src/index.js'

const dirs: string[] = []
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'clinic-master-')); dirs.push(directory)
  const { sqlite, db } = createDatabase(directory)
  const app = createApp({ dataDirectory: directory, sqlite, db, port: 3000 })
  const request = (path: string, init: RequestInit = {}) => app.request(`http://127.0.0.1:3000${path}`, { ...init, headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', ...(init.headers ?? {}) } })
  const send = (path: string, method: string, body: unknown) => request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { sqlite, request, send }
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))) })

describe('master and profile', () => {
  it('drafts work and projects separately, preserving uncertain text for review', () => {
    const result = draftMasterFromText(`Jane Example\nhello@example.test\nExperience\nAcme Corp San Jose, CA\nSoftware Engineer January 2024 – Present\n• Built a service with 15% lower latency\nacross two regions\nProjects\nSearch Tool | Python March 2023\n• Indexed 10,000 pages\nTechnical Skills\nLanguages: Python, TypeScript\nHobbies & Interests: Hiking`, 'resume.pdf')
    expect(result.draft.roles).toHaveLength(1)
    expect(result.draft.roles[0].bullets[0].text).toContain('across two regions')
    expect(result.draft.projects).toHaveLength(1)
    expect(result.draft.projects[0].bullets[0].text).toContain('10,000')
    expect(result.draft.projects[0].start).toBe('March 2023')
    expect(result.draft.skills.every((s) => s.evidenceIds.length === 0)).toBe(true)
    expect(result.headerText).toContain('hello@example.test')
    expect(JSON.stringify(result.draft)).not.toContain('hello@example.test')
    expect(result.draft.meta.notes).toContain('Hiking')
  })

  it('keeps bullet IDs, increments revisions, retires removals, and snapshots lazily', async () => {
    const { sqlite, request, send } = await setup()
    const first = await request('/api/master')
    const initial = await first.json() as { updatedAt: string | null }
    const master = emptyMaster(), roleId = randomUUID(), bulletId = randomUUID()
    master.roles.push({ id: roleId, company: 'Acme', title: 'Engineer', start: '2024', end: '', bullets: [{ id: bulletId, rev: 99, text: 'Improved latency by 15%', skills: ['Python'], metrics: ['15%'], verbs: [], sourceRef: 'resume.pdf' }] })
    const savedResponse = await send('/api/master', 'PUT', { document: master, expectedUpdatedAt: initial.updatedAt })
    expect(savedResponse.status).toBe(200)
    const saved = await savedResponse.json() as { document: typeof master; updatedAt: string }
    expect(saved.document.roles[0].bullets[0].rev).toBe(1)
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM master_snapshots').get() as { n: number }).n).toBe(0)
    const hash = snapshotMaster(sqlite)
    expect(snapshotMaster(sqlite)).toBe(hash)
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM master_snapshots').get() as { n: number }).n).toBe(1)
    saved.document.roles[0].bullets[0].text = 'Improved latency by 20%'
    const updatedResponse = await send('/api/master', 'PUT', { document: saved.document, expectedUpdatedAt: saved.updatedAt })
    const updated = await updatedResponse.json() as { document: typeof master; updatedAt: string }
    expect(updated.document.roles[0].bullets[0]).toMatchObject({ id: bulletId, rev: 2 })
    expect(updated.updatedAt).not.toBe(saved.updatedAt)
    const conflict = await send('/api/master', 'PUT', { document: updated.document, expectedUpdatedAt: saved.updatedAt })
    expect(conflict.status).toBe(409)
    updated.document.roles[0].bullets = []
    const retiredResponse = await send('/api/master', 'PUT', { document: updated.document, expectedUpdatedAt: updated.updatedAt })
    const retired = await retiredResponse.json() as { document: typeof master }
    expect(retired.document.roles[0].bullets[0]).toMatchObject({ id: bulletId, rev: 3, retired: true })
    const retiredSavedAt = (await (await request('/api/master')).json() as { updatedAt: string }).updatedAt
    retired.document.roles[0].bullets[0].retired = false
    expect((await send('/api/master', 'PUT', { document: retired.document, expectedUpdatedAt: retiredSavedAt })).status).toBe(400)
    const old = sqlite.prepare('SELECT document FROM master_snapshots WHERE hash=?').get(hash) as { document: string }
    expect(JSON.parse(old.document).roles[0].bullets[0].text).toBe('Improved latency by 15%')
    sqlite.close()
  })

  it('round-trips master, profile, and synonyms through reviewed JSON without touching jobs', async () => {
    const { sqlite, request, send } = await setup()
    const master = emptyMaster(); master.projects.push({ id: randomUUID(), name: 'Search', stack: ['Python'], start: 'March 2023', end: '', summary: '', bullets: [{ id: randomUUID(), rev: 1, text: 'Indexed 10,000 pages', skills: [], metrics: [], verbs: [], sourceRef: '' }] })
    const profile = { ...emptyProfile(), name: 'Jane Example', workAuthorization: 'Authorized' }
    expect((await send('/api/master', 'PUT', { document: master, expectedUpdatedAt: null })).status).toBe(200)
    expect((await send('/api/profile', 'PUT', { document: profile, expectedUpdatedAt: null })).status).toBe(200)
    const exportResponse = await request('/api/master/export')
    const bundle = await exportResponse.json() as { master: typeof master; profile: typeof profile; synonyms: unknown[] }
    expect(bundle.profile.name).toBe('Jane Example')
    expect(bundle.synonyms).toHaveLength(3)
    const preview = await send('/api/master/json-preview', 'POST', bundle)
    expect(preview.status).toBe(200)
    const revision = (await preview.json() as { currentUpdatedAt: string }).currentUpdatedAt
    const unconfirmed = await send('/api/master/json-import', 'POST', { bundle, expectedUpdatedAt: revision })
    expect(unconfirmed.status).toBe(409)
    const imported = await send('/api/master/json-import', 'POST', { bundle, expectedUpdatedAt: revision, replace: true })
    expect(imported.status).toBe(200)
    const result = await imported.json() as { master: { document: typeof master }; profile: { document: typeof profile }; synonyms: unknown[] }
    expect(result.master.document.projects[0].bullets[0].id).toBe(master.projects[0].bullets[0].id)
    expect(result.profile.document.workAuthorization).toBe('Authorized')
    expect(result.synonyms).toHaveLength(3)
    const invalid = await send('/api/master/json-preview', 'POST', { ...bundle, version: 2 })
    expect(invalid.status).toBe(400)
    const duplicate = await send('/api/master/json-preview', 'POST', { ...bundle, synonyms: [bundle.synonyms[0], bundle.synonyms[0]] })
    expect(duplicate.status).toBe(400)
    sqlite.close()
  })

  it('rejects unreadable résumé uploads before changing the master', async () => {
    const { sqlite, request } = await setup()
    const form = new FormData()
    form.append('file', new File(['not a pdf'], 'resume.pdf', { type: 'application/pdf' }))
    const response = await request('/api/master/import-preview', { method: 'POST', body: form })
    expect(response.status).toBe(422)
    expect(sqlite.prepare('SELECT 1 FROM master').get()).toBeUndefined()
    sqlite.close()
  })
})

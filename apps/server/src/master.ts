import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { extractText, getDocumentProxy } from 'unpdf'
import mammoth from 'mammoth'
import { collapseRepeatedWord, emptyMaster, emptyProfile, masterSchema, profileSchema, type Bullet, type Master, type Profile, type Synonym } from '../../../packages/shared/src/index.js'

export function readMaster(sqlite: Database.Database): { document: Master; updatedAt: string | null } {
  const row = sqlite.prepare('SELECT document,updated_at FROM master WHERE id=1').get() as { document: string; updated_at: string } | undefined
  return { document: row ? masterSchema.parse(JSON.parse(row.document)) : emptyMaster(), updatedAt: row?.updated_at ?? null }
}
export function readProfile(sqlite: Database.Database): { document: Profile; updatedAt: string | null } {
  const row = sqlite.prepare('SELECT document,updated_at FROM profile WHERE id=1').get() as { document: string; updated_at: string } | undefined
  return { document: row ? profileSchema.parse(JSON.parse(row.document)) : emptyProfile(), updatedAt: row?.updated_at ?? null }
}
export function listSynonyms(sqlite: Database.Database): Synonym[] {
  return sqlite.prepare('SELECT id,term,equivalence FROM synonyms ORDER BY term COLLATE NOCASE').all() as Synonym[]
}
export function allBullets(master: Master): Bullet[] { return [...master.roles.flatMap((r) => r.bullets), ...master.projects.flatMap((p) => p.bullets)] }
export function validateMaster(master: Master) {
  const ids = [...master.roles.map((r) => r.id), ...master.projects.map((p) => p.id), ...master.education.map((e) => e.id), ...master.summaries.map((s) => s.id), ...allBullets(master).map((b) => b.id)]
  if (new Set(ids).size !== ids.length) throw new Error('Each résumé item needs a unique ID.')
  const bullets = allBullets(master)
  if (bullets.some((b) => !b.retired && !b.text.trim())) throw new Error('Active bullets cannot be empty. Retire them instead.')
  if (new Set(master.skills.map((s) => s.name.toLowerCase())).size !== master.skills.length) throw new Error('Skill names must be unique.')
  const bulletIds = new Set(bullets.filter((b) => !b.retired).map((b) => b.id))
  if (master.skills.some((s) => s.evidenceIds.some((id) => !bulletIds.has(id)))) throw new Error('Skill evidence must refer to an active bullet.')
}
export function reconcileMaster(previous: Master, incoming: Master): Master {
  validateMaster(incoming)
  const old = new Map(allBullets(previous).map((bullet) => [bullet.id, bullet]))
  const seen = new Set(allBullets(incoming).map((bullet) => bullet.id))
  const next = structuredClone(incoming)
  for (const section of [...next.roles, ...next.projects]) for (const bullet of section.bullets) {
    const prior = old.get(bullet.id)
    if (!prior) { bullet.rev = 1; continue }
    if (prior.retired && !bullet.retired) throw new Error('Retired bullets cannot be restored; add a new bullet instead.')
    const before = { ...prior, rev: 0 }, after = { ...bullet, rev: 0 }
    if (prior.retired && JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Retired bullets are immutable; add a new bullet instead.')
    bullet.rev = prior.rev + (JSON.stringify(before) === JSON.stringify(after) ? 0 : 1)
  }
  for (const section of [...previous.roles, ...previous.projects]) for (const bullet of section.bullets) if (!seen.has(bullet.id)) {
    const target = 'company' in section ? next.roles.find((r) => r.id === section.id) : next.projects.find((p) => p.id === section.id)
    if (!target) throw new Error('Remove bullets by retiring them before deleting a role or project.')
    target.bullets.push({ ...bullet, rev: bullet.rev + (bullet.retired ? 0 : 1), retired: true })
  }
  validateMaster(next)
  return next
}
export function saveMaster(sqlite: Database.Database, master: Master): string {
  const previous = sqlite.prepare('SELECT updated_at FROM master WHERE id=1').get() as { updated_at: string } | undefined
  const current = Date.now()
  const now = new Date(previous && Date.parse(previous.updated_at) >= current ? Date.parse(previous.updated_at) + 1 : current).toISOString()
  sqlite.prepare('INSERT INTO master(id,document,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document,updated_at=excluded.updated_at').run(JSON.stringify(master), now)
  return now
}
export function saveProfile(sqlite: Database.Database, profile: Profile): string {
  const previous = sqlite.prepare('SELECT updated_at FROM profile WHERE id=1').get() as { updated_at: string } | undefined
  const current = Date.now()
  const now = new Date(previous && Date.parse(previous.updated_at) >= current ? Date.parse(previous.updated_at) + 1 : current).toISOString()
  sqlite.prepare('INSERT INTO profile(id,document,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document,updated_at=excluded.updated_at').run(JSON.stringify(profile), now)
  return now
}
export function snapshotMaster(sqlite: Database.Database): string {
  const master = readMaster(sqlite).document
  const hash = createHash('sha256').update(JSON.stringify(master)).digest('hex')
  sqlite.prepare('INSERT OR IGNORE INTO master_snapshots(hash,document,created_at) VALUES(?,?,?)').run(hash, JSON.stringify(master), new Date().toISOString())
  return hash
}

const newBullet = (text: string, sourceRef: string): Bullet => ({ id: randomUUID(), rev: 1, text, skills: [], metrics: [], verbs: [], sourceRef })
const datePattern = /(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}|\b(?:19|20)\d{2}\b/gi
function splitDates(value: string) {
  const dates = [...value.matchAll(datePattern)]
  if (!dates.length) return { label: value.trim(), start: '', end: '' }
  const start = dates[0][0], end = dates[1]?.[0] ?? (/present|current/i.test(value) ? 'Present' : '')
  return { label: value.slice(0, dates[0].index).trim().replace(/[–—-]\s*$/, '').trim(), start, end }
}

export function draftMasterFromText(text: string, sourceName: string) {
  const master = emptyMaster(); master.meta.sourceName = sourceName
  const issues: string[] = []
  const unclassified: string[] = []
  const header: string[] = []
  let section: 'header' | 'education' | 'roles' | 'projects' | 'skills' | 'summary' = 'header'
  let current: Master['roles'][number] | Master['projects'][number] | null = null
  let pendingBullet: Bullet | null = null
  const lines = text.replace(/\r/g, '').split('\n').map((line) => line.trim()).filter(Boolean)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (/^education\b/i.test(line)) { section = 'education'; current = null; pendingBullet = null; continue }
    if (/^(?:work |professional )?experience\b/i.test(line)) { section = 'roles'; current = null; pendingBullet = null; continue }
    if (/^projects?\b/i.test(line)) { section = 'projects'; current = null; pendingBullet = null; continue }
    if (/^(?:technical )?skills(?:\s*&.*)?$/i.test(line)) { section = 'skills'; current = null; pendingBullet = null; continue }
    if (/^(?:professional )?summary\b/i.test(line)) { section = 'summary'; current = null; pendingBullet = null; continue }
    if (section === 'header') { header.push(line); continue }
    if (/^[•●▪*-]\s+/.test(line)) {
      if (!current) { unclassified.push(line); issues.push('A bullet could not be assigned to a role or project.'); continue }
      pendingBullet = newBullet(line.replace(/^[•●▪*-]\s+/, ''), sourceName)
      current.bullets.push(pendingBullet)
      continue
    }
    if (section === 'skills') {
      const colon = line.indexOf(':')
      if (colon < 0) { unclassified.push(line); continue }
      const category = line.slice(0, colon).trim()
      if (/hobbies|interests|spoken languages/i.test(category)) { unclassified.push(line); continue }
      for (const name of line.slice(colon + 1).split(',').map((s) => s.trim()).filter(Boolean)) if (!master.skills.some((s) => s.name.toLowerCase() === name.toLowerCase())) master.skills.push({ name, category, evidenceIds: [] })
      continue
    }
    if (section === 'summary') { master.summaries.push({ id: randomUUID(), label: `Summary ${master.summaries.length + 1}`, text: line }); continue }
    if (section === 'education') {
      if (!master.education.length || /university|college|institute|school/i.test(line)) {
        master.education.push({ id: randomUUID(), school: collapseRepeatedWord(line), credential: '', field: '', start: '', end: '', details: '' })
        issues.push(`Check school, credential, and dates for “${line}”.`)
      }
      else master.education[master.education.length - 1].details += `${master.education[master.education.length - 1].details ? '\n' : ''}${line}`
      continue
    }
    if (section === 'projects' && line.includes('|')) {
      const [name, rest] = line.split('|', 2); const split = splitDates(rest)
      const project = { id: randomUUID(), name: name.trim(), stack: split.label.split(',').map((x) => x.trim()).filter(Boolean), start: split.start, end: split.end, summary: '', bullets: [] as Bullet[] }
      master.projects.push(project); current = project; pendingBullet = null
      if (!split.start) issues.push(`Check dates for project “${project.name}”.`)
      continue
    }
    if (section === 'roles' && current && 'company' in current && pendingBullet && lines[index + 1] && [...lines[index + 1].matchAll(datePattern)].length > 0 && !/^[•●▪*-]\s+/.test(lines[index + 1]) && line.length < 120) {
      const role = { id: randomUUID(), company: line, title: '', start: '', end: '', bullets: [] as Bullet[] }
      master.roles.push(role); current = role; pendingBullet = null
      issues.push(`Check company and location for “${role.company}”.`)
      continue
    }
    if (section === 'roles' && !current) {
      const role = { id: randomUUID(), company: line, title: '', start: '', end: '', bullets: [] as Bullet[] }
      master.roles.push(role); current = role; pendingBullet = null
      issues.push(`Check company and location for “${role.company}”.`)
      continue
    }
    if (section === 'roles' && current && 'company' in current && !current.title) {
      const split = splitDates(line)
      current.title = split.label; current.start = split.start; current.end = split.end
      if (!split.start) issues.push(`Check dates for role “${current.title}”.`)
      continue
    }
    if (pendingBullet) { pendingBullet.text += ` ${line}`; continue }
    unclassified.push(line)
  }
  if (unclassified.length) issues.push(`${unclassified.length} line(s) could not be placed automatically. Review the original text.`)
  if (!master.summaries.length) issues.push('Add your own summary variants before tailoring.')
  if (master.skills.some((s) => !s.evidenceIds.length)) issues.push('Skills imported as listings need bullet evidence before being treated as demonstrated expertise.')
  master.meta.notes = unclassified.join('\n').slice(0, 5000)
  validateMaster(master)
  return { draft: master, issues, headerText: header.join('\n'), sourceText: text }
}

export async function parseResumeFile(buffer: Buffer, filename: string) {
  const lower = filename.toLowerCase()
  let text: string
  if (lower.endsWith('.pdf')) {
    if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('This file is not a valid PDF.')
    const pdf = await getDocumentProxy(new Uint8Array(buffer))
    if (pdf.numPages > 20) throw new Error('Résumé PDFs must have 20 pages or fewer.')
    text = (await extractText(pdf, { mergePages: true })).text
  } else if (lower.endsWith('.docx')) {
    if (!buffer.subarray(0, 2).equals(Buffer.from('PK'))) throw new Error('This file is not a valid DOCX.')
    text = (await mammoth.extractRawText({ buffer })).value
  } else throw new Error('Choose a PDF or DOCX résumé.')
  if (text.length < 30) throw new Error('No readable résumé text was found. Try a text-based PDF or DOCX.')
  if (text.length > 150_000) throw new Error('Extracted résumé text exceeds the 150,000 character limit.')
  return draftMasterFromText(text, filename)
}

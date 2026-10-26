import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { extractionSchema, type BulletScore, type Extraction, type Gap, type Master, type Profile, type Requirement, type Synonym, type TailoredLine } from '../../../packages/shared/src/index.js'

const candidateSchema = z.object({ requirements: z.array(z.object({ quote: z.string().min(3).max(2000), kind: z.enum(['knockout', 'hard', 'nice']), category: z.enum(['years', 'skill', 'location', 'work_authorization', 'clearance', 'education', 'other']), skill: z.string().max(100).optional(), years: z.number().nonnegative().max(80).nullable().optional() })).max(100), seniority: z.string().max(100).optional(), vocabulary: z.array(z.string().max(100)).max(100).optional() })
const stop = new Set('a an and are as at be by for from has have in into is of on or our the their to with you your will required preferred experience ability knowledge skills strong working using use including'.split(' '))
const techNames = ['JavaScript','TypeScript','Python','Java','C++','C#','Go','Rust','Kotlin','Swift','React','React Native','Node.js','Express','Flask','Django','Spring','PostgreSQL','Postgres','MySQL','SQLite','Redis','MongoDB','Docker','Kubernetes','k8s','AWS','Azure','GCP','Terraform','Linux','GitHub Actions','GraphQL','REST','gRPC','Flutter','Dart','Android','iOS','Kafka','Spark','PyTorch','TensorFlow']
const now = () => new Date().toISOString()

export function parseModelJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  try { return JSON.parse(cleaned) }
  catch {
    const first = cleaned.indexOf('{'), last = cleaned.lastIndexOf('}')
    if (first < 0 || last <= first) throw new Error('The model did not return valid JSON. Retry this run.')
    try { return JSON.parse(cleaned.slice(first, last + 1)) }
    catch { throw new Error('The model did not return valid JSON. Retry this run.') }
  }
}

function normalizeWithOffsets(value: string) {
  let normalized = '', offsets: number[] = [], space = false
  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (/\s/.test(char)) {
      if (!space && normalized) { normalized += ' '; offsets.push(i) }
      space = true
    } else { normalized += char.toLowerCase(); offsets.push(i); space = false }
  }
  return { normalized: normalized.trimEnd(), offsets }
}
export function locateQuote(text: string, quote: string): { start: number; end: number } | null {
  const haystack = normalizeWithOffsets(text), needle = normalizeWithOffsets(quote).normalized
  const position = haystack.normalized.indexOf(needle)
  if (position < 0 || !needle) return null
  return { start: haystack.offsets[position], end: haystack.offsets[position + needle.length - 1] + 1 }
}
function yearsFromRoles(master: Master) {
  const intervals = master.roles.flatMap((role) => {
    const start = Date.parse(role.start), end = /present|current/i.test(role.end) ? Date.now() : Date.parse(role.end)
    return Number.isFinite(start) && Number.isFinite(end) && end >= start ? [[start, end] as const] : []
  }).sort((a, b) => a[0] - b[0])
  const merged: number[][] = []
  for (const [start, end] of intervals) {
    const last = merged.at(-1)
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return Math.round(merged.reduce((sum, [start, end]) => sum + (end - start) / (365.25 * 86_400_000), 0) * 10) / 10
}
export function assessRequirement(requirement: Requirement, master: Master, profile: Profile, synonyms: Synonym[] = []): Pick<Requirement, 'assessment' | 'basis'> {
  const quote = requirement.quote.toLowerCase()
  if (requirement.category === 'years' && requirement.years != null) {
    if (requirement.skill) {
      const names = equivalences(requirement.skill, synonyms)
      const skill = master.skills.find((item) => names.includes(item.name.toLowerCase()))
      if (skill?.years != null) return { assessment: skill.years >= requirement.years ? 'met' : 'gap', basis: `${skill.years} years recorded for ${skill.name} in the master; requirement: ${requirement.years}.` }
      return { assessment: 'unknown', basis: `No verified years recorded for ${requirement.skill}. A skill listing or project date is not employment duration.` }
    }
    const years = yearsFromRoles(master)
    if (years > 0) return { assessment: years >= requirement.years ? 'met' : 'gap', basis: `${years} years across dated employment roles; requirement: ${requirement.years}. Overlapping roles counted once.` }
    return { assessment: 'unknown', basis: 'No dated employment roles available to calculate total years.' }
  }
  if (requirement.category === 'work_authorization') {
    const authorization = profile.workAuthorization.trim()
    if (!authorization) return { assessment: 'unknown', basis: 'Work authorization is not recorded in the private profile.' }
    if (/not (?:authorized|eligible)/i.test(authorization)) return { assessment: 'gap', basis: `Private profile says: ${authorization}` }
    if (/citizen/i.test(quote)) {
      if (/\b(?:u\.?s\.?|united states|american)\b.{0,20}citizen|citizen.{0,20}\b(?:u\.?s\.?|united states|american)\b/i.test(authorization)) return { assessment: 'met', basis: `Private profile says: ${authorization}` }
      return { assessment: 'unknown', basis: `Citizenship is not established by the private profile: ${authorization}` }
    }
    if (/authorized|eligible to work/i.test(authorization)) return { assessment: 'met', basis: `Private profile says: ${authorization}` }
    return { assessment: 'unknown', basis: `Private profile says: ${authorization}` }
  }
  if (requirement.category === 'education') {
    const degrees = master.education.map((item) => [item.credential, item.field, item.details].join(' ')).join(' ')
    if (!degrees.trim()) return { assessment: 'unknown', basis: 'No degree details recorded in the master résumé.' }
    if (/bachelor|b\.?s\.?|b\.?a\.?/i.test(quote) && /bachelor|b\.?s\.?|b\.?a\.?/i.test(degrees)) return { assessment: 'met', basis: `Recorded education: ${degrees.slice(0, 250)}` }
    if (/master|m\.?s\.?|ph\.?d/i.test(quote) && /master|m\.?s\.?|ph\.?d/i.test(degrees)) return { assessment: 'met', basis: `Recorded education: ${degrees.slice(0, 250)}` }
    return { assessment: 'unknown', basis: `Degree requirement needs review against recorded education: ${degrees.slice(0, 250)}` }
  }
  if (requirement.category === 'location') return { assessment: 'unknown', basis: profile.location ? `Profile location: ${profile.location}. Confirm commute, relocation, or remote policy manually.` : 'Profile location is not recorded.' }
  if (requirement.category === 'clearance') return { assessment: 'unknown', basis: 'Clearance status is not recorded as a verified field.' }
  if (requirement.category === 'skill' && requirement.skill) {
    const names = equivalences(requirement.skill, synonyms)
    const evidence = evidenceRows(master).find((row) => names.some((name) => includesTerm(`${row.bullet.text} ${row.bullet.skills.join(' ')}`, name)))
    if (evidence) return { assessment: 'met', basis: `Master bullet ${evidence.bullet.id}: ${evidence.bullet.text.slice(0, 220)}` }
    const listed = master.skills.find((skill) => names.includes(skill.name.toLowerCase()))
    return { assessment: 'gap', basis: listed ? `${listed.name} is listed, but no active bullet demonstrates its use. Add real evidence if you have it.` : `No active master bullet demonstrates ${requirement.skill}. This is an evidence gap, not proof you lack the skill.` }
  }
  return { assessment: 'unknown', basis: 'Compare this requirement against the cited résumé evidence.' }
}
export function normalizeExtraction(modelText: string, jobText: string, master: Master, profile: Profile, synonyms: Synonym[] = []): Extraction {
  const parsed = candidateSchema.parse(parseModelJson(modelText))
  const requirements: Requirement[] = []
  const seen = new Set<string>()
  for (const candidate of parsed.requirements) {
    const range = locateQuote(jobText, candidate.quote)
    if (!range) continue
    const key = `${range.start}:${range.end}:${candidate.category}`
    if (seen.has(key)) continue
    seen.add(key)
    const requirement: Requirement = { id: randomUUID(), quote: jobText.slice(range.start, range.end), kind: candidate.kind, category: candidate.category, skill: candidate.skill?.trim() ?? '', years: candidate.years ?? null, ...range, assessment: 'unknown', basis: '' }
    Object.assign(requirement, assessRequirement(requirement, master, profile, synonyms))
    requirements.push(requirement)
  }
  if (parsed.requirements.length && !requirements.length) throw new Error('No model requirements matched exact text in the posting. Retry extraction.')
  const result = { requirements, seniority: parsed.seniority?.trim() ?? '', vocabulary: [...new Set((parsed.vocabulary ?? []).map((v) => v.trim()).filter(Boolean))], partial: requirements.length < parsed.requirements.length }
  return extractionSchema.parse(result)
}

const tokens = (value: string) => [...new Set((value.toLowerCase().match(/[a-z][a-z0-9+#.-]*/g) ?? []).filter((word) => word.length > 2 && !stop.has(word)))]
function equivalences(term: string, synonyms: Synonym[]) {
  const lower = term.toLowerCase()
  return [lower, ...synonyms.flatMap((s) => s.term.toLowerCase() === lower ? [s.equivalence.toLowerCase()] : s.equivalence.toLowerCase() === lower ? [s.term.toLowerCase()] : [])]
}
function includesTerm(text: string, term: string) { return new RegExp(`(?:^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z0-9])`, 'i').test(text) }
export function chooseSummary(master: Master, jobText: string) {
  const jobTerms = new Set(tokens(jobText))
  return master.summaries.filter((summary) => summary.text.trim()).sort((a, b) => {
    const score = (value: string) => tokens(value).filter((term) => jobTerms.has(term)).length
    return score(`${b.label} ${b.text}`) - score(`${a.label} ${a.text}`)
  })[0] ?? null
}
export function selectSkillsLine(master: Master, extraction: Extraction, jobTitle: string, synonyms: Synonym[]) {
  const jobText = `${jobTitle} ${extraction.requirements.map((r) => r.quote).join(' ')}`
  return master.skills.filter((skill) => skill.name && equivalences(skill.name, synonyms).some((name) => includesTerm(jobText, name)))
    .sort((a, b) => {
      const relevance = (name: string) => extraction.requirements.reduce((score, requirement) => score + (equivalences(name, synonyms).some((term) => includesTerm(requirement.quote, term)) ? requirement.kind === 'nice' ? 1 : 2 : 0), 0)
      return relevance(b.name) - relevance(a.name) || Number(b.evidenceIds.length > 0) - Number(a.evidenceIds.length > 0)
    }).slice(0, 20).map((skill) => skill.name)
}
export function evidenceRows(master: Master) {
  return [...master.roles.flatMap((role) => role.bullets.filter((b) => !b.retired).map((bullet) => ({ bullet, context: `${role.title} at ${role.company}, ${role.start}–${role.end}`, kind: 'employment' as const }))), ...master.projects.flatMap((project) => project.bullets.filter((b) => !b.retired).map((bullet) => ({ bullet, context: `${project.name} project, ${project.start}–${project.end}, ${project.stack.join(', ')}`, kind: 'project' as const })))]
}
export function scoreEvidence(master: Master, extraction: Extraction, synonyms: Synonym[]): BulletScore[] {
  return evidenceRows(master).map(({ bullet, context }) => {
    const source = `${bullet.text} ${bullet.skills.join(' ')} ${context}`.toLowerCase()
    const matches = extraction.requirements.flatMap((requirement) => {
      const terms = [...tokens(requirement.quote), ...tokens(requirement.skill)]
      const overlap = terms.filter((term) => equivalences(term, synonyms).some((v) => includesTerm(source, v))).length
      return overlap > 0 ? [{ id: requirement.id, overlap, denominator: Math.max(terms.length, 1), kind: requirement.kind }] : []
    })
    const score = Math.min(100, Math.round(matches.reduce((sum, match) => sum + Math.min(30, match.overlap / match.denominator * 60) * (match.kind === 'nice' ? .65 : 1), 0)))
    return { bulletId: bullet.id, score, requirementIds: matches.map((m) => m.id), rationale: matches.length ? `Shares terms with ${matches.length} cited job requirement(s).` : 'No direct vocabulary overlap; review manually.' }
  }).sort((a, b) => b.score - a.score)
}
export function findGaps(extraction: Extraction, scores: BulletScore[], master: Master): Gap[] {
  const active = new Set(evidenceRows(master).map((row) => row.bullet.id))
  return extraction.requirements.flatMap((requirement) => {
    const support = scores.filter((s) => s.score >= 25 && s.requirementIds.includes(requirement.id) && active.has(s.bulletId))
    if (support.length && requirement.assessment !== 'gap') return []
    const reason = requirement.assessment === 'gap' ? requirement.basis : requirement.category === 'skill' && master.skills.some((s) => s.name.toLowerCase() === requirement.skill.toLowerCase()) ? 'Listed in the master, but no matching evidence bullet was found.' : 'No strong matching bullet was found; verify or add real evidence.'
    return [{ requirementId: requirement.id, quote: requirement.quote, reason, evidenceIds: support.map((s) => s.bulletId) }]
  })
}
const numeric = (text: string) => [...new Set((text.match(/\b\d[\d,]*(?:\.\d+)?(?:%|\+|\s+percent)?/gi) ?? []).map((value) => value.replaceAll(',', '').replace(/\s+percent$/i, '%')))]
export function verifyLayer1(output: string, sourceIds: string[], master: Master, synonyms: Synonym[]): string[] {
  const rows = evidenceRows(master).filter((row) => sourceIds.includes(row.bullet.id))
  if (!rows.length) return ['No valid source bullet was cited.']
  const source = rows.map((row) => `${row.context} ${row.bullet.text} ${row.bullet.skills.join(' ')} ${row.bullet.metrics.join(' ')}`).join('\n')
  const flags: string[] = []
  for (const value of numeric(output)) if (!numeric(source).includes(value)) flags.push(`New or changed number: ${value}`)
  const known = [...new Set([...techNames, ...master.skills.map((s) => s.name), ...master.projects.flatMap((p) => p.stack)])].filter((term) => term.length >= 2).sort((a, b) => b.length - a.length)
  for (const term of known) if (includesTerm(output, term) && !equivalences(term, synonyms).some((variant) => includesTerm(source, variant))) flags.push(`Tool or skill lacks cited evidence: ${term}`)
  for (const role of master.roles) if (role.company.length >= 3 && includesTerm(output, role.company) && !includesTerm(source, role.company)) flags.push(`Company lacks cited evidence: ${role.company}`)
  if (rows.every((row) => row.kind === 'project') && /\b(?:employed|employment|my role at|worked at)\b/i.test(output)) flags.push('Project evidence is presented as employment.')
  return [...new Set(flags)]
}
export function antiSlop(lines: Array<Pick<TailoredLine, 'text'>>, master: Master, vocabulary: string[]): string[][] {
  const masterVerbs = new Set(evidenceRows(master).flatMap((row) => [row.bullet.text.split(/\s+/)[0]?.toLowerCase(), ...row.bullet.verbs.map((v) => v.toLowerCase())]))
  const jdVerbs = new Set(vocabulary.map((v) => v.toLowerCase()))
  const starts = lines.map((line) => line.text.trim().split(/\s+/)[0]?.toLowerCase() ?? '')
  return lines.map((line, index) => {
    const flags: string[] = []
    if (/\b(?:results-driven|passionate professional|dynamic team player|leveraged synergies|cutting-edge)\b/i.test(line.text)) flags.push('Generic or inflated phrase.')
    if (index >= 2 && starts[index] === starts[index - 1] && starts[index] === starts[index - 2]) flags.push('Three consecutive bullets start with the same verb.')
    if (starts[index] && !masterVerbs.has(starts[index]) && !jdVerbs.has(starts[index])) flags.push(`Action verb not found in the master or job vocabulary: ${starts[index]}`)
    if (!/\d/.test(line.text) && !/\b(?:api|service|app|database|pipeline|interface|test|deployment|platform|system|model|feature|report|audit|customer|user)\b/i.test(line.text)) flags.push('No number or concrete artefact detected.')
    return flags
  })
}

import { randomUUID } from 'node:crypto'
import { extractionSchema, type BulletScore, type Extraction, type Gap, type Master, type Profile, type Requirement, type Synonym, type TailoredLine } from '../../../packages/shared/src/index.js'
import { extractionCandidatesSchema } from './model-schemas.js'

const stop = new Set('a an and are as at be by for from has have in into is of on or our the their to with you your will required preferred experience ability knowledge skills strong working using use including'.split(' '))
export const techNames = ['JavaScript','TypeScript','Python','Java','C++','C#','Go','Rust','Kotlin','Swift','React','React Native','Node.js','Express','Flask','Django','Spring','PostgreSQL','Postgres','MySQL','SQLite','Redis','MongoDB','Docker','Kubernetes','k8s','AWS','Azure','GCP','Terraform','Linux','GitHub Actions','GraphQL','REST','gRPC','Flutter','Dart','Android','iOS','Kafka','Spark','PyTorch','TensorFlow']
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
    } else { normalized += /[\u2010\u2011]/.test(char) ? '-' : char.toLowerCase(); offsets.push(i); space = false }
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
// Abbreviations must be standalone (and upper-case) so "Systems", "basic" or "jobs" never count as a degree.
const bachelorLevel = (text: string) => /\bbachelor/i.test(text) || /\bB\.?(?:S|A|Sc|Eng)\b/.test(text)
const masterLevel = (text: string) => /\bmaster|\bph\.?d\b|\bdoctorate/i.test(text) || /\bM\.?(?:S|A|Sc|Eng|BA)\b/.test(text)
export function assessRequirement(requirement: Requirement, master: Master, profile: Profile, synonyms: Synonym[] = []): Pick<Requirement, 'assessment' | 'basis'> {
  const quote = requirement.quote.toLowerCase()
  if (requirement.category === 'years' && requirement.years != null) {
    const months = quote.match(/(\d+(?:\.\d+)?)\s*months?/)
    const threshold = months ? Number(months[1]) / 12 : requirement.years
    const upper = /\b(?:at most|no more than|maximum|up to|not exceed|less than|fewer than)\b/.test(quote)
    const strict = /\b(?:less than|fewer than|more than|over)\b/.test(quote) && !/no more than/.test(quote)
    const compare = (years: number) => upper ? strict ? years < threshold : years <= threshold : strict ? years > threshold : years >= threshold
    if (requirement.skill) {
      const names = equivalences(requirement.skill, synonyms)
      const skill = master.skills.find((item) => names.includes(item.name.toLowerCase()))
      if (skill?.years != null && !/professional|employment|commercial|industry/.test(quote)) return { assessment: compare(skill.years) ? 'met' : 'gap', basis: `${skill.years} years recorded for ${skill.name} in the master; requirement: ${requirement.quote}` }
      return { assessment: 'unknown', basis: `No verified years recorded for ${requirement.skill}. A skill listing or project date is not employment duration.` }
    }
    const qualifier = /software|programming|development|coding/.test(quote) ? /software|developer|programmer|front.?end|back.?end|full.?stack/i : /regulatory/.test(quote) ? /regulatory/i : /hardware|electrical|mechanical|data scien/.test(quote) ? new RegExp(quote.match(/hardware|electrical|mechanical|data scien/)![0], 'i') : null
    const roles = qualifier ? master.roles.filter((role) => qualifier.test(role.title)) : master.roles
    const years = yearsFromRoles({ ...master, roles })
    if (years > 0) return { assessment: compare(years) ? 'met' : 'gap', basis: `${years} years across dated${qualifier ? ' matching' : ''} employment roles; requirement: ${requirement.quote}. Overlapping roles counted once.` }
    if (qualifier) return { assessment: 'unknown', basis: 'No dated employment role establishes the requested experience qualifier; unrelated employment and projects cannot prove it.' }
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
    if (/graduat|enroll|student|pursu|expected|within|between|\b(?:19|20)\d{2}\b|\band\b|minimum|gpa/.test(quote)) return { assessment: 'unknown', basis: `This compound education condition also contains a date, status or other constraint; the degree alone does not establish every part. Recorded education: ${degrees.slice(0, 250)}` }
    const field = quote.match(/\bin\s+([^.;]+?)(?:\s+(?:required|preferred|or equivalent|or a related|with)\b|$)/)?.[1]
    if (field && !/technical|related|relevant|any|equivalent/.test(field) && !master.education.some((education) => includesTerm(field, education.field) || includesTerm(education.field, field))) return { assessment: 'unknown', basis: `The requested field is not established by the recorded degree: ${degrees.slice(0, 250)}` }
    if (bachelorLevel(requirement.quote) && bachelorLevel(degrees)) return { assessment: 'met', basis: `Recorded education: ${degrees.slice(0, 250)}` }
    if (masterLevel(requirement.quote) && masterLevel(degrees)) return { assessment: 'met', basis: `Recorded education: ${degrees.slice(0, 250)}` }
    return { assessment: 'unknown', basis: `Degree requirement needs review against recorded education: ${degrees.slice(0, 250)}` }
  }
  if (requirement.category === 'location') return { assessment: 'unknown', basis: profile.location ? `Profile location: ${profile.location}. Confirm commute, relocation, or remote policy manually.` : 'Profile location is not recorded.' }
  if (requirement.category === 'clearance') return { assessment: 'unknown', basis: 'Clearance status is not recorded as a verified field.' }
  if (requirement.category === 'skill' && requirement.skill) {
    // "relational databases (Postgres, MySQL)" or "A or B" is met by evidence of any one named part.
    const items = skillItems(requirement.skill)
    const evidence = evidenceRows(master).find((row) => {
      const source = `${row.bullet.text} ${row.bullet.skills.join(' ')}`
      return items.some((item) => itemHit(source, stemsOf(source), item, synonyms))
    })
    if (evidence) return { assessment: 'met', basis: `Master bullet ${evidence.bullet.id}: ${evidence.bullet.text.slice(0, 220)}` }
    if (/\s+or\s+/i.test(requirement.skill)) return { assessment: 'unknown', basis: 'No listed alternative has verified active evidence; review the alternatives manually.' }
    const names = items.flatMap((item) => equivalences(item, synonyms))
    const listed = master.skills.find((skill) => names.includes(skill.name.toLowerCase()))
    return { assessment: 'gap', basis: listed ? `${listed.name} is listed, but no active bullet demonstrates its use. Add real evidence if you have it.` : `No active master bullet demonstrates ${requirement.skill}. This is an evidence gap, not proof you lack the skill.` }
  }
  return { assessment: 'unknown', basis: 'Compare this requirement against the cited résumé evidence.' }
}
export function normalizeExtraction(modelText: string, jobText: string, master: Master, profile: Profile, synonyms: Synonym[] = []): Extraction {
  const parsed = extractionCandidatesSchema.parse(parseModelJson(modelText))
  const requirements: Requirement[] = []
  const seen = new Set<string>()
  for (const candidate of parsed.requirements) {
    const range = locateQuote(jobText, candidate.quote)
    if (!range) continue
    const context = jobText.slice(jobText.lastIndexOf('\n', range.start) + 1, range.end)
    const instruction = /\b(?:ignore|disregard|override)\b.{0,90}\b(?:instruction|prompt|rule|previous|evidence)|\b(?:assistant|system)\s*:|\b(?:system prompt|return (?:only |no other |a verdict|grounded)|claim (?:the candidate|that|a citizenship)|fabricate|pretend|mark.{0,30}grounded)\b/i
    if (instruction.test(candidate.quote) || instruction.test(context)) continue
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
function includesTerm(text: string, term: string, caseSensitive = false) { return new RegExp(`(?:^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z0-9])`, caseSensitive ? '' : 'i').test(text) }
// Tool names that are also everyday words: only the exact capitalised form counts as a tool in the output.
const ambiguousTerms = new Set(['go', 'rest', 'rust', 'swift', 'spring', 'spark', 'express'])
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
// Words that say how much or how well, not what. They are ignored when a requirement is compared with a bullet.
const filler = new Set('solid good basic familiarity familiar understanding proficient proficiency hands-on hands demonstrated proven track record comfortable comfort able excellent clear clearly such like etc similar other related least more most one two years year work role roles team teams new tools tool technologies technology fundamentals concepts coursework projects internships internship hackathons exposure interest across many all any also both well ensure highly very'.split(' '))
// What counts as evidence of a broad area a posting names. A person's own synonyms still apply on top.
const concepts: Array<[RegExp, string[]]> = [
  [/\bdatabases?\b|\bsql\b/i, ['sql', 'mysql', 'postgres', 'postgresql', 'sqlite', 'mariadb', 'oracle', 'database']],
  [/non-?relational|nosql/i, ['mongodb', 'redis', 'dynamodb', 'cassandra', 'elasticsearch', 'nosql']],
  [/\bai\b|\bml\b|machine learning|artificial intelligence|\bllms?\b/i, ['ai', 'ml', 'machine learning', 'llm', 'neural network', 'deep learning', 'nlp', 'pytorch', 'tensorflow', 'scikit-learn', 'openai', 'claude', 'gemini']],
  [/ai[ -](?:assisted|coding|tools?)|coding (?:assistants?|agents?)|agentic/i, ['ai', 'llm', 'claude', 'cursor', 'copilot', 'chatgpt', 'codex', 'gemini']],
  [/algorithms?|data structures?/i, ['algorithm', 'data structure', 'tf-idf', 'pagerank', 'hash table', 'binary tree', 'graph traversal', 'sorting', 'dynamic programming']],
  [/distributed/i, ['distributed', 'replication', 'sharding', 'microservice', 'load balancing', 'kafka', 'message queue']],
  [/cloud|\baws\b|azure|\bgcp\b/i, ['aws', 'azure', 'gcp', 'google cloud', 'ec2', 'lambda', 'cloud']],
  [/ci[/-]cd|continuous integration|release (?:pipeline|engineering)/i, ['ci/cd', 'github actions', 'jenkins', 'gitlab ci', 'circleci', 'continuous integration']],
  [/version control|\bgit\b/i, ['git', 'github', 'gitlab', 'version control']],
  [/front-?end|client-side|web (?:app|application)s?/i, ['react', 'html', 'css', 'javascript', 'typescript', 'frontend', 'front-end', 'flutter', 'vue', 'angular']],
  [/back-?end|server-side|\bapis?\b/i, ['node.js', 'express', 'tomcat', 'flask', 'django', 'spring', 'api', 'backend', 'back-end']],
  [/programming languages?|\blanguages?\b/i, ['python', 'java', 'c++', 'c#', 'javascript', 'typescript', 'kotlin', 'dart', 'rust', 'swift', 'ruby', 'php', 'scala']],
  [/dashboards?|data visuali[sz]ation|analytics/i, ['dashboard', 'visualization', 'visualisation', 'analytics', 'tableau', 'grafana', 'looker', 'power bi']],
  [/security|cyber/i, ['security', 'secure', 'authentication', 'encryption', 'https', 'tls', 'ssl', 'recaptcha', 'oauth', 'iam', 'access control', 'vulnerability', 'vulnerabilities']],
  [/audit|compliance|\bgrc\b|regulat/i, ['audit', 'compliance', 'regulatory', 'regulation', 'sop', 'standard operating procedure', 'quality management', 'gxp', 'fda']],
]
const wordsOf = (value: string) => value.toLowerCase().match(/[a-z][a-z0-9+#]*(?:[.-][a-z0-9+#]+)*/g) ?? []
// A crude stem, applied twice, so "coordinating" matches "coordinate" and "algorithm" matches "algorithms".
const stem1 = (word: string) => word.length < 5 ? word : word.replace(/(?:ing|ed|es|s)$/, '').replace(/e$/, '')
const stem = (word: string) => stem1(stem1(word))
const stemsOf = (value: string) => new Set(wordsOf(value).map(stem))
const contentWords = (value: string) => wordsOf(value).filter((word) => word.length > 2 && !stop.has(word) && !filler.has(word))
// The named parts of a skill: "relational databases (Postgres, MySQL)" is three, "A or B" two.
export function skillItems(skill: string) {
  const parts = skill.replace(/ci\/cd/gi, 'CI-CD').split(/\s*(?:,|;|\/|\(|\)|\band\b|\bor\b|\bsuch as\b|\blike\b|\be\.g\.?|\bincluding\b)\s*/i).map((part) => part.trim())
    .filter((part) => part && (contentWords(part).length || /^[a-z+#]{2,3}$/i.test(part)))
  return parts.length ? parts : skill.trim() ? [skill.trim()] : []
}
function hasTerm(source: string, stems: Set<string>, term: string) {
  if (includesTerm(source, term) || includesTerm(source, `${term}s`)) return true
  return /^[a-z]+$/i.test(term) && !ambiguousTerms.has(term.toLowerCase()) && stems.has(stem(term.toLowerCase()))
}
// Whether the bullet shows one named part of a requirement: the phrase itself, an equivalent, or a stand-in for a broad area.
function itemHit(source: string, stems: Set<string>, item: string, synonyms: Synonym[]) {
  if (ambiguousTerms.has(item.toLowerCase())) return includesTerm(source, item, true)
  const words = contentWords(item)
  // A broad area ("databases", "GRC support") stands in for its tools only when the item is a short name for it,
  // not when the word sits inside a longer description such as "interpreting customer security requests".
  const terms = [...equivalences(item, synonyms), ...(words.length <= 2 ? concepts.filter(([pattern]) => pattern.test(item)).flatMap(([, list]) => list) : [])]
  if (terms.some((term) => hasTerm(source, stems, term))) return true
  if (!words.length) return false
  const matched = words.filter((word) => equivalences(word, synonyms).some((term) => hasTerm(source, stems, term))).length
  return words.length === 1 ? matched === 1 : matched / words.length >= .6
}
const SUPPORT = 40
// 0-100: how well one bullet shows one requirement. A named part of the skill (any one, from a list) is enough on its own;
// otherwise the share of the requirement's own meaningful words the bullet uses has to be high.
function supportStrength(requirement: Requirement, source: string, stems: Set<string>, synonyms: Synonym[]) {
  const items = skillItems(requirement.skill), hits = items.filter((item) => itemHit(source, stems, item, synonyms)).length
  const words = contentWords(requirement.quote), matched = words.filter((word) => equivalences(word, synonyms).some((term) => hasTerm(source, stems, term))).length
  const overlap = words.length ? matched / words.length : 0
  return Math.round(Math.min(100, Math.max(hits ? Math.max(45, hits / items.length * 100) : 0, matched >= 2 && overlap >= .4 ? overlap * 100 : overlap * 50)))
}
export function scoreEvidence(master: Master, extraction: Extraction, synonyms: Synonym[]): BulletScore[] {
  return evidenceRows(master).map(({ bullet, context }) => {
    // The role or project name and its stack count a little less than the bullet's own words, so direct evidence ranks first.
    const own = `${bullet.text} ${bullet.skills.join(' ')}`, wide = `${own} ${context}`, ownStems = stemsOf(own), wideStems = stemsOf(wide)
    const pairs = extraction.requirements.map((requirement) => ({ requirement, strength: Math.max(supportStrength(requirement, own, ownStems, synonyms), Math.round(supportStrength(requirement, wide, wideStems, synonyms) * .75)) })).filter((pair) => pair.strength > 0)
    const values = pairs.map((pair) => pair.strength * (pair.requirement.kind === 'nice' ? .65 : 1)), top = Math.max(0, ...values)
    const score = Math.min(100, Math.round(top + (values.reduce((sum, value) => sum + value, 0) - top) * .25))
    const supported = pairs.filter((pair) => pair.strength >= SUPPORT)
    return { bulletId: bullet.id, score, requirementIds: supported.map((pair) => pair.requirement.id), rationale: supported.length ? `Shows ${supported.length} cited job requirement(s).` : pairs.length ? 'Only a loose vocabulary overlap; review manually.' : 'No direct vocabulary overlap; review manually.' }
  }).sort((a, b) => b.score - a.score)
}
export function findGaps(extraction: Extraction, scores: BulletScore[], master: Master): Gap[] {
  const active = new Set(evidenceRows(master).map((row) => row.bullet.id))
  return extraction.requirements.flatMap((requirement) => {
    if (requirement.assessment === 'met') return []
    const support = scores.filter((s) => s.score >= 25 && s.requirementIds.includes(requirement.id) && active.has(s.bulletId))
    if (support.length && requirement.assessment !== 'gap') return []
    const reason = requirement.assessment === 'gap' ? requirement.basis : requirement.category === 'skill' && master.skills.some((s) => s.name.toLowerCase() === requirement.skill.toLowerCase()) ? 'Listed in the master, but no matching evidence bullet was found.' : 'No strong matching bullet was found; verify or add real evidence.'
    return [{ requirementId: requirement.id, quote: requirement.quote, reason, evidenceIds: support.map((s) => s.bulletId) }]
  })
}
const numeric = (text: string) => {
  const normalized = text.replace(/(\d[\d,]*(?:\.\d+)?)\s+percent\b/gi, '$1%')
    .replace(/\b(?:no more than|at most|under|less than)\s+(\d[\d,]*(?:\.\d+)?%?)/gi, '$1≤')
    .replace(/\b(?:over|more than|at least)\s+(\d[\d,]*(?:\.\d+)?%?)/gi, '$1+')
  return [...new Set((normalized.match(/\b\d[\d,]*(?:\.\d+)?%?[+≤]?/gi) ?? []).map((value) => value.replaceAll(',', '')))]
}
export function verifyLayer1(output: string, sourceIds: string[], master: Master, synonyms: Synonym[]): string[] {
  const rows = evidenceRows(master).filter((row) => sourceIds.includes(row.bullet.id))
  if (!rows.length) return ['No valid source bullet was cited.']
  const source = rows.map((row) => `${row.context} ${row.bullet.text} ${row.bullet.skills.join(' ')} ${row.bullet.metrics.join(' ')}`).join('\n')
  const flags: string[] = []
  const missing = sourceIds.filter((id) => !rows.some((row) => row.bullet.id === id))
  if (missing.length) flags.push(`Unmatched source IDs: ${missing.join(', ')}`)
  for (const value of numeric(output)) if (!numeric(source).includes(value)) flags.push(`New or changed number: ${value}`)
  const known = [...new Set([...techNames, ...master.skills.map((s) => s.name), ...master.projects.flatMap((p) => p.stack)])].filter((term) => term.length >= 2).sort((a, b) => b.length - a.length)
  for (const term of known) if (includesTerm(output, term, ambiguousTerms.has(term.toLowerCase())) && !equivalences(term, synonyms).some((variant) => includesTerm(source, variant))) flags.push(`Tool or skill lacks cited evidence: ${term}`)
  for (const role of master.roles) if (role.company.length >= 3 && includesTerm(output, role.company) && !includesTerm(source, role.company)) flags.push(`Company lacks cited evidence: ${role.company}`)
  const citedRoles = master.roles.filter((role) => role.bullets.some((bullet) => sourceIds.includes(bullet.id)))
  const sameEmployer = (name: string, company: string) => {
    const normalize = (value: string) => value.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    return includesTerm(normalize(name), normalize(company)) || (normalize(name).length >= 3 && includesTerm(normalize(company), normalize(name)))
  }
  const attributions = [...output.matchAll(/\b(?:worked at|employed by|employment at)\s+([^,;.]+)|^At\s+([^,;.]+)[,;]/gim)]
  for (const match of attributions) {
    if (/^scale(?:$|\s+(?:building|designing|developing|processing|operating|supporting|on|with|to)\b)/.test(match[1] ?? match[2])) continue
    const employer = (match[1] ?? match[2]).split(/\s+(?:from|in|during|as|where)\s+/i)[0].trim()
    if (!citedRoles.some((role) => sameEmployer(employer, role.company))) flags.push(`Employer attribution lacks cited role evidence: ${employer}`)
  }
  const titles = [...output.matchAll(/\b(?:worked|served|employed)\s+as\s+(?:an?\s+)?([^,;.]+?)\s+(?:at|for)\s+([^,;\n]+)/gi),
    ...[...output.matchAll(/\b([A-Z][a-zA-Z]*(?:[ /-][A-Z][a-zA-Z]*){0,6})\s+at\s+([^,;\n]+)/g)].filter((match) => /\b(?:Engineer|Developer|Associate|Manager|Analyst|Scientist|Architect|Consultant|Officer|President|Director|Coordinator|Administrator|Technician|Intern|CEO|CTO|CFO|COO|SRE|VP)\b/.test(match[1]))]
  for (const match of titles) {
    const title = match[1].replace(/^At\s+|^As\s+|^Worked\s+as\s+/i, '').trim()
    if (!citedRoles.some((role) => role.title.toLowerCase() === title.toLowerCase() && sameEmployer(match[2], role.company))) flags.push(`Job title/employer attribution lacks cited role evidence: ${title} at ${match[2]}`)
  }
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

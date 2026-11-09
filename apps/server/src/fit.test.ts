import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { emptyMaster, type Extraction, type Master, type Requirement } from '../../../packages/shared/src/index.js'
import { assessRequirement, findGaps, scoreEvidence } from './pipeline-core.js'
import { bestMatches, computeFit, fitGaps, liveSuggestions } from './fit.js'

const bullet = (text: string) => ({ id: randomUUID(), rev: 1, text, skills: [], metrics: [], verbs: [], sourceRef: '' })
const project = (master: Master, texts: string[]) => master.projects.push({ id: randomUUID(), name: 'Shop', stack: [], start: 'March 2023', end: 'June 2023', summary: '', bullets: texts.map(bullet) })
const requirement = (quote: string, over: Partial<Requirement> = {}): Requirement => ({ id: randomUUID(), quote, kind: 'hard', category: 'skill', skill: '', years: null, start: 0, end: quote.length, assessment: 'unknown', basis: '', ...over })
const extraction = (...requirements: Requirement[]): Extraction => ({ requirements, seniority: '', vocabulary: [], partial: false })
// The same steps the app takes: assess each requirement, score the bullets, find the gaps.
function check(master: Master, ...requirements: Requirement[]) {
  const found = extraction(...requirements)
  for (const item of found.requirements) Object.assign(item, assessRequirement(item, master, { workAuthorization: '', location: '' } as never, []))
  const scores = scoreEvidence(master, found, [])
  return { found, scores, gaps: findGaps(found, scores, master) }
}

describe('fit scoring', () => {
  const master = emptyMaster()
  project(master, [
    'Improved throughput by 15% by implementing MySQL replication and connection pooling',
    'Engineered full-text search ranking 330,000 pages with TF-IDF and PageRank algorithms',
    'Authored and maintained 70 Standard Operating Procedures aligned to evolving regulations',
    'Built secure authentication and Google reCAPTCHA for login',
  ])

  it('counts a bullet that names one part of a combined skill', () => {
    const databases = requirement('have some familiarity with relational databases like Postgres or MySQL', { skill: 'relational databases (Postgres, MySQL)' })
    expect(check(master, databases).gaps).toEqual([])
  })

  it('matches plurals and broad areas, and one named part of a list is enough', () => {
    const basics = requirement('solid fundamentals in data structures, algorithms, and distributed systems', { skill: 'data structures, algorithms, and distributed systems' })
    expect(check(master, basics).gaps).toEqual([])
  })

  it('does not cover a long requirement because it shares a single word with a bullet', () => {
    const request = requirement('Ability to understand what a customer is asking in a security request and respond accurately', { skill: 'interpreting customer security requests' })
    expect(check(master, request).gaps).toHaveLength(1)
  })

  it('never treats an empty skill as matching every bullet', () => {
    const vague = requirement('Experience operating a fleet of satellites in orbit', { skill: '' })
    expect(check(master, vague).gaps).toHaveLength(1)
  })

  it('does not cover a named tool that no bullet shows, and lets a lone direct match cover a nice-to-have', () => {
    const terraform = requirement('Hands-on experience with Terraform', { skill: 'Terraform' })
    const sql = requirement('Experience with MySQL', { skill: 'MySQL', kind: 'nice' })
    const { gaps, found } = check(master, terraform, sql)
    expect(gaps.map((gap) => gap.requirementId)).toEqual([found.requirements[0].id])
  })

  it('does not report a requirement the app judged as met as a gap', () => {
    const degree = requirement("Bachelor's degree in computer science", { category: 'education', assessment: 'met' })
    expect(findGaps(extraction(degree), [], master)).toEqual([])
  })
})

describe('fit score', () => {
  it('leaves out conditions the app cannot judge, but counts ones it can', () => {
    const found = extraction(requirement('Irvine, CA or Fairfax, VA', { category: 'location' }), requirement('5+ years of work', { category: 'years', assessment: 'gap' }), requirement('Python', { skill: 'Python' }))
    const gaps = found.requirements.slice(1).map((item) => ({ requirementId: item.id, quote: item.quote, reason: '', evidenceIds: [] }))
    expect(computeFit(found, gaps)).toMatchObject({ hardTotal: 2, hardCovered: 0, pct: 0 })
    expect(computeFit(found, [gaps[0]])).toMatchObject({ hardTotal: 2, hardCovered: 1, pct: 50 })
  })
})

describe('model suggestions', () => {
  const master = emptyMaster()
  project(master, ['Resolved 100 customer complaints by leading cross-department investigations to ensure satisfaction'])
  const shown = master.projects[0].bullets[0]
  const ask = requirement('Comfort engaging with customers on compliance topics', { skill: '' })
  const suggest = (over = {}) => ({ ...extraction(ask), suggestions: [{ requirementId: ask.id, bulletId: shown.id, evidence: 'leading cross-department investigations', reason: 'Led investigations.', ...over }] })

  it('counts a suggestion whose quote is in the bullet and marks it as suggested', () => {
    const found = suggest(), scores = scoreEvidence(master, found, [])
    expect(liveSuggestions(found, master)).toHaveLength(1)
    expect(fitGaps(found, scores, master)).toEqual([])
    expect(bestMatches(found, [], scores, master)[0]).toMatchObject({ bulletId: shown.id, suggested: true, reason: 'Led investigations.' })
  })

  it('drops a suggestion whose quote is not in the bullet, whose bullet changed, or that is too short to prove anything', () => {
    expect(liveSuggestions(suggest({ evidence: 'led a team of ten engineers' }), master)).toEqual([])
    expect(liveSuggestions(suggest({ evidence: 'to ensure' }), master)).toEqual([])
    const edited = structuredClone(master); edited.projects[0].bullets[0].text = 'Answered the phone'
    expect(liveSuggestions(suggest(), edited)).toEqual([])
    const retired = structuredClone(master); retired.projects[0].bullets[0].retired = true
    expect(liveSuggestions(suggest(), retired)).toEqual([])
  })

  it('cannot cover a requirement that names a technology', () => {
    const rust = requirement('Experience with Rust', { skill: 'Rust' })
    const found = { ...extraction(rust), suggestions: [{ requirementId: rust.id, bulletId: shown.id, evidence: 'leading cross-department investigations', reason: 'x' }] }
    expect(liveSuggestions(found, master)).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { emptyMaster, emptyProfile, type Requirement, type Synonym } from '../../../packages/shared/src/index.js'
import { assessRequirement, chooseSummary, locateQuote, normalizeExtraction, selectSkillsLine, verifyLayer1 } from './pipeline-core.js'

describe('deterministic pipeline checks', () => {
  const bulletId = randomUUID()
  const master = emptyMaster()
  master.roles.push({ id: randomUUID(), company: 'Acme', title: 'Engineer', start: 'January 2025', end: 'Present', bullets: [{ id: bulletId, rev: 1, text: 'Improved API latency by 15% with Kubernetes and JavaScript', skills: [], metrics: ['15%'], verbs: [], sourceRef: '' }] })
  master.projects.push({ id: randomUUID(), name: 'Search', stack: ['Python'], start: 'March 2023', end: 'June 2023', summary: '', bullets: [{ id: randomUUID(), rev: 1, text: 'Indexed 10,000 pages using Python', skills: [], metrics: ['10,000'], verbs: [], sourceRef: '' }] })
  master.skills.push({ name: 'Rust', category: 'Languages', evidenceIds: [] }, { name: 'JavaScript', category: 'Languages', evidenceIds: [bulletId] }, { name: 'Go', category: 'Languages', evidenceIds: [] })
  const synonyms: Synonym[] = [{ id: randomUUID(), term: 'Kubernetes', equivalence: 'k8s' }, { id: randomUUID(), term: 'JavaScript', equivalence: 'JS' }]

  it('accepts confirmed equivalences but flags changed metrics, dates, and listed-only skills', () => {
    expect(verifyLayer1('Improved API latency by 15% with k8s and JS', [bulletId], master, synonyms)).toEqual([])
    expect(verifyLayer1('Improved API latency by 15 percent with k8s and JS', [bulletId], master, synonyms)).toEqual([])
    const flags = verifyLayer1('Improved API latency by 20% with Rust in 2023', [bulletId], master, synonyms)
    expect(flags.join(' ')).toContain('20%')
    expect(flags.join(' ')).toContain('2023')
    expect(flags.join(' ')).toContain('Rust')
  })

  it('does not promote project work into employment or a skill listing into evidence', () => {
    const projectBullet = master.projects[0].bullets[0].id
    expect(verifyLayer1('Worked at Search indexing 10,000 pages using Python', [projectBullet], master, synonyms)).toContain('Project evidence is presented as employment.')
    const requirement: Requirement = { id: randomUUID(), quote: 'Rust experience required', kind: 'hard', category: 'skill', skill: 'Rust', years: null, start: 0, end: 24, assessment: 'unknown', basis: '' }
    expect(assessRequirement(requirement, master, emptyProfile(), synonyms)).toMatchObject({ assessment: 'gap' })
  })

  it('keeps only quotes that resolve to JD spans and marks discarded model excerpts as partial', () => {
    const jd = 'Experience with Kubernetes is required.\nA degree is preferred.'
    expect(locateQuote(jd, 'Kubernetes is required')).toEqual({ start: 16, end: 38 })
    const extraction = normalizeExtraction(JSON.stringify({ requirements: [
      { quote: 'Kubernetes is required', kind: 'hard', category: 'skill', skill: 'k8s', years: null },
      { quote: 'Ten years of Rust required', kind: 'hard', category: 'years', skill: 'Rust', years: 10 },
    ], seniority: '', vocabulary: [] }), jd, master, emptyProfile(), synonyms)
    expect(extraction.requirements).toHaveLength(1)
    expect(extraction.requirements[0].assessment).toBe('met')
    expect(extraction.partial).toBe(true)
  })

  it('chooses a user-written summary and whole-term skills by job relevance', () => {
    master.summaries.push({ id: randomUUID(), label: 'Mobile', text: 'Built Android interfaces' }, { id: randomUUID(), label: 'Backend', text: 'Built backend APIs with JavaScript' })
    const jd = 'Good JS experience is required for backend APIs.'
    const extraction = normalizeExtraction(JSON.stringify({ requirements: [{ quote: 'JS experience is required', kind: 'hard', category: 'skill', skill: 'JS', years: null }], seniority: '', vocabulary: [] }), jd, master, emptyProfile(), synonyms)
    expect(chooseSummary(master, jd)?.label).toBe('Backend')
    expect(selectSkillsLine(master, extraction, 'Good Engineer', synonyms)).toEqual(['JavaScript'])
  })

  it('does not treat everyday words that are also tool names as unsupported tools', () => {
    const prose = 'Led the rest of the team to go beyond the spring release, express concerns early and spark fixes with Kubernetes'
    expect(verifyLayer1(prose, [bulletId], master, synonyms)).toEqual([])
    expect(verifyLayer1('Built services in Go with Rust tooling', [bulletId], master, synonyms).join(' ')).toMatch(/Go[\s\S]*Rust|Rust[\s\S]*Go/)
  })

  it('matches degree levels as whole terms, not letters inside other words', () => {
    const education = { id: randomUUID(), school: 'State University', credential: 'Bachelor of Science', field: 'Information Systems', start: '', end: '', details: '' }
    const withDegree = { ...master, education: [education] }
    const ask = (quote: string): Requirement => ({ id: randomUUID(), quote, kind: 'knockout', category: 'education', skill: '', years: null, start: 0, end: quote.length, assessment: 'unknown', basis: '' })
    expect(assessRequirement(ask("Master's degree required"), withDegree, emptyProfile(), synonyms).assessment).toBe('unknown')
    expect(assessRequirement(ask('Bachelor’s degree in a technical field'), withDegree, emptyProfile(), synonyms).assessment).toBe('met')
    expect(assessRequirement(ask('Basic knowledge of jobs systems'), withDegree, emptyProfile(), synonyms).assessment).toBe('unknown')
    expect(assessRequirement(ask('BS or MS in Computer Science'), withDegree, emptyProfile(), synonyms).assessment).toBe('met')
  })
})

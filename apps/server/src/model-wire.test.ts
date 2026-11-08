import { describe, expect, it } from 'vitest'
import { aliasRequest, outputBudget, outputBudgetForChars } from './model-wire.js'
import { ModelRouter, type ModelAdapter, type ModelRequest } from './model-adapters.js'
import { modelFormats, parseDraft, requireIds, scoreResponseSchema } from './model-schemas.js'
import { verifyLayer1 } from './pipeline-core.js'
import { defaultSettings } from './settings.js'
import { emptyMaster } from '../../../packages/shared/src/index.js'

const b = '780ce552-4e91-4f48-8b26-b0c9a7121701', r = '780ce552-e914-4f48-8b26-b0c9a7121702', l = '780ce552-e914-4f48-8b26-b0c9a7121703'
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

describe('request-local aliases', () => {
  it('uses short wire IDs, restores only reference fields, and keeps quoted evidence unchanged', () => {
    const wire = aliasRequest({ system: 'test', tier: 'fast', schema: modelFormats.score, user: JSON.stringify({ requirements: [{ id: r }], bullets: [{ id: b, text: `Evidence mentioning ${b}` }], lines: [{ outId: l, sources: [{ id: b }] }] }) })
    const input = JSON.parse(wire.request.user)
    expect(input.requirements[0].id).toBe('R1'); expect(input.bullets[0].id).toBe('B1'); expect(input.lines[0].outId).toBe('L1')
    expect(input.lines[0].sources[0].id).toBe('B1'); expect(input.bullets[0].text).toContain(b)
    const result = JSON.parse(wire.restore(JSON.stringify({ scores: [{ bulletId: 'B1', requirementIds: ['R1'], rationale: 'B1 literal text' }], lines: [{ outId: 'L1', sourceIds: ['B1'] }] })))
    expect(result.scores[0].bulletId).toBe(b); expect(result.scores[0].requirementIds).toEqual([r]); expect(result.scores[0].rationale).toBe('B1 literal text')
    expect(result.lines[0]).toEqual({ outId: l, sourceIds: [b] }); expect(JSON.stringify(wire.request.schema)).not.toContain('"format":"uuid"')
  })

  it('leaves unknown IDs invalid and request-local mappings isolated', () => {
    const make = (id: string) => aliasRequest({ system: 'test', tier: 'fast', user: JSON.stringify({ bullets: [{ id }] }) })
    expect(JSON.parse(make(b).restore('{"lines":[{"sourceIds":["B99"]}]}')).lines[0].sourceIds).toEqual(['invalid-alias:B99'])
    expect(JSON.parse(make(r).restore('{"scores":[{"bulletId":"B1"}]}')).scores[0].bulletId).toBe(r)
  })

  it('handles server repair suffixes and malformed replies without accepting partial JSON', () => {
    const wire = aliasRequest({ system: 'test', tier: 'fast', user: JSON.stringify({ bullets: [{ id: b }] }) + `\n\nYour previous reply omitted ${b}.` })
    expect(wire.request.user).not.toContain(b); expect(wire.restore('{"scores":[')).toBe('{"scores":[')
  })

  it.each([1, 4])('requires all %i scores on the wire even without requirements', (count) => {
    const bullets = Array.from({ length: count }, (_, index) => ({ id: `${b.slice(0, -1)}${index}` }))
    const wire = aliasRequest({ system: 'test', tier: 'fast', schema: modelFormats.score, user: JSON.stringify({ requirements: [], bullets }) })
    const format = wire.request.schema as any
    expect(format.properties.scores).toMatchObject({ minItems: count, maxItems: count })
    expect(format.properties.scores.items.properties.requirementIds.maxItems).toBe(0)
    const parsed = scoreResponseSchema.parse(JSON.parse(wire.restore(JSON.stringify({ scores: bullets.map((_, index) => ({ bulletId: `B${index + 1}`, score: 0, requirementIds: [], rationale: 'No requirements supplied.' })) }))))
    expect(() => requireIds(parsed.scores.map(score => score.bulletId), new Set(bullets.map(bullet => bullet.id)), 'Scoring bullets', true)).not.toThrow()
    expect(() => requireIds([], new Set(bullets.map(bullet => bullet.id)), 'Scoring bullets', true)).toThrow('missing IDs')
    expect(() => requireIds([bullets[0].id, bullets[0].id], new Set(bullets.map(bullet => bullet.id)), 'Scoring bullets', true)).toThrow('duplicate IDs')
  })

  it('restricts each reference field to supplied aliases of the right kind', () => {
    const input = { requirements: [{ id: r }], bullets: [{ id: b }], lines: [{ outId: l, sources: [{ id: b }] }] }
    const make = (schema: Record<string, unknown>) => aliasRequest({ system: 'test', tier: 'fast', schema, user: JSON.stringify(input) })
    const score = make(modelFormats.score).request.schema as any
    expect(score.properties.scores.items.properties.bulletId.enum).toEqual(['B1'])
    expect(score.properties.scores.items.properties.requirementIds.items.enum).toEqual(['R1'])
    const draft = make(modelFormats.draft)
    expect((draft.request.schema as any).properties.lines.items.properties.sourceIds.items.enum).toEqual(['B1'])
    expect(() => parseDraft(JSON.parse(draft.restore('{"lines":[{"text":"Unsupported citation","sourceIds":["R1"]}]}')), new Set([b]))).toThrow('invalid-alias:R1')
    const verdict = make(modelFormats.verdict).request.schema as any
    expect(verdict.properties.verdicts.items.properties.outId.enum).toEqual(['L1'])
    expect((modelFormats.score as any).properties.scores.minItems).toBeUndefined()
    expect((modelFormats.draft as any).properties.lines.items.properties.sourceIds.items.format).toBe('uuid')
  })

  it('sends no UUID to the model through the router and restores the reply to the stored IDs', async () => {
    const seen: ModelRequest[] = []
    const adapter: ModelAdapter = {
      provider: 'ollama',
      async complete(model, request) {
        seen.push(request)
        // A model that copies the short IDs it was given, plus one it invented.
        return { text: JSON.stringify({ scores: [{ bulletId: 'B1', requirementIds: ['R1', 'R7'], rationale: 'fits' }] }), model, provider: 'ollama' }
      },
    }
    const router = new ModelRouter(async () => defaultSettings(), { ollama: adapter, anthropic: adapter })
    const response = await router.complete('bulletScoring', { system: 'test', tier: 'fast', schema: modelFormats.score, user: JSON.stringify({ requirements: [{ id: r }], bullets: [{ id: b, text: 'Built APIs' }] }) })
    expect(seen).toHaveLength(1)
    expect(seen[0].user).not.toMatch(UUID); expect(JSON.stringify(seen[0].schema)).not.toMatch(UUID)
    expect(JSON.stringify(seen[0].schema)).not.toContain('"format":"uuid"')
    const score = JSON.parse(response.text).scores[0]
    expect(score.bulletId).toBe(b); expect(score.requirementIds).toEqual([r, 'invalid-alias:R7'])
  })

  it('shares one budget rule between the estimate and the calls', () => {
    const request = { system: 'test', tier: 'fast' as const, user: 'x'.repeat(10000) }
    expect(outputBudgetForChars('resumeDrafting', 10000, 4096, 'gemma4:12b')).toBe(outputBudget('resumeDrafting', request, 4096, 'gemma4:12b'))
    expect(outputBudget('resumeDrafting', request, 4096, 'gemma4:12b')).toBeGreaterThan(4096)
  })

  it('bounds adaptive budgets and reserves room for GPT reasoning', () => {
    const request = { system: 'test', tier: 'fast' as const, user: 'x'.repeat(10000) }
    expect(outputBudget('resumeDrafting', request, 4096, 'gpt-oss:20b')).toBeGreaterThan(outputBudget('resumeDrafting', request, 4096, 'gemma4:12b'))
    expect(outputBudget('resumeDrafting', { ...request, user: 'x'.repeat(100000) }, 4096, 'gpt-oss:20b')).toBeLessThanOrEqual(8192)
  })

  it('does not treat worked at scale as an employer claim', () => {
    const master = emptyMaster()
    master.projects.push({ id: l, name: 'Example', summary: '', start: '2020', end: '2021', stack: [], bullets: [{ id: b, rev: 1, text: 'Worked at scale building APIs.', skills: [], metrics: [], verbs: [], sourceRef: 'test' }] })
    expect(verifyLayer1('Worked at scale building APIs.', [b], master, [])).not.toContainEqual(expect.stringContaining('Employer attribution'))
    expect(verifyLayer1('Worked at Scale AI building APIs.', [b], master, [])).toContainEqual(expect.stringContaining('Employer attribution'))
    expect(verifyLayer1('Worked at Other Company building APIs.', [b], master, [])).toContainEqual(expect.stringContaining('Employer attribution'))
  })
})

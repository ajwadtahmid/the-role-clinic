import { z } from 'zod'
import { bulletScoreSchema } from '../../../packages/shared/src/index.js'

export const extractionCandidatesSchema = z.object({ requirements: z.array(z.object({
  quote: z.string().min(3).max(2000), kind: z.enum(['knockout', 'hard', 'nice']),
  category: z.enum(['years', 'skill', 'location', 'work_authorization', 'clearance', 'education', 'other']),
  skill: z.string().max(100).optional(), years: z.number().nonnegative().max(80).nullable().optional(),
}).strict()).max(100), seniority: z.string().max(100).optional(), vocabulary: z.array(z.string().max(100)).max(100).optional() }).strict()
export const candidatesSchema = z.object({ lines: z.array(z.object({ text: z.string().trim().min(1).max(4000), sourceIds: z.array(z.string().uuid()).min(1).max(10) }).strict()).min(1).max(12) }).strict()
export const scoreResponseSchema = z.object({ scores: z.array(bulletScoreSchema.extend({ requirementIds: z.array(z.string().uuid()).max(8), rationale: z.string().max(240) })).max(4) }).strict()
export const verdictResponseSchema = z.object({ verdicts: z.array(z.object({ outId: z.string().uuid(), verdict: z.enum(['grounded', 'stretch', 'unsupported']), reason: z.string().max(1000) }).strict()).max(20) }).strict()
export const slopResponseSchema = z.object({ flags: z.array(z.object({ outId: z.string().uuid(), flags: z.array(z.string().max(300)).max(10) }).strict()).max(20) }).strict()
export const modelFormats = {
  extraction: z.toJSONSchema(extractionCandidatesSchema, { io: 'input' }),
  draft: z.toJSONSchema(candidatesSchema, { io: 'input' }),
  score: z.toJSONSchema(scoreResponseSchema, { io: 'input' }),
  verdict: z.toJSONSchema(verdictResponseSchema, { io: 'input' }),
  slop: z.toJSONSchema(slopResponseSchema, { io: 'input' }),
}
export function requireIds(ids: string[], allowed: Set<string>, label: string, complete = false) {
  const unmatched = [...new Set(ids.filter((id) => !allowed.has(id)))], duplicates = ids.filter((id, index) => ids.indexOf(id) !== index)
  const missing = complete ? [...allowed].filter((id) => !ids.includes(id)) : []
  if (unmatched.length || duplicates.length || missing.length) throw new Error(`${label}: unmatched IDs [${unmatched.join(', ')}]; duplicate IDs [${duplicates.join(', ')}]; missing IDs [${missing.join(', ')}]. Use only the exact supplied IDs.`)
}
export function parseDraft(value: unknown, allowed: Set<string>) {
  if (value && typeof value === 'object' && 'lines' in value && Array.isArray(value.lines)) {
    for (const line of value.lines) if (line && typeof line === 'object' && Array.isArray(line.sourceIds)) requireIds(line.sourceIds.filter((id: unknown): id is string => typeof id === 'string'), allowed, 'Draft sources')
  }
  return candidatesSchema.parse(value).lines
}

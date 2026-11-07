import { z } from 'zod'

export const taskNames = [
  'requirementExtraction',
  'eligibilityAnalysis',
  'bulletScoring',
  'resumeDrafting',
  'claimVerification',
  'antiSlop',
] as const

export const taskNameSchema = z.enum(taskNames)
export type TaskName = z.infer<typeof taskNameSchema>

export const modelChoiceSchema = z.object({
  provider: z.enum(['ollama', 'anthropic']),
  model: z.string().trim().min(1).max(160),
})

export const appSettingsSchema = z.object({
  taskModels: z.record(taskNameSchema, modelChoiceSchema),
  ollamaBaseUrl: z.string().url().max(500),
  anthropicApiKey: z.string().max(500).regex(/^[^\r\n]*$/, 'API key must not contain line breaks.').optional(),
  costCapUsd: z.number().nonnegative().max(100).default(1),
  modelPrices: z.record(z.string().min(1).max(160), z.object({ inputPerMillion: z.number().positive().max(1000), outputPerMillion: z.number().positive().max(1000) }).strict()).default({}),
})
export type AppSettings = z.infer<typeof appSettingsSchema>

export const publicSettingsSchema = z.object({
  taskModels: appSettingsSchema.shape.taskModels,
  ollamaBaseUrl: appSettingsSchema.shape.ollamaBaseUrl,
  anthropicApiKeyConfigured: z.boolean(),
  costCapUsd: appSettingsSchema.shape.costCapUsd,
  modelPrices: appSettingsSchema.shape.modelPrices,
})
export type PublicSettings = z.infer<typeof publicSettingsSchema>

export const runStatusSchema = z.enum(['queued', 'running', 'done', 'failed', 'cancelled'])
export type RunStatus = z.infer<typeof runStatusSchema>

export const runEventSchema = z.object({
  id: z.number().int().nonnegative(),
  runId: z.string(),
  status: runStatusSchema,
  step: z.string(),
  message: z.string().optional(),
  timestamp: z.string(),
})
export type RunEvent = z.infer<typeof runEventSchema>

export const queueDemoSchema = z.object({}).strict()

const short = (max = 300) => z.string().trim().max(max)
const identifier = z.string().uuid()
export const bulletSchema = z.object({ id: identifier, rev: z.number().int().positive(), text: short(4000), skills: z.array(short(100)).max(30), metrics: z.array(short(100)).max(30), verbs: z.array(short(100)).max(30), sourceRef: short(500), retired: z.boolean().optional() }).strict()
export const roleSchema = z.object({ id: identifier, company: short(), title: short(), start: short(100), end: short(100), bullets: z.array(bulletSchema).max(100) }).strict()
export const projectSchema = z.object({ id: identifier, name: short(), stack: z.array(short(100)).max(50), start: short(100).default(''), end: short(100).default(''), summary: short(2000), bullets: z.array(bulletSchema).max(100) }).strict()
export const skillSchema = z.object({ name: short(100), category: short(100), years: z.number().nonnegative().max(80).optional(), evidenceIds: z.array(identifier).max(100) }).strict()
export const summarySchema = z.object({ id: identifier, label: short(100), text: short(1200) }).strict()
export const educationSchema = z.object({ id: identifier, school: short(), credential: short(), field: short(), start: short(100), end: short(100), details: short(2000) }).strict()
export const masterSchema = z.object({ roles: z.array(roleSchema).max(100), projects: z.array(projectSchema).max(100), skills: z.array(skillSchema).max(300), education: z.array(educationSchema).max(100), summaries: z.array(summarySchema).max(10), meta: z.object({ sourceName: short(300), notes: short(5000) }).strict() }).strict()
export type Master = z.infer<typeof masterSchema>
export type Bullet = z.infer<typeof bulletSchema>
export const emptyMaster = (): Master => ({ roles: [], projects: [], skills: [], education: [], summaries: [], meta: { sourceName: '', notes: '' } })

export const profileSchema = z.object({ name: short(200), email: short(300), phone: short(100), location: short(300), links: z.array(short(500)).max(20), workAuthorization: short(1000), noticePeriod: short(300), salaryFloor: short(100), notes: short(5000) }).strict()
export type Profile = z.infer<typeof profileSchema>
export const emptyProfile = (): Profile => ({ name: '', email: '', phone: '', location: '', links: [], workAuthorization: '', noticePeriod: '', salaryFloor: '', notes: '' })

export const synonymSchema = z.object({ id: identifier, term: short(100).min(1), equivalence: short(100).min(1) }).strict()
export type Synonym = z.infer<typeof synonymSchema>
export const masterBundleSchema = z.object({ format: z.literal('the-role-clinic-master'), version: z.literal(1), exportedAt: z.string(), master: masterSchema, profile: profileSchema, synonyms: z.array(synonymSchema).max(1000) }).strict()

export const requirementSchema = z.object({
  id: identifier,
  quote: z.string().trim().min(3).max(2000),
  kind: z.enum(['knockout', 'hard', 'nice']),
  category: z.enum(['years', 'skill', 'location', 'work_authorization', 'clearance', 'education', 'other']),
  skill: short(100),
  years: z.number().nonnegative().max(80).nullable(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  assessment: z.enum(['met', 'gap', 'unknown']).default('unknown'),
  basis: short(1000).default(''),
}).strict()
export type Requirement = z.infer<typeof requirementSchema>
export const extractionSchema = z.object({ requirements: z.array(requirementSchema).max(100), seniority: short(100), vocabulary: z.array(short(100)).max(100), partial: z.boolean() }).strict()
export type Extraction = z.infer<typeof extractionSchema>
export const bulletScoreSchema = z.object({ bulletId: identifier, score: z.number().min(0).max(100), requirementIds: z.array(identifier).max(100), rationale: short(1000) }).strict()
export type BulletScore = z.infer<typeof bulletScoreSchema>
export const gapSchema = z.object({ requirementId: identifier, quote: short(2000), reason: short(1000), evidenceIds: z.array(identifier).max(20) }).strict()
export type Gap = z.infer<typeof gapSchema>
export const tailoredLineSchema = z.object({ outId: identifier, text: z.string().trim().min(1).max(4000), sourceIds: z.array(identifier).min(1).max(10), author: z.enum(['model', 'user']), verdict: z.enum(['grounded', 'stretch', 'unsupported']), layer1Flags: z.array(short(300)), layer2Reason: short(1000), slopFlags: z.array(short(300)) }).strict()
export type TailoredLine = z.infer<typeof tailoredLineSchema>
export const tailoredDocumentSchema = z.object({ jobId: identifier, runId: identifier, snapshotHash: z.string().length(64), summary: z.object({ variantId: identifier, text: short(1200), sourceIds: z.array(identifier), verdict: z.enum(['grounded', 'stretch', 'unsupported']), flags: z.array(short(300)) }).nullable(), skillsLine: z.array(short(100)), lines: z.array(tailoredLineSchema).max(30), scores: z.array(bulletScoreSchema), gaps: z.array(gapSchema), exportReady: z.boolean() }).strict()
export type TailoredDocument = z.infer<typeof tailoredDocumentSchema>

export const reviewLineSchema = tailoredLineSchema.extend({
  originalText: z.string(), rationale: z.string().default(''), sectionId: identifier,
  decision: z.enum(['pending', 'accepted', 'rejected']),
  verification: z.enum(['checked', 'pending', 'failed']),
})
export type ReviewLine = z.infer<typeof reviewLineSchema>
export const reviewSchema = z.object({
  jobId: identifier, runId: identifier, revision: z.number().int().positive(),
  snapshotHash: z.string().length(64), master: masterSchema,
  lines: z.array(reviewLineSchema).max(30),
  summaryId: identifier.nullable(), skills: z.array(short(100)).max(300),
})
export type Review = z.infer<typeof reviewSchema>
export interface ResumeBlock { id: string; kind: 'name' | 'contact' | 'heading' | 'section' | 'text' | 'bullet'; text: string }
export interface ParseCheck { ok: boolean; missing: string[] }
export interface ReviewWorkspace {
  review: Review; profile: Profile; summaryWarnings: string[]; blocks: ResumeBlock[]; exportReady: boolean; blockers: string[];
  replacements: Array<{ id: string; sectionId: string; label: string; text: string; rationale: string }>;
  sections: Array<{ id: string; label: string }>;
  verificationEstimate: { estimatedUsd: number; allowed: boolean; capUsd: number } | null;
  verificationError?: string;
}

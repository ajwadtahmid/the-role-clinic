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
})
export type AppSettings = z.infer<typeof appSettingsSchema>

export const publicSettingsSchema = z.object({
  taskModels: appSettingsSchema.shape.taskModels,
  ollamaBaseUrl: appSettingsSchema.shape.ollamaBaseUrl,
  anthropicApiKeyConfigured: z.boolean(),
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

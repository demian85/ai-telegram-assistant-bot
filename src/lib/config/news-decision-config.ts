import { z } from 'zod'

const schema = z.object({
  decisionModel: z.string().trim().min(1).optional(),
  decisionConfidenceThreshold: z.number().min(0).max(1).optional(),
})

const relevanceRoleSchema = z.object({
  systemPrompt: z.string(),
  model: z.string().optional(),
  supportsVision: z.boolean().optional(),
  supportsWebSearch: z.boolean().optional(),
})
export type NewsRelevanceRoleConfig = z.infer<typeof relevanceRoleSchema>

export function parseNewsDecisionConfig(value: unknown) {
  return schema.parse(value)
}

export function parseNewsRelevanceRoleConfig(value: unknown) {
  return relevanceRoleSchema.parse(value)
}

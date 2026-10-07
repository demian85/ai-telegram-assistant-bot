import { z } from 'zod'

const schema = z.object({
  decisionModel: z.string().trim().min(1).optional(),
  decisionConfidenceThreshold: z.number().min(0).max(1).optional(),
})

export function parseNewsDecisionConfig(value: unknown) {
  return schema.parse(value)
}

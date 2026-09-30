import { z } from 'zod'

export const preferenceDescriptionSchema = z.string().trim().min(1).max(3000)
const criterionSchema = z.object({
  rule: z.string().trim().min(3).max(300),
  sourceText: z.string().trim().min(1).max(3000),
})
export const generatedCriteriaSchema = z.object({
  interests: z.array(criterionSchema).min(1).max(20),
  exclusions: z.array(criterionSchema).max(20),
  titleRules: z.array(criterionSchema).max(10),
})
export type NewsCriteria = z.infer<typeof generatedCriteriaSchema>

export const legacyPreferenceSchema = z.object({
  mode: z.literal('custom'),
  description: preferenceDescriptionSchema,
  instruction: z.string(),
  revision: z.string().uuid(),
  generatedAt: z.string().datetime(),
  model: z.string(),
})
export const newsPreferenceSchema = legacyPreferenceSchema
  .extend({
    version: z.literal(2),
    criteria: generatedCriteriaSchema,
  })
  .superRefine((preference, ctx) => {
    for (const criterion of [
      ...preference.criteria.interests,
      ...preference.criteria.exclusions,
      ...preference.criteria.titleRules,
    ]) {
      if (!preference.description.includes(criterion.sourceText)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'Each criterion must cite exact text from the original description',
        })
      }
    }
    if (renderCriteria(preference.criteria).length > 3000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Compiled instruction exceeds 3000 characters',
      })
    }
  })
export type NewsPreference = z.infer<typeof newsPreferenceSchema>
export type LegacyNewsPreference = z.infer<typeof legacyPreferenceSchema>
export type NewsFilter = {
  readonly description: string
  readonly instruction: string
  readonly revision: string
  readonly preference?: NewsPreference | LegacyNewsPreference
  readonly source: 'custom' | 'default'
}

export function renderCriteria(criteria: NewsCriteria): string {
  return [
    'Include substantive coverage of at least one interest:',
    ...criteria.interests.map((item) => `- ${item.rule}`),
    ...(criteria.exclusions.length
      ? ['Exclude:', ...criteria.exclusions.map((item) => `- ${item.rule}`)]
      : []),
    ...(criteria.titleRules.length
      ? [
          'Title requirements:',
          ...criteria.titleRules.map((item) => `- ${item.rule}`),
        ]
      : []),
    'Original preferences are authoritative. Explicit exclusions override matches; reject uncertain matches.',
  ].join('\n')
}

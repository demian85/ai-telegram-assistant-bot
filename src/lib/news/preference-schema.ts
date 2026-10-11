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
    const criteria = [
      ...preference.criteria.interests,
      ...preference.criteria.exclusions,
      ...preference.criteria.titleRules,
    ]
    for (const criterion of criteria) {
      if (!preference.description.includes(criterion.sourceText)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'Each criterion must cite exact text from the original description',
        })
      }
    }
    const quotedTokens = new Set(
      criteria.flatMap((criterion) => criterion.sourceText.split(/\s+/u))
    )
    const tokens = preference.description.split(/\s+/u)
    if (
      tokens.some(
        (token) => !/^\p{P}+$/u.test(token) && !quotedTokens.has(token)
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Source quotes must cover complete original tokens, including keyword punctuation',
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
  const compact = (rules: NewsCriteria['interests'], prefix?: RegExp): string =>
    [
      ...new Set(
        rules.map((item) => {
          const rule = (
            prefix ? item.rule.replace(prefix, '') : item.rule
          ).trim()
          return ` ${rule} `.includes(` ${item.sourceText} `)
            ? rule
            : `${rule} (source: "${item.sourceText}")`
        })
      ),
    ].join('; ')
  return [
    `Include substantive coverage of any: ${compact(criteria.interests, /^Select articles substantively covering\s+/i)}`,
    ...(criteria.exclusions.length
      ? [`Exclude: ${compact(criteria.exclusions, /^Exclude\s+/i)}`]
      : []),
    ...(criteria.titleRules.length
      ? [`Title requirements: ${compact(criteria.titleRules)}`]
      : []),
  ].join('\n')
}

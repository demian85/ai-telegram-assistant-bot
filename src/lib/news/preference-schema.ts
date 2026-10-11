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
    const covered = new Array<boolean>(preference.description.length).fill(
      false
    )
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
      let start = preference.description.indexOf(criterion.sourceText)
      while (start !== -1) {
        covered.fill(true, start, start + criterion.sourceText.length)
        start = preference.description.indexOf(criterion.sourceText, start + 1)
      }
    }
    const uncovered = preference.description
      .split('')
      .map((character, index) => (covered[index] ? ' ' : character))
      .join('')
    if (/[\p{L}\p{N}]/u.test(uncovered)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Source quotes must cover all original preferences without omissions',
      })
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
  const compact = (rules: NewsCriteria['interests'], prefix?: RegExp): string =>
    [
      ...new Set(
        rules.map((item) => {
          const rule = (
            prefix ? item.rule.replace(prefix, '') : item.rule
          ).trim()
          return rule.includes(item.sourceText)
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

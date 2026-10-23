import { z } from 'zod'

export const chatPromptVariables = ['chatType'] as const
export const summarizerPromptVariables = [
  'level',
  'period',
  'startTime',
  'endTime',
  'messageCount',
] as const

const placeholderPattern = /\{\{([\s\S]*?)\}\}/g

export function promptTemplateSchema(allowedVariables: readonly string[]) {
  return z
    .string()
    .trim()
    .min(1)
    .superRefine((template, context) => {
      const remaining = template.replace(
        placeholderPattern,
        (_token, name: string) => {
          if (!allowedVariables.includes(name.trim())) {
            context.addIssue({
              code: 'custom',
              message: `Unknown prompt variable: ${name.trim()}. Supported: ${allowedVariables.join(', ')}`,
            })
          }
          return ''
        }
      )
      if (remaining.includes('{{') || remaining.includes('}}')) {
        context.addIssue({
          code: 'custom',
          message: 'Malformed prompt variable; use {{name}}',
        })
      }
    })
}

export function renderPromptTemplate(
  template: string,
  variables: Readonly<Record<string, string>>
): string {
  return template.replace(placeholderPattern, (_token, name: string) =>
    z.string().parse(variables[name.trim()])
  )
}

import { z } from 'zod'
import type { AIMessage } from '@langchain/core/messages'
import type { CallbackHandlerMethods } from '@langchain/core/callbacks/base'
import logger from '../logger.js'
import { extractTextContent } from '../agent/content.js'

const citationSchema = z.object({
  url: z
    .url()
    .refine((value) => ['https:', 'http:'].includes(new URL(value).protocol)),
  title: z.string().optional(),
  content: z.string().optional(),
})
const rawSchema = z.object({
  venice_parameters: z
    .object({ web_search_citations: z.array(z.unknown()).optional() })
    .optional(),
  choices: z
    .array(
      z.object({
        message: z.object({ annotations: z.array(z.unknown()).optional() }),
      })
    )
    .optional(),
})

export function responseSources(
  message: Pick<AIMessage, 'additional_kwargs'>
): readonly z.infer<typeof citationSchema>[] {
  const raw = rawSchema.safeParse(message.additional_kwargs?.__raw_response)
  if (!raw.success) return []
  const candidates = [
    ...(raw.data.venice_parameters?.web_search_citations ?? []),
    ...(raw.data.choices?.flatMap(
      (choice) => choice.message.annotations ?? []
    ) ?? []),
  ]
  return candidates.flatMap((candidate) => {
    const annotation = z
      .object({ url_citation: z.unknown() })
      .safeParse(candidate)
    const parsed = citationSchema.safeParse(
      annotation.success ? annotation.data.url_citation : candidate
    )
    return parsed.success ? [parsed.data] : []
  })
}

export function citedResponse(
  message: Pick<AIMessage, 'content' | 'additional_kwargs'>,
  options: { readonly includeSourceList?: boolean } = {}
): string {
  const text = extractTextContent(message.content)
  if (options.includeSourceList === false) return text
  const urls = new Set<string>()
  const sources: string[] = []
  for (const source of responseSources(message)) {
    const url = source.url.replace(/[<>]/g, encodeURIComponent)
    if (urls.has(source.url)) continue
    urls.add(source.url)
    const label = (source.title ?? `Source ${sources.length + 1}`).replace(
      /[[\]\\\r\n]/g,
      ' '
    )
    sources.push(`[${label}](<${url}>)`)
  }
  return sources.length
    ? `${text}\n\nSources:\n${sources.map((source) => `- ${source}`).join('\n')}`
    : text
}

export const modelTelemetry: CallbackHandlerMethods = {
  handleLLMEnd(output) {
    for (const generation of output.generations.flat()) {
      if ('message' in generation) {
        const message = generation.message
        if (
          typeof message === 'object' &&
          message !== null &&
          'usage_metadata' in message
        ) {
          logger.info(
            { event: 'llm.usage', usage: message.usage_metadata },
            'Model token and cache usage'
          )
        }
      }
    }
  },
}

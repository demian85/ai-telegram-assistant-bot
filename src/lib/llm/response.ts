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

export function citedResponse(
  message: Pick<AIMessage, 'content' | 'additional_kwargs'>
): string {
  const text = extractTextContent(message.content)
  const raw = rawSchema.safeParse(message.additional_kwargs?.__raw_response)
  if (!raw.success) return text
  const candidates = [
    ...(raw.data.venice_parameters?.web_search_citations ?? []),
    ...(raw.data.choices?.flatMap(
      (choice) => choice.message.annotations ?? []
    ) ?? []),
  ]
  const urls = new Set<string>()
  const references = new Map<string, string>()
  const sources: string[] = []
  for (const [index, candidate] of candidates.entries()) {
    const annotation = z
      .object({ url_citation: z.unknown() })
      .safeParse(candidate)
    const parsed = citationSchema.safeParse(
      annotation.success ? annotation.data.url_citation : candidate
    )
    if (!parsed.success) continue
    const url = parsed.data.url.replace(/[<>]/g, encodeURIComponent)
    references.set(String(index + 1), url)
    if (urls.has(parsed.data.url)) continue
    urls.add(parsed.data.url)
    const label = (parsed.data.title ?? `Source ${sources.length + 1}`).replace(
      /[[\]\\\r\n]/g,
      ' '
    )
    sources.push(`[${label}](<${url}>)`)
  }
  const linked = text.replace(/\^(\d+)\^/g, (marker, index: string) => {
    const url = references.get(index)
    return url ? `[${index}](<${url}>)` : marker
  })
  return sources.length
    ? `${linked}\n\nSources:\n${sources.map((source) => `- ${source}`).join('\n')}`
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

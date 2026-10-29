import { z } from 'zod'
import type { AIMessage } from '@langchain/core/messages'
import type { CallbackHandlerMethods } from '@langchain/core/callbacks/base'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { visitParents } from 'unist-util-visit-parents'
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
): readonly (z.infer<typeof citationSchema> & { readonly number: number })[] {
  const raw = rawSchema.safeParse(message.additional_kwargs?.__raw_response)
  if (!raw.success) return []
  const candidates = [
    ...(raw.data.venice_parameters?.web_search_citations ?? []),
    ...(raw.data.choices?.flatMap(
      (choice) => choice.message.annotations ?? []
    ) ?? []),
  ]
  return candidates.flatMap((candidate, index) => {
    const annotation = z
      .object({ url_citation: z.unknown() })
      .safeParse(candidate)
    const parsed = citationSchema.safeParse(
      annotation.success ? annotation.data.url_citation : candidate
    )
    return parsed.success ? [{ ...parsed.data, number: index + 1 }] : []
  })
}

export function citedResponse(
  message: Pick<AIMessage, 'content' | 'additional_kwargs'>,
  options: { readonly includeSourceList?: boolean } = {}
): string {
  const text = extractTextContent(message.content)
  const references = new Map<string, string>()
  const urls = new Set<string>()
  const sources: string[] = []
  for (const source of responseSources(message)) {
    const url = source.url.replace(/[<>]/g, encodeURIComponent)
    references.set(String(source.number), url)
    if (urls.has(source.url)) continue
    urls.add(source.url)
    const label = (source.title ?? `Source ${source.number}`).replace(
      /[[\]\\\r\n]/g,
      ' '
    )
    sources.push(`[${label}](<${url}>)`)
  }
  const parts: string[] = []
  let offset = 0
  const protectedParents = new Set(['link', 'linkReference'])
  if (references.size && text.includes('^')) {
    visitParents(fromMarkdown(text), 'text', (node, parents) => {
      if (parents.some((parent) => protectedParents.has(parent.type))) return
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (start === undefined || end === undefined) return
      parts.push(
        text.slice(offset, start),
        text
          .slice(start, end)
          .replace(
            /\\[\s\S]|\^(\d+(?:[\t ]*,[\t ]*\d+)*)\^/g,
            (match, indices: string | undefined) => {
              if (!indices) return match
              const numbers = indices.split(',').map((index) => index.trim())
              if (numbers.every((index) => !references.has(index))) return match
              return numbers
                .map((index) => {
                  const url = references.get(index)
                  return url ? `[${index}](<${url}>)` : `^${index}^`
                })
                .join(', ')
            }
          )
      )
      offset = end
    })
  }
  const linked = parts.join('') + text.slice(offset)
  return options.includeSourceList !== false && sources.length
    ? `${linked}\n\nSources:\n${sources.map((source) => `- ${source}`).join('\n')}`
    : linked
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

import { setTimeout } from 'node:timers/promises'
import { FormattedString } from '@grammyjs/parse-mode'
import { parse_html, parse_markdown } from '@telegraf/entity'
import { TelegramError } from 'telegraf'
import { GrammyError } from 'grammy'
import logger from '@lib/logger.js'

type SendOptions = Record<string, unknown> & {
  readonly entities?: ConstructorParameters<typeof FormattedString>[1]
}

const MAX_MESSAGE_LENGTH = 4096
const sentenceSegments = new Intl.Segmenter(undefined, {
  granularity: 'sentence',
})
const wordSegments = new Intl.Segmenter(undefined, { granularity: 'word' })
const graphemeSegments = new Intl.Segmenter(undefined, {
  granularity: 'grapheme',
})

function nextBoundary(text: string, limit = MAX_MESSAGE_LENGTH): number {
  if (text.length <= limit) return text.length

  const window = text.slice(0, limit + 2)
  for (const separator of ['\n\n', '\n']) {
    const end = window.lastIndexOf(separator, limit - separator.length)
    if (end >= limit / 2) return end + separator.length
  }
  for (const segmenter of [sentenceSegments, wordSegments, graphemeSegments]) {
    let boundary = 0
    for (const { index, segment } of segmenter.segment(window)) {
      const end = index + segment.length
      if (end > limit) break
      boundary = end
    }
    if (boundary >= limit / 2) return boundary
  }
  const last = text.charCodeAt(limit - 1)
  return last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit
}

export function* splitTelegramText(
  text: string,
  limit = MAX_MESSAGE_LENGTH
): Generator<string> {
  let offset = 0
  while (offset < text.length) {
    const end = offset + nextBoundary(text.slice(offset), limit)
    yield text.slice(offset, end)
    offset = end
  }
}

export async function sendWithRetry<T>(send: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await send()
    } catch (error) {
      const code =
        error instanceof TelegramError
          ? error.code
          : error instanceof GrammyError
            ? error.error_code
            : undefined
      const retryAfter =
        error instanceof TelegramError || error instanceof GrammyError
          ? error.parameters?.retry_after
          : undefined
      if (code !== 429 || !retryAfter || attempt >= 3) {
        throw error
      }
      await setTimeout(retryAfter * 1000)
    }
  }
}

export async function sendTelegramMessage<T>(
  send: (text: string, extra?: Record<string, unknown>) => Promise<T>,
  text: string,
  extra?: SendOptions
): Promise<T> {
  if (text.length <= MAX_MESSAGE_LENGTH) {
    return sendWithRetry(() => send(text, extra))
  }

  const { parse_mode, entities: suppliedEntities, ...options } = extra ?? {}
  if (parse_mode === 'MarkdownV2' && !suppliedEntities) {
    throw new RangeError(
      'Oversized raw MarkdownV2 requires entities; use native rich Markdown for agent replies'
    )
  }
  let parsed: ReturnType<typeof parse_html> | FormattedString
  try {
    parsed = suppliedEntities
      ? new FormattedString(text, suppliedEntities)
      : parse_mode === 'HTML'
        ? parse_html(text)
        : parse_mode === 'Markdown'
          ? parse_markdown(text)
          : { text, entities: [] }
  } catch (error) {
    if (!(error instanceof Error)) throw error
    logger.warn(
      {
        event: 'telegram.message.format_fallback',
        err: error,
        parseMode: parse_mode,
      },
      'Sending long message as plain text because formatting could not be parsed'
    )
    parsed = { text, entities: [] }
  }
  const entities =
    parsed instanceof FormattedString
      ? undefined
      : parsed.entities?.map((entity) => {
          const { type, offset, length } = entity
          switch (type) {
            case 'text_link':
              return { type, offset, length, url: entity.url ?? '' }
            case 'text_mention':
              return {
                type: 'text_link' as const,
                offset,
                length,
                url: `tg://user?id=${entity.user}`,
              }
            case 'custom_emoji':
              return {
                type,
                offset,
                length,
                custom_emoji_id: entity.custom_emoji_id ?? '',
              }
            default:
              return { type, offset, length, language: entity.language }
          }
        })
  const formatted =
    parsed instanceof FormattedString
      ? parsed
      : new FormattedString(parsed.text, entities)
  let offset = 0
  const sendNext = async (): Promise<T> => {
    const end = offset + nextBoundary(formatted.text.slice(offset))
    const part = formatted.slice(offset, end)
    const result = await sendWithRetry(() =>
      send(part.text, { ...options, entities: part.entities })
    )
    offset = end
    return result
  }
  let result = await sendNext()
  while (offset < formatted.text.length) result = await sendNext()
  return result
}

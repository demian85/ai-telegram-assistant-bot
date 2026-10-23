import { setTimeout } from 'node:timers/promises'
import { FormattedString } from '@grammyjs/parse-mode'
import { parse_html, parse_markdown } from '@telegraf/entity'
import { TelegramError } from 'telegraf'
import logger from '@lib/logger.js'

const MAX_MESSAGE_LENGTH = 4096
const sentenceSegments = new Intl.Segmenter(undefined, {
  granularity: 'sentence',
})
const wordSegments = new Intl.Segmenter(undefined, { granularity: 'word' })
const graphemeSegments = new Intl.Segmenter(undefined, {
  granularity: 'grapheme',
})

function nextBoundary(text: string): number {
  if (text.length <= MAX_MESSAGE_LENGTH) return text.length

  const window = text.slice(0, MAX_MESSAGE_LENGTH + 2)
  for (const separator of ['\n\n', '\n']) {
    const end = window.lastIndexOf(
      separator,
      MAX_MESSAGE_LENGTH - separator.length
    )
    if (end >= MAX_MESSAGE_LENGTH / 2) return end + separator.length
  }
  for (const segmenter of [sentenceSegments, wordSegments, graphemeSegments]) {
    let boundary = 0
    for (const { index, segment } of segmenter.segment(window)) {
      const end = index + segment.length
      if (end > MAX_MESSAGE_LENGTH) break
      boundary = end
    }
    if (boundary >= MAX_MESSAGE_LENGTH / 2) return boundary
  }
  const last = text.charCodeAt(MAX_MESSAGE_LENGTH - 1)
  return last >= 0xd800 && last <= 0xdbff
    ? MAX_MESSAGE_LENGTH - 1
    : MAX_MESSAGE_LENGTH
}

async function sendWithRetry<T>(send: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await send()
    } catch (error) {
      if (
        !(error instanceof TelegramError) ||
        error.code !== 429 ||
        !error.parameters?.retry_after ||
        attempt >= 3
      ) {
        throw error
      }
      await setTimeout(error.parameters.retry_after * 1000)
    }
  }
}

export async function sendTelegramMessage<T>(
  send: (text: string, extra?: Record<string, unknown>) => Promise<T>,
  text: string,
  extra?: Record<string, unknown>
): Promise<T> {
  if (text.length <= MAX_MESSAGE_LENGTH) {
    return sendWithRetry(() => send(text, extra))
  }

  const { parse_mode, ...options } = extra ?? {}
  let parsed: ReturnType<typeof parse_html>
  try {
    parsed =
      parse_mode === 'HTML'
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
  const entities = parsed.entities?.map((entity) => {
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
  const formatted = new FormattedString(parsed.text, entities)
  let offset = 0
  const sendNext = async (): Promise<T> => {
    const end = offset + nextBoundary(parsed.text.slice(offset))
    const part = formatted.slice(offset, end)
    const result = await sendWithRetry(() =>
      send(part.text, { ...options, entities: part.entities })
    )
    offset = end
    return result
  }
  let result = await sendNext()
  while (offset < parsed.text.length) result = await sendNext()
  return result
}

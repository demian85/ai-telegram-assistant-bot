import { GrammyError, type Api } from 'grammy'
import logger from '@lib/logger.js'
import { sendWithRetry, splitTelegramText } from './send-message.js'

export type RichMessageContent = Parameters<Api['sendRichMessage']>[1]
export type RichMessageClient = {
  readonly sendRichMessage: (
    ...args: Parameters<Api['sendRichMessage']>
  ) => Promise<unknown>
}

const RICH_MESSAGE_LIMIT = 32768

function* markdownSections(text: string): Generator<string> {
  let section = ''
  let fence: { readonly marker: string; readonly width: number } | undefined
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    section += line
    const match = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/.exec(line)
    if (match) {
      const delimiter = match[1]
      if (!fence) {
        fence = { marker: delimiter[0], width: delimiter.length }
      } else if (
        delimiter[0] === fence.marker &&
        delimiter.length >= fence.width &&
        !match[2].trim()
      ) {
        fence = undefined
      }
    }
    if (!fence && /^[\t ]*\r?\n$/.test(line)) {
      yield section
      section = ''
    }
  }
  if (section) yield section
}

export async function sendRichMarkdown(
  send: (content: RichMessageContent) => Promise<unknown>,
  markdown: string
): Promise<void> {
  if (!markdown.trim()) throw new Error('Cannot send a blank rich message')

  const sendLiteral = async (text: string): Promise<void> => {
    for (const part of splitTelegramText(text, RICH_MESSAGE_LIMIT)) {
      if (part.trim())
        await sendWithRetry(() =>
          send({
            blocks: [{ type: 'paragraph', text: part }],
            skip_entity_detection: true,
          })
        )
    }
  }
  const sendMarkdown = async (text: string): Promise<void> => {
    if (!text.trim()) return
    try {
      await sendWithRetry(() => send({ markdown: text }))
    } catch (error) {
      if (
        !(error instanceof GrammyError) ||
        error.error_code !== 400 ||
        !/can't parse|\b(?:entities|blocks?|tables?|columns?|formatting|nesting)\b|too long/i.test(
          error.description
        )
      )
        throw error
      logger.warn(
        { event: 'telegram.rich.format_fallback', errorCode: error.error_code },
        'Sending rich Markdown as literal text after a formatting rejection'
      )
      await sendLiteral(text)
    }
  }

  if (markdown.length <= RICH_MESSAGE_LIMIT) {
    await sendMarkdown(markdown)
    return
  }
  let pending = ''
  for (const section of markdownSections(markdown)) {
    if (pending.length + section.length > RICH_MESSAGE_LIMIT) {
      await sendMarkdown(pending)
      pending = ''
    }
    if (section.length > RICH_MESSAGE_LIMIT) {
      logger.warn(
        { event: 'telegram.rich.oversized_block', length: section.length },
        'Sending oversized Markdown block as literal text to preserve its content'
      )
      await sendLiteral(section)
    } else {
      pending += section
    }
  }
  await sendMarkdown(pending)
}

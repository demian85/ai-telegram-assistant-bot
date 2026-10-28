import type { MessageContent } from '@langchain/core/messages'

export interface AgentLiveInvocationInput {
  text?: string
  imageUrl?: string
  readonly replyContext?: {
    readonly author: string
    readonly text: string
  }
}

interface TextContentPart {
  type: 'text'
  text: string
}

function isTextContentPart(part: unknown): part is TextContentPart {
  return (
    typeof part === 'object' &&
    part !== null &&
    'type' in part &&
    part.type === 'text' &&
    'text' in part &&
    typeof part.text === 'string'
  )
}

function buildUserText(input: AgentLiveInvocationInput): string {
  const normalizedText = input.text?.trim() ?? ''
  return input.replyContext
    ? `Replied-to message (quoted context):\n${JSON.stringify(input.replyContext)}\n\n${normalizedText}`.trim()
    : normalizedText
}

export function buildPersistedTextShadow(
  input: AgentLiveInvocationInput
): string {
  const normalizedText = buildUserText(input)

  if (!input.imageUrl) {
    return normalizedText
  }

  return normalizedText
    ? `[image attached]\nCaption: ${normalizedText}`
    : '[image attached]'
}

export function buildLiveUserContent(
  input: AgentLiveInvocationInput,
  supportsVision: boolean
): MessageContent {
  const persistedShadow = buildPersistedTextShadow(input)

  if (!input.imageUrl || !supportsVision) {
    return persistedShadow
  }

  const content: MessageContent = []

  const text = buildUserText(input)
  if (text) {
    content.push({
      type: 'text',
      text,
    })
  }

  content.push({
    type: 'image_url',
    image_url: {
      url: input.imageUrl,
    },
  })

  return content
}

export function extractTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return JSON.stringify(content) ?? ''
  }

  const parts: readonly unknown[] = content
  const textParts = parts
    .flatMap((part): string[] => {
      if (typeof part === 'string') {
        return [part]
      }

      if (isTextContentPart(part)) {
        return [part.text]
      }

      return []
    })
    .map((part) => part.trim())
    .filter(Boolean)

  return textParts.length > 0 ? textParts.join('\n') : JSON.stringify(content)
}

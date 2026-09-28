const PLACEHOLDER_PREFIX = '§PLH§'
const PLACEHOLDER_SUFFIX = '§END§'

export function escapeMarkdown(text: string): string {
  if (!text) return ''

  const placeholders: string[] = []
  let counter = 0

  const save = (match: string): string => {
    const id = counter++
    placeholders[id] = match
    return `${PLACEHOLDER_PREFIX}${id}${PLACEHOLDER_SUFFIX}`
  }

  const restore = (_match: string, id: string): string => {
    return placeholders[parseInt(id, 10)] || ''
  }

  // Step 1: Protect intentional Telegram formatting patterns
  let result = text
    .replace(/`[^`]+`/g, save)
    .replace(/\*[^*]+\*/g, save)
    .replace(/_[^_]+_/g, save)

  // Step 2: Escape remaining markdown characters
  result = result
    .replace(/\\/g, '\\\\')
    .replace(/\*/g, '\\*')
    .replace(/`/g, '\\`')
    .replace(/_/g, '\\_')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')

  // Step 3: Restore protected patterns
  const restoreRegex = new RegExp(
    `${PLACEHOLDER_PREFIX}([0-9]+)${PLACEHOLDER_SUFFIX}`,
    'g'
  )
  result = result.replace(restoreRegex, restore)

  return result
}

export function fullMarkdown2TgMarkdown(input: string): string {
  if (!input) return ''

  return (
    input
      // Convert standard markdown bold **text** to Telegram *text*
      .replace(/\*\*([^*]+)\*\*/g, '*$1*')
      // Convert headers (# text) to bold (*text*)
      .replace(/^#+ *(.+)$/gm, '*$1*')
      // Convert horizontal rules to visual separator
      .replace(/^---+$/gm, '───────────────')
      // Clean up excessive newlines
      .replace(/\n{4,}/g, '\n\n\n')
  )
}

export function formatTelegramMarkdownReply(input: string): string {
  if (!input) return ''

  // First convert standard markdown to Telegram format
  const converted = fullMarkdown2TgMarkdown(input)

  // Then escape any problematic characters while preserving intentional formatting
  return escapeMarkdown(converted).trim()
}

export function createMarkdownLink(text: string, url: string): string {
  if (!url) return escapeMarkdown(text)
  const safeUrl = url.replace(/\)/g, '%29')
  return `[${escapeMarkdown(text)}](${safeUrl})`
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function createHtmlLink(text: string, url: string): string {
  if (!url) return escapeHtml(text)
  return `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`
}

export interface NewsArticle {
  title: string
  url: string
  source: string
  publishedAt: Date
  relevanceScore?: number
  description?: string
}

export interface FormatNewsOptions {
  mode: 'markdown' | 'html' | 'plain'
  includeDescription?: boolean
  descriptionMaxLength?: number
  includeRelevance?: boolean
  includeDate?: boolean
  addSpacing?: boolean
}

export function formatNewsArticle(
  article: NewsArticle,
  options: FormatNewsOptions
): string {
  const {
    mode,
    includeDescription = true,
    descriptionMaxLength = 200,
    includeRelevance = true,
    includeDate = true,
    addSpacing = false,
  } = options

  const isMarkdown = mode === 'markdown'
  const isHtml = mode === 'html'
  const isFormatted = isMarkdown || isHtml
  const escapeFormatted = isHtml ? escapeHtml : escapeMarkdown
  const lines: string[] = []

  if (isFormatted) {
    lines.push(
      isHtml
        ? `<b>${escapeHtml(article.title)}</b>`
        : `*${escapeMarkdown(article.title)}*`
    )
  } else {
    lines.push(article.title)
  }

  const parts: string[] = []
  if (isFormatted) {
    parts.push(`📰 Source: ${escapeFormatted(article.source)}`)
    if (includeDate) {
      const publishedStr = article.publishedAt.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      })
      parts.push(`📅 ${publishedStr}`)
    }
    lines.push(parts.join(' | '))
  } else {
    parts.push(`Source: ${article.source}`)
    if (includeDate) {
      const publishedStr = article.publishedAt.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      })
      parts.push(publishedStr)
    }
    if (parts.length > 0) {
      lines.push(parts.join(' | '))
    }
  }

  if (includeDescription && article.description) {
    let desc = article.description
    if (descriptionMaxLength > 0 && desc.length > descriptionMaxLength) {
      desc = desc.slice(0, descriptionMaxLength) + '...'
    }
    lines.push(isFormatted ? escapeFormatted(desc) : desc)
  }

  if (isFormatted) {
    const link = isHtml
      ? createHtmlLink('Read full article', article.url)
      : createMarkdownLink('Read full article', article.url)
    lines.push(`🔗 ${link}`)
  } else {
    lines.push(`URL: ${article.url}`)
  }

  if (includeRelevance && article.relevanceScore !== undefined) {
    if (isFormatted) {
      lines.push(`⭐ Relevance: ${article.relevanceScore}/100`)
    } else {
      lines.push(`Relevance Score: ${article.relevanceScore}/100`)
    }
  }

  if (addSpacing) {
    lines.push('')
  }

  return lines.join('\n')
}

export function formatNewsArticles(
  articles: NewsArticle[],
  options: FormatNewsOptions & { numbered?: boolean } = { mode: 'plain' }
): string {
  const { numbered = true, ...formatOptions } = options

  return articles
    .map((article, index) => {
      const formatted = formatNewsArticle(article, formatOptions)
      if (numbered) {
        return `${index + 1}. ${formatted}`
      }
      return formatted
    })
    .join('\n\n')
}

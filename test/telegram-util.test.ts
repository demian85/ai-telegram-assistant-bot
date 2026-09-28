import { test, expect, describe } from 'vitest'
import {
  escapeMarkdown,
  fullMarkdown2TgMarkdown,
  formatTelegramMarkdownReply,
  createMarkdownLink,
  formatNewsArticle,
  formatNewsArticles,
  type NewsArticle,
} from '../src/lib/telegram/util.js'

describe('escapeMarkdown', () => {
  test('returns empty string for empty input', () => {
    expect(escapeMarkdown('')).toBe('')
    expect(escapeMarkdown(null as unknown as string)).toBe('')
  })

  test('escapes unformatted markdown special characters', () => {
    expect(escapeMarkdown('Hello world')).toBe('Hello world')
    expect(escapeMarkdown('Text with spaces')).toBe('Text with spaces')
    expect(escapeMarkdown('[link text]')).toBe('\\[link text\\]')
    expect(escapeMarkdown('Back\\slash')).toBe('Back\\\\slash')
  })

  test('preserves intentional inline code formatting', () => {
    const input = 'Use `console.log()` to debug'
    const result = escapeMarkdown(input)
    expect(result).toBe('Use `console.log()` to debug')
  })

  test('preserves intentional bold formatting', () => {
    const input = 'This is *bold* text'
    const result = escapeMarkdown(input)
    expect(result).toBe('This is *bold* text')
  })

  test('preserves intentional italic formatting', () => {
    const input = 'This is _italic_ text'
    const result = escapeMarkdown(input)
    expect(result).toBe('This is _italic_ text')
  })

  test('handles mixed content correctly', () => {
    const input = 'Use `code` and *bold* but escape [brackets]'
    const result = escapeMarkdown(input)
    expect(result).toBe('Use `code` and *bold* but escape \\[brackets\\]')
  })

  test('handles multiple code blocks', () => {
    const input = '`first` and `second` code blocks'
    const result = escapeMarkdown(input)
    expect(result).toBe('`first` and `second` code blocks')
  })
})

describe('fullMarkdown2TgMarkdown', () => {
  test('returns empty string for empty input', () => {
    expect(fullMarkdown2TgMarkdown('')).toBe('')
  })

  test('converts **bold** to *bold*', () => {
    expect(fullMarkdown2TgMarkdown('**bold text**')).toBe('*bold text*')
    expect(fullMarkdown2TgMarkdown('**multiple** **bold** **words**')).toBe(
      '*multiple* *bold* *words*'
    )
  })

  test('converts headers to bold', () => {
    expect(fullMarkdown2TgMarkdown('# Header 1')).toBe('*Header 1*')
    expect(fullMarkdown2TgMarkdown('## Header 2')).toBe('*Header 2*')
    expect(fullMarkdown2TgMarkdown('### Header 3')).toBe('*Header 3*')
  })

  test('converts horizontal rules to visual separator', () => {
    expect(fullMarkdown2TgMarkdown('---')).toBe('───────────────')
    expect(fullMarkdown2TgMarkdown('Some text\n---\nMore text')).toBe(
      'Some text\n───────────────\nMore text'
    )
  })

  test('cleans up excessive newlines', () => {
    const input = 'Line 1\n\n\n\n\nLine 2'
    const result = fullMarkdown2TgMarkdown(input)
    expect(result).toBe('Line 1\n\n\nLine 2')
  })

  test('preserves up to 3 consecutive newlines', () => {
    const input = 'Line 1\n\n\nLine 2'
    expect(fullMarkdown2TgMarkdown(input)).toBe(input)
  })

  test('handles complex markdown conversion', () => {
    const input = `# Title

**Bold statement**

Some regular text.

---

More content.`
    const result = fullMarkdown2TgMarkdown(input)
    expect(result).toContain('*Title*')
    expect(result).toContain('*Bold statement*')
    expect(result).toContain('───────────────')
  })
})

describe('formatTelegramMarkdownReply', () => {
  test('combines markdown conversion and escaping', () => {
    const input = '**Hello** [world]'
    const result = formatTelegramMarkdownReply(input)
    expect(result).toBe('*Hello* \\[world\\]')
  })

  test('handles real-world LLM responses', () => {
    const input = `Here's what I found:

**Key Points:**
- Point 1
- Point 2

Use \`function()\` to call it.`
    const result = formatTelegramMarkdownReply(input)
    expect(result).toContain('*Key Points:*')
    expect(result).toContain('`function()`')
  })

  test('trims whitespace from result', () => {
    expect(formatTelegramMarkdownReply('  hello world  ')).toBe('hello world')
  })
})

describe('createMarkdownLink', () => {
  test('creates properly formatted link', () => {
    expect(createMarkdownLink('Click here', 'https://example.com')).toBe(
      '[Click here](https://example.com)'
    )
  })

  test('escapes text in link', () => {
    expect(createMarkdownLink('Click here', 'https://example.com')).toBe(
      '[Click here](https://example.com)'
    )
  })

  test('escapes closing parentheses in URL', () => {
    expect(
      createMarkdownLink(
        'Wiki',
        'https://en.wikipedia.org/wiki/Test_(disambiguation)'
      )
    ).toBe('[Wiki](https://en.wikipedia.org/wiki/Test_(disambiguation%29)')
  })

  test('returns escaped text only when URL is empty', () => {
    expect(createMarkdownLink('Text only', '')).toBe('Text only')
  })
})

describe('formatNewsArticle', () => {
  const baseArticle: NewsArticle = {
    title: 'Test Article',
    url: 'https://example.com/article',
    source: 'Test Source',
    publishedAt: new Date('2024-03-15T10:30:00Z'),
    relevanceScore: 85,
    description: 'This is a test description for the article.',
  }

  test('formats article in markdown mode with all options', () => {
    const result = formatNewsArticle(baseArticle, {
      mode: 'markdown',
      includeDescription: true,
      includeRelevance: true,
      includeDate: true,
    })

    expect(result).toContain('*Test Article*')
    expect(result).toContain('📰 Source: Test Source')
    expect(result).toContain('📅')
    expect(result).toContain('This is a test description')
    expect(result).toContain('[Read full article]')
    expect(result).toContain('⭐ Relevance: 85/100')
  })

  test('formats article in plain mode', () => {
    const result = formatNewsArticle(baseArticle, {
      mode: 'plain',
      includeDescription: true,
      includeRelevance: true,
      includeDate: true,
    })

    expect(result).toContain('Test Article')
    expect(result).not.toContain('*Test Article*')
    expect(result).toContain('Source: Test Source')
    expect(result).toContain('URL: https://example.com/article')
    expect(result).toContain('Relevance Score: 85/100')
  })

  test('respects description max length', () => {
    const longDescription = 'a'.repeat(300)
    const article = { ...baseArticle, description: longDescription }

    const result = formatNewsArticle(article, {
      mode: 'markdown',
      descriptionMaxLength: 50,
    })

    expect(result).toContain('a'.repeat(50) + '...')
    expect(result).not.toContain('a'.repeat(51))
  })

  test('skips description when disabled', () => {
    const result = formatNewsArticle(baseArticle, {
      mode: 'markdown',
      includeDescription: false,
    })

    expect(result).not.toContain('This is a test description')
  })

  test('skips relevance when disabled', () => {
    const result = formatNewsArticle(baseArticle, {
      mode: 'markdown',
      includeRelevance: false,
    })

    expect(result).not.toContain('Relevance')
  })

  test('skips date when disabled', () => {
    const result = formatNewsArticle(baseArticle, {
      mode: 'markdown',
      includeDate: false,
    })

    expect(result).not.toContain('📅')
  })

  test('handles article without description', () => {
    const article = { ...baseArticle, description: undefined }
    const result = formatNewsArticle(article, { mode: 'markdown' })

    expect(result).not.toContain('undefined')
    expect(result).toContain('*Test Article*')
  })

  test('handles article without relevance score', () => {
    const article = { ...baseArticle, relevanceScore: undefined }
    const result = formatNewsArticle(article, {
      mode: 'markdown',
      includeRelevance: true,
    })

    expect(result).not.toContain('Relevance')
  })

  test('adds spacing when requested', () => {
    const result = formatNewsArticle(baseArticle, {
      mode: 'markdown',
      addSpacing: true,
    })

    expect(result.endsWith('\n')).toBe(true)
  })

  test('preserves intentional formatting in title', () => {
    const article = { ...baseArticle, title: 'Title *with* markdown' }
    const result = formatNewsArticle(article, { mode: 'markdown' })

    expect(result).toContain('*Title *with* markdown*')
  })

  test('formats RSS markup as literal text in Telegram HTML', () => {
    const article = {
      ...baseArticle,
      title: '**News & <analysis>**',
      source: 'R&D <Lab>',
      description: 'Quotes "matter" & tags <too>',
      url: 'https://example.com/article?source=a&edition="b"',
    }

    const result = formatNewsArticle(article, { mode: 'html' })

    expect(result).toContain('<b>**News &amp; &lt;analysis&gt;**</b>')
    expect(result).toContain('📰 Source: R&amp;D &lt;Lab&gt;')
    expect(result).toContain('Quotes &quot;matter&quot; &amp; tags &lt;too&gt;')
    expect(result).toContain(
      '<a href="https://example.com/article?source=a&amp;edition=&quot;b&quot;">Read full article</a>'
    )
  })
})

describe('formatNewsArticles', () => {
  const articles: NewsArticle[] = [
    {
      title: 'First Article',
      url: 'https://example.com/1',
      source: 'Source A',
      publishedAt: new Date('2024-03-15'),
    },
    {
      title: 'Second Article',
      url: 'https://example.com/2',
      source: 'Source B',
      publishedAt: new Date('2024-03-16'),
    },
  ]

  test('formats multiple articles with numbering by default', () => {
    const result = formatNewsArticles(articles, { mode: 'markdown' })

    expect(result).toContain('1. ')
    expect(result).toContain('2. ')
    expect(result).toContain('First Article')
    expect(result).toContain('Second Article')
  })

  test('formats without numbering when disabled', () => {
    const result = formatNewsArticles(articles, {
      mode: 'markdown',
      numbered: false,
    })

    expect(result).not.toMatch(/^1\. /m)
    expect(result).not.toMatch(/^2\. /m)
    expect(result).toContain('First Article')
  })

  test('separates articles with double newline', () => {
    const result = formatNewsArticles(articles, { mode: 'markdown' })

    expect(result).toContain('\n\n')
  })

  test('handles empty article list', () => {
    const result = formatNewsArticles([], { mode: 'markdown' })

    expect(result).toBe('')
  })

  test('passes format options to individual articles', () => {
    const result = formatNewsArticles(articles, {
      mode: 'plain',
      includeDate: false,
    })

    expect(result).toContain('First Article')
    expect(result).not.toContain('📅')
  })
})

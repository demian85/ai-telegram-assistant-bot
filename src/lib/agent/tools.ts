import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import type { StructuredTool } from '@langchain/core/tools'
import type { NewsQueryService } from '@lib/news/index.js'
import { formatNewsArticles, type NewsArticle } from '@lib/telegram/util.js'
import logger from '@lib/logger.js'

function safeEvaluate(expression: string): number {
  const sanitized = expression.replace(/[^0-9+\-*/.()\s]/g, '')
  if (!sanitized) {
    throw new Error('Invalid expression')
  }

  const result = Function(`"use strict"; return (${sanitized})`)()

  if (typeof result !== 'number' || !isFinite(result)) {
    throw new Error('Invalid result')
  }

  return result
}

export const calculatorTool = tool(
  async ({ expression }) => {
    try {
      const result = safeEvaluate(expression)
      return result.toString()
    } catch {
      return `Error: Invalid expression. Only basic math operations (+, -, *, /, parentheses) are supported.`
    }
  },
  {
    name: 'calculator',
    description:
      'Evaluate mathematical expressions safely. Supports +, -, *, /, and parentheses.',
    schema: z.object({
      expression: z
        .string()
        .describe(
          'The mathematical expression to evaluate, e.g., "2 + 2" or "(10 * 5) / 2"'
        ),
    }),
  }
)

export const helpTool = tool(
  async ({ topic }) => {
    const generalHelp = `
I am an AI-powered Telegram bot. Here's what I can do:

**General Chat:**
- Talk to me in private chats, or mention me in groups to get a reply
- I remember our conversation context
- I can use tools to help you

**Available Commands:**
- /help - Show this help message
- /clear - Clear conversation history
- /info - Show chat and subscription status
- /subscribe - Enable news delivery for this chat
- /unsubscribe - Disable news delivery for this chat
- /interval [seconds] - Show or set the news delivery interval
- /newsfilter [description|reset] - Describe, view, or reset news preferences
- /news [count] - Get recent news (1-10 articles)

**Tools:**
- Calculator: Ask me to calculate expressions
- Current Time: Ask for the current time
- Recent News: Ask for latest news headlines

**News Monitoring:**
I monitor AI news feeds and forward relevant articles to groups. You can also ask me for recent news anytime.
`

    const calculatorHelp = `
**Calculator Tool:**
I can evaluate mathematical expressions for you.

Examples:
- "What is 15 * 24?"
- "Calculate (100 + 50) / 3"
- "What's 2^10?"

Supported operations: +, -, *, /, parentheses
`

    const timeHelp = `
**Time Tool:**
I can tell you the current date and time.

Examples:
- "What time is it?"
- "What's the current date?"
- "Give me a timestamp"
`

    const newsHelp = `
**Recent News Tool:**
I can retrieve the latest AI news articles I've collected.

Examples:
- "Show me the latest 5 news"
- "What are the recent AI headlines?"
- "Get me 10 recent articles"
- "Any news today?"

I track news from multiple sources including Planet AI, Hacker News, Google AI, Hugging Face, and more.
`

    const topicLower = topic?.toLowerCase() || ''

    if (topicLower.includes('calculator') || topicLower.includes('math')) {
      return calculatorHelp
    }
    if (topicLower.includes('time') || topicLower.includes('date')) {
      return timeHelp
    }
    if (
      topicLower.includes('news') ||
      topicLower.includes('article') ||
      topicLower.includes('headline')
    ) {
      return newsHelp
    }

    return generalHelp
  },
  {
    name: 'help',
    description:
      'Get help about bot capabilities and commands. Optionally specify a topic like "calculator", "time", or "news".',
    schema: z.object({
      topic: z
        .string()
        .optional()
        .describe(
          'Optional topic to get specific help about (e.g., "calculator", "time", "news")'
        ),
    }),
  }
)

export const timeTool = tool(
  async ({ timezone }) => {
    const now = new Date()

    if (timezone && timezone !== 'UTC') {
      try {
        const options: Intl.DateTimeFormatOptions = {
          timeZone: timezone,
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          timeZoneName: 'short',
        }
        return new Intl.DateTimeFormat('en-US', options).format(now)
      } catch {
        return `Error: Invalid timezone "${timezone}". Using UTC instead: ${now.toISOString()}`
      }
    }

    return now.toISOString()
  },
  {
    name: 'current_time',
    description:
      'Get the current date and time. Optionally specify a timezone (default is UTC).',
    schema: z.object({
      timezone: z
        .string()
        .optional()
        .describe(
          'Timezone (e.g., "America/New_York", "Europe/London"). Defaults to UTC.'
        ),
    }),
  }
)

export function createRecentNewsTool(
  newsQueryService: NewsQueryService
): StructuredTool {
  return tool(
    async ({ count }, config) => {
      try {
        const chatId = z.string().min(1).parse(config.configurable?.newsChatId)
        const articles = await newsQueryService.fetchAndGetRecentNewsForChat(
          count,
          chatId
        )

        if (articles.length === 0) {
          return "I don't have any relevant news articles available right now. News is collected periodically from various sources. Try again in a few minutes, or subscribe to get news delivered automatically with /subscribe."
        }

        const header = `Here are the latest ${articles.length} relevant news articles:\n\n`
        const formatted = formatNewsArticles(articles as NewsArticle[], {
          mode: 'plain',
          includeDescription: true,
          descriptionMaxLength: 200,
          includeRelevance: true,
          includeDate: true,
          numbered: true,
        })

        return header + formatted
      } catch (error) {
        logger.error(
          {
            event: 'news.tool.error',
            err: error instanceof Error ? error : new Error(String(error)),
          },
          'Failed to retrieve news for this chat'
        )
        return "I couldn't retrieve recent news right now. Please try again later or use /news command."
      }
    },
    {
      name: 'get_recent_news',
      description:
        'Retrieve the most recent relevant news articles collected by the bot from RSS feeds. Use this when the user asks for latest news, recent headlines, recent articles, or past news items.',
      schema: z.object({
        count: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .default(5)
          .describe('How many recent news articles to retrieve, from 1 to 10'),
      }),
    }
  )
}

export interface AgentToolDependencies {
  newsQueryService?: NewsQueryService
  supportsWebSearch?: boolean
}

export function createAgentTools(
  deps: AgentToolDependencies = {}
): StructuredTool[] {
  const tools: StructuredTool[] = [calculatorTool, helpTool, timeTool]

  const newsQueryService = deps.newsQueryService
  const shouldIncludeNewsTool = newsQueryService && !deps.supportsWebSearch
  if (shouldIncludeNewsTool) {
    tools.push(createRecentNewsTool(newsQueryService))
  }

  return tools
}

export const allTools: StructuredTool[] = [calculatorTool, helpTool, timeTool]

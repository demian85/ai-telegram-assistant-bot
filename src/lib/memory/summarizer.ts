import { ChatOpenAI } from '@langchain/openai'
import type { ConversationMessage } from '../redis/conversation-store.js'
import type { MemorySummary } from './types.js'
import {
  renderPromptTemplate,
  summarizerPromptVariables,
} from '../config/prompt-template.js'

export class Summarizer {
  private readonly model: ChatOpenAI

  constructor(
    model: ChatOpenAI,
    private readonly systemPrompt: string
  ) {
    this.model = model
  }

  async generateSummary(
    chatId: string,
    messages: ConversationMessage[],
    level: 'daily' | 'weekly' | 'monthly',
    startTime: number,
    endTime: number,
    signal?: AbortSignal
  ): Promise<MemorySummary> {
    const conversationText = messages
      .filter((m) => m.role !== 'system')
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n\n')

    const levelDescriptions = {
      daily: 'day',
      weekly: 'week',
      monthly: 'month',
    }

    const variables = {
      level,
      period: levelDescriptions[level],
      startTime: new Date(startTime).toISOString(),
      endTime: new Date(endTime).toISOString(),
      messageCount: String(
        messages.filter((message) => message.role !== 'system').length
      ),
    } satisfies Record<(typeof summarizerPromptVariables)[number], string>
    const systemPrompt = renderPromptTemplate(this.systemPrompt, variables)

    try {
      const response = await this.model.invoke(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: conversationText },
        ],
        { signal }
      )
      signal?.throwIfAborted()
      const summaryText =
        typeof response.content === 'string'
          ? response.content
          : JSON.stringify(response.content)

      const topics = this.extractTopics(messages)

      return {
        level,
        chatId,
        startTime,
        endTime,
        summary: summaryText.trim(),
        messageCount: messages.length,
        keyTopics: topics,
        createdAt: Date.now(),
      }
    } catch (error) {
      signal?.throwIfAborted()
      console.error('Summary generation failed:', error)
      return {
        level,
        chatId,
        startTime,
        endTime,
        summary: `Conversation summary unavailable for ${levelDescriptions[level]}.`,
        messageCount: messages.length,
        keyTopics: [],
        createdAt: Date.now(),
      }
    }
  }

  private extractTopics(messages: ConversationMessage[]): string[] {
    const topics = new Set<string>()
    const content = messages.map((m) => m.content.toLowerCase()).join(' ')

    const commonTopics = [
      'ai',
      'artificial intelligence',
      'machine learning',
      'model',
      'code',
      'programming',
      'development',
      'bug',
      'feature',
      'meeting',
      'schedule',
      'deadline',
      'plan',
      'project',
      'question',
      'help',
      'issue',
      'problem',
      'solution',
      'telegram',
      'bot',
      'api',
    ]

    for (const topic of commonTopics) {
      if (content.includes(topic)) {
        topics.add(topic)
      }
    }

    return Array.from(topics).slice(0, 5)
  }
}

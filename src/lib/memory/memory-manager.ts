import type { Redis } from 'ioredis'
import {
  ConversationStore,
  type ConversationMessage,
} from '../redis/conversation-store.js'
import { SummaryStore } from './summary-store.js'
import { Summarizer } from './summarizer.js'
import type {
  MemoryConfig,
  MemorySummary,
  HierarchicalContext,
} from './types.js'
import { defaultMemoryConfig } from './types.js'
import type { ChatOpenAI } from '@langchain/openai'

export class MemoryManager {
  private readonly conversationStore: ConversationStore
  private readonly summaryStore: SummaryStore
  private readonly summarizer: Summarizer
  private readonly config: MemoryConfig

  constructor(
    redis: Redis,
    model: ChatOpenAI,
    summarizerSystemPrompt: string,
    config: Partial<MemoryConfig> = {}
  ) {
    this.conversationStore = new ConversationStore(redis)
    this.summaryStore = new SummaryStore(redis)
    this.summarizer = new Summarizer(model, summarizerSystemPrompt)
    this.config = { ...defaultMemoryConfig, ...config }
  }

  async addMessage(
    chatId: string,
    message: ConversationMessage,
    signal?: AbortSignal
  ): Promise<void> {
    signal?.throwIfAborted()
    await this.conversationStore.addMessage(chatId, message)
    await this.checkAndGenerateSummaries(chatId, signal)
  }

  async getConversationHistory(
    chatId: string,
    limit?: number
  ): Promise<ConversationMessage[]> {
    return this.conversationStore.getHistory(chatId, limit)
  }

  async getContextWindow(chatId: string): Promise<HierarchicalContext> {
    const recentMessages = await this.conversationStore.getHistory(
      chatId,
      this.config.recentBufferSize
    )

    const [dailySummaries, weeklySummaries, monthlySummaries] =
      await Promise.all([
        this.summaryStore.getSummaries(chatId, 'daily', 7),
        this.summaryStore.getSummaries(chatId, 'weekly', 4),
        this.summaryStore.getSummaries(chatId, 'monthly', 3),
      ])

    return {
      recentMessages,
      dailySummaries,
      weeklySummaries,
      monthlySummaries,
    }
  }

  async checkAndGenerateSummaries(
    chatId: string,
    signal?: AbortSignal
  ): Promise<void> {
    const now = Date.now()

    signal?.throwIfAborted()
    await this.checkAndGenerateDaily(chatId, now, signal)
    signal?.throwIfAborted()
    await this.checkAndGenerateWeekly(chatId, now)
    signal?.throwIfAborted()
    await this.checkAndGenerateMonthly(chatId, now)
  }

  private async checkAndGenerateDaily(
    chatId: string,
    now: number,
    signal?: AbortSignal
  ): Promise<void> {
    const shouldGenerate = await this.summaryStore.shouldGenerateSummary(
      chatId,
      'daily',
      this.config.dailySummaryInterval
    )

    if (!shouldGenerate) return

    const lastSummary = await this.summaryStore.getLastSummary(chatId, 'daily')
    const startTime =
      lastSummary?.endTime ?? now - this.config.dailySummaryInterval
    const messages = await this.getMessagesInRange(chatId, startTime, now)

    if (messages.length < 5) return

    const summary = await this.summarizer.generateSummary(
      chatId,
      messages,
      'daily',
      startTime,
      now,
      signal
    )

    await this.summaryStore.saveSummary(summary)
  }

  private async checkAndGenerateWeekly(
    chatId: string,
    now: number
  ): Promise<void> {
    const shouldGenerate = await this.summaryStore.shouldGenerateSummary(
      chatId,
      'weekly',
      this.config.weeklySummaryInterval
    )

    if (!shouldGenerate) return

    const lastSummary = await this.summaryStore.getLastSummary(chatId, 'weekly')
    const startTime =
      lastSummary?.endTime ?? now - this.config.weeklySummaryInterval

    const dailySummaries = await this.summaryStore.getSummariesInRange(
      chatId,
      'daily',
      startTime,
      now
    )

    if (dailySummaries.length < 3) return

    const summary = await this.aggregateSummaries(
      chatId,
      dailySummaries,
      'weekly',
      startTime,
      now
    )

    await this.summaryStore.saveSummary(summary)
  }

  private async checkAndGenerateMonthly(
    chatId: string,
    now: number
  ): Promise<void> {
    const shouldGenerate = await this.summaryStore.shouldGenerateSummary(
      chatId,
      'monthly',
      this.config.monthlySummaryInterval
    )

    if (!shouldGenerate) return

    const lastSummary = await this.summaryStore.getLastSummary(
      chatId,
      'monthly'
    )
    const startTime =
      lastSummary?.endTime ?? now - this.config.monthlySummaryInterval

    const weeklySummaries = await this.summaryStore.getSummariesInRange(
      chatId,
      'weekly',
      startTime,
      now
    )

    if (weeklySummaries.length < 2) return

    const summary = await this.aggregateSummaries(
      chatId,
      weeklySummaries,
      'monthly',
      startTime,
      now
    )

    await this.summaryStore.saveSummary(summary)
  }

  private async getMessagesInRange(
    chatId: string,
    startTime: number,
    endTime: number
  ): Promise<ConversationMessage[]> {
    const allMessages = await this.conversationStore.getHistory(chatId)
    return allMessages.filter(
      (m) =>
        m.timestamp >= startTime &&
        m.timestamp <= endTime &&
        m.role !== 'system'
    )
  }

  private async aggregateSummaries(
    chatId: string,
    summaries: MemorySummary[],
    level: 'weekly' | 'monthly',
    startTime: number,
    endTime: number
  ): Promise<MemorySummary> {
    const combinedSummary = summaries.map((s) => s.summary).join(' ')
    const allTopics = new Set<string>()
    let totalMessageCount = 0

    for (const s of summaries) {
      s.keyTopics.forEach((t) => allTopics.add(t))
      totalMessageCount += s.messageCount
    }

    const periodText = level === 'weekly' ? 'week' : 'month'

    return {
      level,
      chatId,
      startTime,
      endTime,
      summary: `Over the past ${periodText}: ${combinedSummary.slice(0, 200)}...`,
      messageCount: totalMessageCount,
      keyTopics: Array.from(allTopics).slice(0, 5),
      createdAt: Date.now(),
    }
  }

  async clearHistory(chatId: string): Promise<void> {
    await Promise.all([
      this.conversationStore.clearHistory(chatId),
      this.summaryStore.clearSummaries(chatId),
    ])
  }
}

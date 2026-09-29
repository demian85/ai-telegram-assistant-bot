import { createAgent, type ReactAgent } from 'langchain'
import { ChatOpenAI } from '@langchain/openai'
import type { MessageContent } from '@langchain/core/messages'
import type { StructuredTool } from '@langchain/core/tools'
import type { Redis } from 'ioredis'
import logger from '../logger.js'
import type { ConversationMessage } from '../redis/conversation-store.js'
import { MemoryManager } from '../memory/memory-manager.js'
import type { MemoryConfig } from '../memory/types.js'
import {
  buildLiveUserContent,
  buildPersistedTextShadow,
  extractTextContent,
  type AgentLiveInvocationInput,
} from './content.js'

export interface AgentServiceConfig {
  redis: Redis
  agentModel: ChatOpenAI
  summarizerModel: ChatOpenAI
  supportsVision: boolean
  supportsWebSearch?: boolean
  tools: StructuredTool[]
  systemPrompt?: string
  memoryConfig?: Partial<MemoryConfig>
}

export class AgentService {
  private readonly memoryManager: MemoryManager
  private readonly model: ChatOpenAI
  private readonly supportsVision: boolean
  private readonly tools: StructuredTool[]
  private readonly systemPrompt: string
  private agent: ReactAgent | null = null

  constructor(config: AgentServiceConfig) {
    this.memoryManager = new MemoryManager(
      config.redis,
      config.summarizerModel,
      config.memoryConfig
    )
    this.model = config.agentModel
    this.supportsVision = config.supportsVision
    this.tools = config.tools
    this.systemPrompt = config.systemPrompt || this.getDefaultSystemPrompt()
  }

  async initialize(): Promise<void> {
    const toolNames = this.tools.map((t) => t.name).join(', ')
    logger.info(
      { toolCount: this.tools.length, toolNames },
      'Initializing agent with tools'
    )
    this.agent = createAgent({
      model: this.model,
      tools: this.tools,
    })
  }

  async invoke(chatId: string, message: string): Promise<string> {
    return this.invokeLive(chatId, { text: message })
  }

  async persistUserMessage(
    chatId: string,
    input: AgentLiveInvocationInput
  ): Promise<void> {
    const persistedUserContent = buildPersistedTextShadow(input)

    if (!persistedUserContent) {
      return
    }

    await this.memoryManager.addMessage(chatId, {
      role: 'user',
      content: persistedUserContent,
      timestamp: Date.now(),
    })
  }

  supportsImageInput(): boolean {
    return this.supportsVision
  }

  async invokeLive(
    chatId: string,
    input: AgentLiveInvocationInput
  ): Promise<string> {
    if (!this.agent) {
      throw new Error('Agent not initialized. Call initialize() first.')
    }

    const contextWindow = await this.memoryManager.getContextWindow(chatId)
    const persistedUserContent = buildPersistedTextShadow(input)
    const liveUserContent = buildLiveUserContent(input, this.supportsVision)
    const messages = this.buildAgentMessages(
      contextWindow,
      liveUserContent,
      persistedUserContent
    )

    await this.memoryManager.addMessage(chatId, {
      role: 'user',
      content: persistedUserContent,
      timestamp: Date.now(),
    })

    try {
      logger.debug(
        {
          messages,
          toolCount: this.tools.length,
          toolNames: this.tools.map((t) => t.name),
        },
        'Agent invoke starting'
      )

      const result = await this.agent.invoke(
        { messages },
        {
          configurable: { newsChatId: chatId.replace(/^(private|group):/, '') },
        }
      )

      const lastMessage = result.messages[result.messages.length - 1]
      const toolCalls = (lastMessage as any).tool_calls
      const responsePreview = lastMessage.content
        ? extractTextContent(lastMessage.content as MessageContent).slice(
            0,
            200
          )
        : ''

      logger.info(
        {
          hasToolCalls: Array.isArray(toolCalls) && toolCalls.length > 0,
          toolCallCount: Array.isArray(toolCalls) ? toolCalls.length : 0,
          toolCalls: Array.isArray(toolCalls)
            ? toolCalls.map((c: any) => ({ name: c.name, args: c.args }))
            : [],
          responsePreview,
        },
        'Agent invoke completed'
      )

      const responseText = extractTextContent(
        lastMessage.content as MessageContent
      )

      await this.memoryManager.addMessage(chatId, {
        role: 'assistant',
        content: responseText,
        timestamp: Date.now(),
      })

      return responseText
    } catch (error) {
      console.error('Agent invoke error:', error)
      throw error
    }
  }

  async getHistory(chatId: string): Promise<ConversationMessage[]> {
    return this.memoryManager.getConversationHistory(chatId)
  }

  async clearHistory(chatId: string): Promise<void> {
    return this.memoryManager.clearHistory(chatId)
  }

  private buildAgentMessages(
    contextWindow: Awaited<ReturnType<MemoryManager['getContextWindow']>>,
    liveUserContent: MessageContent,
    persistedUserContent: string
  ): Array<{ role: 'system' | 'user' | 'assistant'; content: MessageContent }> {
    const summaryContext = this.formatSummaryContext(contextWindow)

    return [
      { role: 'system', content: this.systemPrompt },
      ...(summaryContext
        ? ([{ role: 'system', content: summaryContext }] as const)
        : []),
      ...contextWindow.recentMessages.map((message) => ({
        role: message.role as 'system' | 'user' | 'assistant',
        content: message.content,
      })),
      {
        role: 'user',
        content: this.supportsVision ? liveUserContent : persistedUserContent,
      },
    ]
  }

  private formatSummaryContext(
    contextWindow: Awaited<ReturnType<MemoryManager['getContextWindow']>>
  ): string {
    const sections = [
      this.formatSummarySection(
        'Daily summaries',
        contextWindow.dailySummaries
      ),
      this.formatSummarySection(
        'Weekly summaries',
        contextWindow.weeklySummaries
      ),
      this.formatSummarySection(
        'Monthly summaries',
        contextWindow.monthlySummaries
      ),
    ].filter(Boolean)

    if (sections.length === 0) {
      return ''
    }

    return `Conversation memory:\n${sections.join('\n\n')}`
  }

  private formatSummarySection(
    label: string,
    summaries: Array<{ summary: string; endTime: number }>
  ): string {
    if (summaries.length === 0) {
      return ''
    }

    const items = summaries.map(
      (summary) =>
        `- ${new Date(summary.endTime).toISOString()}: ${summary.summary}`
    )

    return `${label}:\n${items.join('\n')}`
  }

  private getDefaultSystemPrompt(): string {
    return `You are a helpful AI assistant. You have access to tools that can help answer questions and perform tasks.

When using tools:
- Always use the calculator for mathematical calculations
- Provide clear, concise responses
- If you're unsure about something, say so
- Be friendly and helpful in your interactions`
  }
}

export function createAgentService(config: AgentServiceConfig): AgentService {
  return new AgentService(config)
}

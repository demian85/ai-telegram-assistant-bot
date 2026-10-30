import { createAgent, type ReactAgent } from 'langchain'
import { createHash } from 'node:crypto'
import { citedResponse } from '../llm/response.js'
import { ChatOpenAI } from '@langchain/openai'
import type { MessageContent } from '@langchain/core/messages'
import type { StructuredTool } from '@langchain/core/tools'
import type { Redis } from 'ioredis'
import logger from '../logger.js'
import type { ConversationMessage } from '../redis/conversation-store.js'
import { MemoryManager } from '../memory/memory-manager.js'
import type { MemoryConfig } from '../memory/types.js'
import type { ChatSystemPrompts } from '../config/types.js'
import { renderPromptTemplate } from '../config/prompt-template.js'
import type { TelegramChatScopeType } from '../telegram/scope.js'
import { downloadImageDataUrl } from './image.js'
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
  tools: StructuredTool[]
  readonly systemPrompts: ChatSystemPrompts
  readonly summarizerSystemPrompt: string
  memoryConfig?: Partial<MemoryConfig>
}

export class AgentService {
  private readonly memoryManager: MemoryManager
  private readonly model: ChatOpenAI
  private readonly supportsVision: boolean
  private readonly tools: StructuredTool[]
  private readonly systemPrompts: ChatSystemPrompts
  private agent: ReactAgent | null = null
  private readonly summaryModel: ChatOpenAI

  constructor(config: AgentServiceConfig) {
    this.memoryManager = new MemoryManager(
      config.redis,
      config.summarizerModel,
      config.summarizerSystemPrompt,
      config.memoryConfig
    )
    this.model = config.agentModel
    this.summaryModel = config.summarizerModel
    this.supportsVision = config.supportsVision
    this.tools = config.tools
    this.systemPrompts = config.systemPrompts
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
      middleware: [
        {
          name: 'chat-purpose',
          wrapModelCall: (request, handler) => {
            const summary = request.runtime.configurable?.purpose === 'summary'
            return handler({
              ...request,
              model: summary ? this.summaryModel : request.model,
              tools: summary ? [] : request.tools,
              modelSettings: {
                ...request.modelSettings,
                promptCacheKey: request.runtime.configurable?.promptCacheKey,
              },
            })
          },
        },
      ],
    })
  }

  async invoke(
    chatId: string,
    message: string,
    chatType: TelegramChatScopeType
  ): Promise<string> {
    return this.invokeLive(chatId, { text: message }, chatType)
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
    input: AgentLiveInvocationInput,
    chatType: TelegramChatScopeType,
    purpose: 'chat' | 'summary' = 'chat'
  ): Promise<string> {
    if (!this.agent) {
      throw new Error('Agent not initialized. Call initialize() first.')
    }

    const signal = AbortSignal.timeout(75_000)
    try {
      const contextWindow = await this.memoryManager.getContextWindow(chatId)
      const persistedUserContent = buildPersistedTextShadow(input)

      await this.memoryManager.addMessage(
        chatId,
        {
          role: 'user',
          content: persistedUserContent,
          timestamp: Date.now(),
        },
        signal
      )

      const liveInput =
        this.supportsVision && input.imageUrl
          ? {
              ...input,
              imageUrl: await downloadImageDataUrl(input.imageUrl, signal),
            }
          : input
      const liveUserContent = buildLiveUserContent(
        liveInput,
        this.supportsVision
      )
      const messages = this.buildAgentMessages(
        contextWindow,
        liveUserContent,
        chatType
      )

      logger.debug(
        {
          messageCount: messages.length,
          toolCount: this.tools.length,
          toolNames: this.tools.map((t) => t.name),
        },
        'Agent invoke starting'
      )

      const cacheKey = createHash('sha256')
        .update(`${purpose}:${chatId}:${this.model.model}`)
        .digest('hex')
      const result = await this.agent.invoke(
        { messages },
        {
          signal,
          configurable: {
            newsChatId: chatId.replace(/^(private|group):/, ''),
            chatScope: chatId,
            purpose,
            promptCacheKey: cacheKey,
          },
          recursionLimit: 12,
        }
      )
      signal.throwIfAborted()

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

      const responseText = citedResponse(lastMessage, {
        includeSourceList: chatType !== 'group',
      })

      await this.memoryManager.addMessage(
        chatId,
        {
          role: 'assistant',
          content: responseText,
          timestamp: Date.now(),
        },
        signal
      )

      return responseText
    } catch (error) {
      const err = signal.aborted ? signal.reason : error
      logger.error({ err, chatScope: chatId }, 'Agent invoke failed')
      throw err
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
    chatType: TelegramChatScopeType
  ): Array<{ role: 'system' | 'user' | 'assistant'; content: MessageContent }> {
    const summaryContext = this.formatSummaryContext(contextWindow)

    return [
      {
        role: 'system',
        content: renderPromptTemplate(this.systemPrompts[chatType], {
          chatType,
        }),
      },
      ...(summaryContext
        ? ([{ role: 'system', content: summaryContext }] as const)
        : []),
      ...contextWindow.recentMessages.map((message) => ({
        role: message.role as 'system' | 'user' | 'assistant',
        content: message.content,
      })),
      {
        role: 'user',
        content: liveUserContent,
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
}

export function createAgentService(config: AgentServiceConfig): AgentService {
  return new AgentService(config)
}

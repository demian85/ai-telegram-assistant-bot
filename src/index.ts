import 'dotenv/config'

import { Bot } from '@lib/telegram/index.js'
import logger from '@lib/logger.js'
import { loadAppConfig } from '@lib/config/load-config.js'
import type { AppConfig } from '@lib/config/types.js'
import { getRedisClient, closeRedisClient } from '@lib/redis/index.js'
import {
  NewsScheduler,
  NewsStore,
  NewsQueryService,
  RelevanceDetector,
} from '@lib/news/index.js'
import { createAgentTools } from '@lib/agent/tools.js'
import { ChatNewsFilter } from '@lib/news/chat-news-filter.js'
import {
  NewsPreferenceStore,
  NewsPreferenceGenerator,
} from '@lib/news/preferences.js'
import {
  createLlmRoleModels,
  llmSupportsVision,
  llmSupportsWebSearch,
} from '@lib/llm/model.js'

async function main() {
  const config: AppConfig = loadAppConfig()
  const redis = getRedisClient()

  const models = createLlmRoleModels(config)

  const newsStore = new NewsStore(redis)
  const relevanceDetector = new RelevanceDetector(models.newsRelevance, {
    topics: config.news.topics,
    relevanceThreshold: config.news.relevanceThreshold,
    systemPrompt: config.llm.roles.newsRelevance.systemPrompt,
  })
  const newsPreferences = new NewsPreferenceStore(redis, config.news.topics)
  const filter = new ChatNewsFilter(redis, newsPreferences, relevanceDetector)
  const newsPreferenceGenerator = new NewsPreferenceGenerator(
    models.newsPreferences,
    config.llm.roles.newsPreferences
  )
  const newsQueryService = new NewsQueryService({
    redis,
    feeds: config.news.feeds,
    filter,
  })

  const supportsWebSearch = llmSupportsWebSearch('chat', config)
  const tools = createAgentTools({ newsQueryService, supportsWebSearch })

  const bot = new Bot(
    { telegram: config.telegram, news: config.news },
    {
      agentModel: models.chat,
      summarizerModel: models.summarizer,
      chatSystemPrompt: config.llm.roles.chat.systemPrompt,
      supportsVision: llmSupportsVision('chat', config),
      supportsWebSearch,
    },
    {
      redis,
      newsQueryService,
      tools,
      newsPreferences,
      newsPreferenceGenerator,
    }
  )

  await bot.init()

  logger.info('Bot initialized')

  const newsScheduler = new NewsScheduler(
    {
      redis,
      model: models.newsRelevance,
      newsConfig: config.news,
      onDeliverArticle: async ({ chatId, article }) => {
        await bot.sendNewsArticle(chatId, article)
        logger.info({ chatId, article }, 'Relevant article delivered')
      },
    },
    {
      newsStore,
      filter,
    }
  )

  try {
    logger.info('Starting news scheduler...')
    await newsScheduler.start()
    logger.info('News scheduler started successfully')
  } catch (err) {
    logger.error({ err }, 'Failed to start news scheduler')
    throw err
  }

  process.once('SIGINT', async () => {
    logger.info('Shutting down...')
    await newsScheduler.stop()
    closeRedisClient()
    process.exit(0)
  })

  process.once('SIGTERM', async () => {
    logger.info('Shutting down...')
    await newsScheduler.stop()
    closeRedisClient()
    process.exit(0)
  })
}

main().catch((err) => {
  logger.error(err)
  process.exit(1)
})

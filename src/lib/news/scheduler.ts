import { Queue, Worker } from 'bullmq'
import type { JobsOptions } from 'bullmq'
import type { Redis } from 'ioredis'
import type { NewsConfig } from './types.js'
import { FeedReader } from './feed-reader.js'
import { NewsStore } from './news-store.js'
import { RelevanceDetector } from './relevance-detector.js'
import { ChatSubscriptionStore } from './chat-subscription-store.js'
import { NewsDeliveryStore } from './news-delivery-store.js'
import type { VeniceDecisionModel } from '@lib/llm/decision-model.js'
import logger from '@lib/logger.js'
import { ChatNewsFilter } from './chat-news-filter.js'
import { NewsPreferenceStore } from './preferences.js'
import {
  clearNewsRepeatableJobs,
  type RepeatableQueue,
} from './repeatable-jobs.js'

const startupJobRegistrations = [
  { name: 'poll-news', jobId: 'poll-news-startup' },
  { name: 'deliver-news', jobId: 'deliver-news-startup' },
] as const

interface RelevantArticle {
  articleId: string
  title: string
  url: string
  description?: string
  relevanceScore: number
}

type DeliveryCallback = (delivery: {
  chatId: string
  article: RelevantArticle
}) => Promise<void>

interface QueueLike extends RepeatableQueue {
  add(
    name: string,
    data: Record<string, never>,
    options?: JobsOptions
  ): Promise<unknown>
  close(): Promise<unknown>
}

interface WorkerLike {
  close(): Promise<unknown>
}

export interface NewsSchedulerConfig {
  redis: Redis
  model: VeniceDecisionModel
  newsConfig: NewsConfig
  onDeliverArticle?: DeliveryCallback
}

export interface NewsSchedulerDependencies {
  filter?: ChatNewsFilter
  feedReader?: FeedReader
  newsStore?: NewsStore
  relevanceDetector?: RelevanceDetector
  chatSubscriptionStore?: ChatSubscriptionStore
  newsDeliveryStore?: NewsDeliveryStore
  queue?: QueueLike
  worker?: WorkerLike
}

export class NewsScheduler {
  private readonly feedReader: FeedReader
  private readonly newsStore: NewsStore
  private readonly filter: ChatNewsFilter
  private readonly chatSubscriptionStore: ChatSubscriptionStore
  private readonly newsDeliveryStore: NewsDeliveryStore
  private readonly config: NewsConfig
  private readonly redis: Redis
  private readonly queue: QueueLike
  private readonly worker: WorkerLike

  constructor(
    config: NewsSchedulerConfig,
    dependencies: NewsSchedulerDependencies = {}
  ) {
    this.feedReader = dependencies.feedReader ?? new FeedReader()
    this.newsStore = dependencies.newsStore ?? new NewsStore(config.redis)
    const relevanceDetector =
      dependencies.relevanceDetector ??
      new RelevanceDetector(config.model, {
        relevanceThreshold: config.newsConfig.relevanceThreshold,
        decisionConfidenceThreshold:
          config.newsConfig.decisionConfidenceThreshold,
      })
    this.filter =
      dependencies.filter ??
      new ChatNewsFilter(
        config.redis,
        new NewsPreferenceStore(config.redis, config.newsConfig.defaultFilter),
        relevanceDetector
      )
    this.chatSubscriptionStore =
      dependencies.chatSubscriptionStore ??
      new ChatSubscriptionStore(config.redis)
    this.newsDeliveryStore =
      dependencies.newsDeliveryStore ?? new NewsDeliveryStore(config.redis)
    this.config = config.newsConfig
    this.redis = config.redis

    this.queue =
      dependencies.queue ??
      new Queue('news-polling', {
        connection: config.redis,
      })

    this.worker =
      dependencies.worker ??
      new Worker(
        'news-polling',
        async (job) => {
          logger.debug(
            {
              event: 'news.job.start',
              jobName: job.name,
              jobId: job.id,
              repeatEveryMs: job.opts.repeat?.every,
            },
            'News job started'
          )

          try {
            switch (job.name) {
              case 'poll-news':
                await this.pollFeeds()
                break
              case 'deliver-news':
                if (config.onDeliverArticle) {
                  await this.deliverRelevantArticles(config.onDeliverArticle)
                }
                break
            }

            logger.debug(
              {
                event: 'news.job.complete',
                jobName: job.name,
                jobId: job.id,
                repeatEveryMs: job.opts.repeat?.every,
              },
              'News job completed'
            )
          } catch (error) {
            logger.error(
              {
                event: 'news.job.fail',
                jobName: job.name,
                jobId: job.id,
                repeatEveryMs: job.opts.repeat?.every,
                err: error,
              },
              'News job failed'
            )
            throw error
          }
        },
        {
          connection: config.redis.duplicate({
            maxRetriesPerRequest: null,
          }),
        }
      )
  }

  async start(): Promise<void> {
    const pollIntervalMs = this.config.pollIntervalMinutes * 60 * 1000
    const deliveryIntervalMs = this.config.deliveryCheckIntervalSeconds * 1000
    const repeatJobRegistrations = [
      {
        name: 'poll-news',
        jobId: 'poll-news-repeat',
        everyMs: pollIntervalMs,
      },
      {
        name: 'deliver-news',
        jobId: 'deliver-news-repeat',
        everyMs: deliveryIntervalMs,
      },
    ] as const

    logger.info(
      {
        event: 'news.scheduler.starting',
        feedCount: this.config.feeds.length,
        feeds: this.config.feeds,
        pollIntervalMinutes: this.config.pollIntervalMinutes,
        relevanceThreshold: this.config.relevanceThreshold,
      },
      `Starting news scheduler with ${this.config.feeds.length} feeds`
    )

    await clearNewsRepeatableJobs(this.queue)

    for (const job of startupJobRegistrations) {
      await this.queue.add(job.name, {}, { jobId: job.jobId })
      logger.info(
        {
          event: 'news.job.enqueue',
          jobName: job.name,
          jobId: job.jobId,
          schedule: 'startup',
        },
        `Enqueued startup job: ${job.name}`
      )
    }

    for (const job of repeatJobRegistrations) {
      await this.queue.add(
        job.name,
        {},
        {
          jobId: job.jobId,
          repeat: { every: job.everyMs },
        }
      )
      logger.info(
        {
          event: 'news.job.enqueue',
          jobName: job.name,
          jobId: job.jobId,
          schedule: 'repeat',
          repeatEveryMs: job.everyMs,
        },
        `Enqueued repeat job: ${job.name} (every ${job.everyMs}ms)`
      )
    }

    logger.info(
      {
        event: 'news.scheduler.started',
        pollIntervalMinutes: this.config.pollIntervalMinutes,
        deliveryCheckIntervalSeconds: this.config.deliveryCheckIntervalSeconds,
        feedCount: this.config.feeds.length,
        relevanceThreshold: this.config.relevanceThreshold,
      },
      'News scheduler started successfully'
    )
  }

  async stop(): Promise<void> {
    await this.queue.close()
    await this.worker.close()
  }

  private async pollFeeds(): Promise<void> {
    logger.trace(
      { event: 'news.poll.start', feedCount: this.config.feeds.length },
      'Starting news feed polling cycle'
    )
    const startTime = Date.now()

    logger.info(
      {
        event: 'news.poll.starting',
        feedCount: this.config.feeds.length,
        feeds: this.config.feeds,
      },
      `Polling ${this.config.feeds.length} feeds for new articles`
    )

    const items = await this.feedReader.fetchAllFeeds(this.config.feeds)

    logger.info(
      {
        event: 'news.poll.fetched',
        feedCount: this.config.feeds.length,
        totalItems: items.length,
      },
      `Fetched ${items.length} articles from feeds`
    )

    const limited = items.slice(0, this.config.maxArticlesPerPoll)
    let storedCount = 0
    let skippedCount = 0

    for (const item of limited) {
      const wasStored = await this.newsStore.storeItem(item)
      if (!wasStored) {
        skippedCount++
        continue
      }
      storedCount++

      logger.info(
        {
          event: 'news.item.stored',
          itemId: item.id,
          itemTitle: item.title,
          itemSource: item.source,
        },
        `Stored article: ${item.title.slice(0, 50)}...`
      )
    }

    const pollDuration = Date.now() - startTime
    logger.info(
      {
        event: 'news.poll.complete',
        feedCount: this.config.feeds.length,
        itemsPolled: items.length,
        itemsStored: storedCount,
        itemsSkipped: skippedCount,
        durationMs: pollDuration,
      },
      `Poll complete: ${storedCount} stored, ${skippedCount} duplicates (${items.length} total fetched)`
    )
    logger.trace(
      {
        event: 'news.poll.end',
        durationMs: pollDuration,
        itemsStored: storedCount,
      },
      'Poll cycle ended'
    )
  }

  private async deliverRelevantArticles(
    callback: DeliveryCallback
  ): Promise<void> {
    const now = new Date()
    logger.trace(
      { event: 'news.delivery.start' },
      'Starting news delivery cycle'
    )
    const startTime = Date.now()

    const subscriptions =
      await this.chatSubscriptionStore.listEnabledSubscriptions()

    if (subscriptions.length === 0) {
      logger.debug(
        { event: 'news.delivery.no_subscriptions' },
        'No enabled subscriptions, skipping delivery'
      )
      return
    }

    logger.debug(
      {
        event: 'news.delivery.tick',
        subscribedChatCount: subscriptions.length,
      },
      'Evaluating subscribed chats for news delivery'
    )

    for (const subscription of subscriptions) {
      const eligibleAt = this.getEligibleDeliveryTime(subscription)

      if (eligibleAt.getTime() > now.getTime()) {
        logger.debug(
          {
            event: 'news.delivery.chat.skip',
            chatId: subscription.chatId,
            skipReason: 'not_due',
            now,
            eligibleAt,
            intervalSeconds: subscription.intervalSeconds,
            deliverAfter: subscription.deliverAfter,
            lastSentAt: subscription.lastSentAt,
          },
          'Subscribed chat is not yet eligible for delivery'
        )
        continue
      }

      const filter = await this.filter.preferences.resolve(subscription.chatId)

      const candidateItems = await this.newsStore.getItemsSince(
        subscription.deliverAfter
      )

      logger.debug(
        {
          event: 'news.delivery.chat.candidates',
          chatId: subscription.chatId,
          candidateCount: candidateItems.length,
          deliverAfter: subscription.deliverAfter,
        },
        `Found ${candidateItems.length} candidate items for chat ${subscription.chatId}`
      )

      let delivered = false

      for (const item of candidateItems) {
        const alreadyDelivered = await this.newsDeliveryStore.hasDelivered(
          subscription.chatId,
          item.id
        )
        if (alreadyDelivered) {
          continue
        }

        const result = await this.filter.evaluate(
          { chatId: subscription.chatId, filter },
          item
        )
        if (result === null) continue
        const { score, isRelevant } = result
        logger.debug(
          {
            event: 'news.delivery.chat.score',
            chatId: subscription.chatId,
            itemId: item.id,
            score,
            isRelevant,
            eligible: result.eligible,
            filterRevision: filter.revision,
            threshold: this.config.relevanceThreshold,
          },
          'Evaluated article for delivery'
        )

        if (!isRelevant) {
          continue
        }

        const currentFilter = await this.filter.preferences.resolve(
          subscription.chatId
        )
        if (currentFilter.revision !== filter.revision) break

        await this.newsDeliveryStore.markDelivered(
          subscription.chatId,
          item.id,
          now
        )

        logger.debug(
          {
            event: 'news.telegram.send.start',
            chatId: subscription.chatId,
            articleId: item.id,
            articleTitle: item.title,
            articleUrl: item.url,
            score,
            deliveryState: 'marked_delivered',
            markedDeliveredAt: now,
          },
          'Marked relevant article delivered before Telegram callback'
        )

        try {
          await callback({
            chatId: subscription.chatId,
            article: {
              articleId: item.id,
              title: item.title,
              url: item.url,
              description: item.description,
              relevanceScore: Math.round(score),
            },
          })
        } catch (error) {
          logger.error(
            {
              event: 'news.telegram.send.error',
              chatId: subscription.chatId,
              articleId: item.id,
              articleTitle: item.title,
              articleUrl: item.url,
              score,
              rollbackAction: 'unmarkDelivered',
              err: error,
            },
            'Telegram delivery callback failed'
          )

          await this.newsDeliveryStore.unmarkDelivered(
            subscription.chatId,
            item.id
          )

          logger.error(
            {
              event: 'news.delivery.rollback',
              chatId: subscription.chatId,
              articleId: item.id,
              articleTitle: item.title,
              articleUrl: item.url,
              score,
              rollbackAction: 'unmarkDelivered',
            },
            'Rolled back delivered article after Telegram failure'
          )

          throw error
        }

        await this.chatSubscriptionStore.markSent(subscription.chatId, now)

        logger.info(
          {
            event: 'news.delivery.success',
            chatId: subscription.chatId,
            articleId: item.id,
            articleTitle: item.title,
            relevanceScore: Math.round(score),
          },
          `Delivered article "${item.title.slice(0, 50)}..." to chat ${subscription.chatId}`
        )

        logger.debug(
          {
            event: 'news.telegram.send.success',
            chatId: subscription.chatId,
            articleId: item.id,
            articleTitle: item.title,
            articleUrl: item.url,
            score,
            deliveryState: 'marked_sent',
            sentAt: now,
          },
          'Recorded successful relevant article delivery'
        )

        delivered = true
        break
      }

      if (!delivered) {
        logger.debug(
          {
            event: 'news.delivery.chat.skip',
            chatId: subscription.chatId,
            skipReason: 'no_relevant_items',
            candidateCount: candidateItems.length,
          },
          'No relevant article found for chat'
        )
      }
    }

    const deliveryDuration = Date.now() - startTime
    logger.trace(
      {
        event: 'news.delivery.end',
        durationMs: deliveryDuration,
        subscriptionsProcessed: subscriptions.length,
      },
      'Delivery cycle completed'
    )
  }

  private getEligibleDeliveryTime(subscription: {
    intervalSeconds: number
    deliverAfter: Date
    lastSentAt?: Date
  }): Date {
    if (!subscription.lastSentAt) {
      return subscription.deliverAfter
    }

    const cooldownEndsAt = new Date(
      subscription.lastSentAt.getTime() + subscription.intervalSeconds * 1000
    )

    return cooldownEndsAt.getTime() > subscription.deliverAfter.getTime()
      ? cooldownEndsAt
      : subscription.deliverAfter
  }
}

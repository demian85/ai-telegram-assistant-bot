import type { Redis } from 'ioredis'
import {
  defaultNewsIntervalSeconds,
  maxNewsIntervalSeconds,
  minNewsIntervalSeconds,
  type NewsChatSubscription,
} from './types.js'

export class ChatSubscriptionStore {
  private readonly keyPrefix = 'news:chat-subscription:'
  private readonly indexKey = 'news:chat-subscriptions'

  constructor(private readonly redis: Redis) {}

  async getSubscription(chatId: string): Promise<NewsChatSubscription | null> {
    const data = await this.redis.get(this.getKey(chatId))

    if (!data) {
      return null
    }

    return this.parseSubscription(data)
  }

  async getOrCreateSubscription(
    chatId: string,
    now: Date = new Date()
  ): Promise<NewsChatSubscription> {
    const existing = await this.getSubscription(chatId)

    if (existing) {
      return existing
    }

    const subscription: NewsChatSubscription = {
      chatId,
      enabled: false,
      intervalSeconds: defaultNewsIntervalSeconds,
      createdAt: now,
      updatedAt: now,
      deliverAfter: now,
    }

    await this.saveSubscription(subscription)

    return subscription
  }

  async listEnabledSubscriptions(): Promise<NewsChatSubscription[]> {
    const chatIds = await this.redis.smembers(this.indexKey)
    const subscriptions: NewsChatSubscription[] = []

    for (const chatId of chatIds) {
      const subscription = await this.getSubscription(chatId)

      if (subscription?.enabled) {
        subscriptions.push(subscription)
      }
    }

    return subscriptions
  }

  async subscribe(
    chatId: string,
    now: Date = new Date()
  ): Promise<NewsChatSubscription> {
    const current = await this.getOrCreateSubscription(chatId, now)

    const next: NewsChatSubscription = {
      ...current,
      enabled: true,
      updatedAt: now,
      subscribedAt: now,
      deliverAfter: now,
      unsubscribedAt: undefined,
    }

    await this.saveSubscription(next)

    return next
  }

  async unsubscribe(
    chatId: string,
    now: Date = new Date()
  ): Promise<NewsChatSubscription> {
    const current = await this.getOrCreateSubscription(chatId, now)

    const next: NewsChatSubscription = {
      ...current,
      enabled: false,
      updatedAt: now,
      unsubscribedAt: now,
    }

    await this.saveSubscription(next)

    return next
  }

  async setIntervalSeconds(
    chatId: string,
    intervalSeconds: number,
    now: Date = new Date()
  ): Promise<NewsChatSubscription> {
    this.validateIntervalSeconds(intervalSeconds)

    const current = await this.getOrCreateSubscription(chatId, now)

    const next: NewsChatSubscription = {
      ...current,
      intervalSeconds,
      updatedAt: now,
    }

    await this.saveSubscription(next)

    return next
  }

  async markSent(
    chatId: string,
    sentAt: Date = new Date()
  ): Promise<NewsChatSubscription> {
    const current = await this.getOrCreateSubscription(chatId, sentAt)

    const next: NewsChatSubscription = {
      ...current,
      lastSentAt: sentAt,
      updatedAt: sentAt,
    }

    await this.saveSubscription(next)

    return next
  }

  private async saveSubscription(
    subscription: NewsChatSubscription
  ): Promise<void> {
    await this.redis.set(
      this.getKey(subscription.chatId),
      JSON.stringify(subscription)
    )
    await this.redis.sadd(this.indexKey, subscription.chatId)
  }

  private parseSubscription(data: string): NewsChatSubscription {
    const subscription = JSON.parse(data) as Omit<
      NewsChatSubscription,
      | 'createdAt'
      | 'updatedAt'
      | 'deliverAfter'
      | 'subscribedAt'
      | 'unsubscribedAt'
      | 'lastSentAt'
    > & {
      createdAt: string
      updatedAt: string
      deliverAfter: string
      subscribedAt?: string
      unsubscribedAt?: string
      lastSentAt?: string
    }

    return {
      ...subscription,
      createdAt: new Date(subscription.createdAt),
      updatedAt: new Date(subscription.updatedAt),
      deliverAfter: new Date(subscription.deliverAfter),
      subscribedAt: subscription.subscribedAt
        ? new Date(subscription.subscribedAt)
        : undefined,
      unsubscribedAt: subscription.unsubscribedAt
        ? new Date(subscription.unsubscribedAt)
        : undefined,
      lastSentAt: subscription.lastSentAt
        ? new Date(subscription.lastSentAt)
        : undefined,
    }
  }

  private validateIntervalSeconds(intervalSeconds: number): void {
    if (
      !Number.isInteger(intervalSeconds) ||
      intervalSeconds < minNewsIntervalSeconds ||
      intervalSeconds > maxNewsIntervalSeconds
    ) {
      throw new Error(
        `News interval must be an integer between ${minNewsIntervalSeconds} and ${maxNewsIntervalSeconds} seconds`
      )
    }
  }

  async deleteSubscription(chatId: string): Promise<void> {
    await this.redis.del(this.getKey(chatId))
    await this.redis.srem(this.indexKey, chatId)
  }

  private getKey(chatId: string): string {
    return `${this.keyPrefix}${chatId}`
  }
}

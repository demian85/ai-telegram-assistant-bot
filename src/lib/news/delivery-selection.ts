import type { NewsItem } from './types.js'

export const deliveryMaxAgeMs = 48 * 60 * 60 * 1000

const originalSourceDomains = [
  'openai.com',
  'anthropic.com',
  'blog.google',
  'deepmind.google',
  'ai.google.dev',
  'spacex.com',
  'bun.sh',
  'bun.com',
  'nodejs.org',
  'developer.nvidia.com',
  'aws.amazon.com',
] as const

export function prioritizeOriginalSources(
  items: readonly NewsItem[]
): NewsItem[] {
  const priority = (item: NewsItem): number => {
    if (!URL.canParse(item.url)) return 0
    const { hostname } = new URL(item.url)
    return Number(
      originalSourceDomains.some(
        (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
      )
    )
  }
  return [...items].sort((a, b) => priority(b) - priority(a))
}

export function selectDeliveryCandidates(
  items: readonly NewsItem[],
  now: Date
): NewsItem[] {
  const end = now.getTime()
  return prioritizeOriginalSources(
    items.filter((item) => {
      const published = item.publishedAt.getTime()
      return published >= end - deliveryMaxAgeMs && published <= end
    })
  )
}

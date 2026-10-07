import type { RepeatableJob } from 'bullmq'
import logger from '@lib/logger.js'

export interface RepeatableQueue {
  getRepeatableJobs(): Promise<readonly Pick<RepeatableJob, 'key' | 'name'>[]>
  removeRepeatableByKey(key: string): Promise<boolean>
}

export async function clearNewsRepeatableJobs(
  queue: RepeatableQueue
): Promise<void> {
  const jobs = await queue.getRepeatableJobs()
  for (const job of jobs) {
    if (job.name !== 'poll-news' && job.name !== 'deliver-news') continue
    await queue.removeRepeatableByKey(job.key)
    logger.debug(
      {
        event: 'news.scheduler.clean_repeatable',
        repeatableKey: job.key,
        jobName: job.name,
      },
      'Cleaned up news repeatable job'
    )
  }
}

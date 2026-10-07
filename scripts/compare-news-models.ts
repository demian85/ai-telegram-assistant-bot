import 'dotenv/config'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { Redis } from 'ioredis'
import { z } from 'zod'
import { loadAppConfig } from '../src/lib/config/load-config.js'
import {
  decisionResponseSchema,
  VeniceDecisionModel,
} from '../src/lib/llm/decision-model.js'
import { FeedReader } from '../src/lib/news/feed-reader.js'
import {
  legacyPreferenceSchema,
  newsPreferenceSchema,
  renderCriteria,
} from '../src/lib/news/preference-schema.js'
import {
  RelevanceDetector,
  type RelevanceResult,
} from '../src/lib/news/relevance-detector.js'

const selectedArticles = [
  ['https://www.latent.space/p/stacklok', true],
  ['https://cellcog.ai/blog/personal-agent-protocol/', true],
  ['https://cellcog.ai/blog/grok-bot-personal-cfo-slack-leak/', true],
  ['https://cellcog.ai/blog/claude-for-google-workspace/', true],
  [
    'https://www.kdnuggets.com/i-tested-5-ai-coding-assistants-for-a-month-heres-what-i-actually-found',
    true,
  ],
  [
    'https://machinelearningmastery.com/choosing-the-right-agentic-ai-framework-for-2026-a-decision-tree-approach/',
    true,
  ],
  [
    'https://www.wired.com/story/openai-wants-its-new-agent-to-run-your-life-mine-said-it-loved-me/',
    true,
  ],
  [
    'https://towardsdatascience.com/the-consistency-quadrant-a-visual-guide-to-llm-reliability/',
    true,
  ],
  [
    'https://towardsdatascience.com/introduction-to-reinforcement-learning-multi-armed-bandit-simulation-in-python/',
    false,
  ],
  ['https://github.com/langfuse/langfuse/releases/tag/v4.54.0', false],
] as const

const snapshotSchema = z.object({
  filter: z.object({ description: z.string(), instruction: z.string() }),
  articles: z
    .array(
      z.object({
        expected: z.boolean(),
        item: z.object({
          id: z.string(),
          title: z.string(),
          description: z.string().optional(),
          content: z.string().optional(),
          source: z.string(),
          feedUrl: z.string(),
          url: z.string().url(),
          publishedAt: z.coerce.date(),
          fetchedAt: z.coerce.date(),
        }),
      })
    )
    .min(1)
    .max(10),
})

async function fetchSnapshot(defaultFilter: string) {
  const redis = new Redis(z.string().min(1).parse(process.env.REDIS_URL), {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    connectTimeout: 5000,
  })
  const filters: { description: string; instruction: string }[] = []
  try {
    await redis.connect()
    let cursor = '0'
    do {
      const [next, keys] = await redis.scan(
        cursor,
        'MATCH',
        'news:preferences:*',
        'COUNT',
        100
      )
      cursor = next
      for (const key of keys) {
        const raw = await redis.get(key)
        const saved: unknown = JSON.parse(raw ?? 'null')
        const legacy = legacyPreferenceSchema.safeParse(saved)
        if (!legacy.success) continue
        const current = newsPreferenceSchema.safeParse(saved)
        filters.push({
          description: legacy.data.description,
          instruction: current.success
            ? renderCriteria(current.data.criteria)
            : legacy.data.description,
        })
      }
    } while (cursor !== '0')
  } finally {
    redis.disconnect()
  }
  if (filters.length > 1) {
    throw new RangeError(
      'Multiple custom filters found; provide an --input snapshot.'
    )
  }
  const filter = filters[0] ?? {
    description: defaultFilter,
    instruction: defaultFilter,
  }
  const items = await new FeedReader().fetchFeed(
    'https://planet-ai.net/rss.xml'
  )
  const articles = selectedArticles.map(([url, expected]) => {
    const item = items.find((candidate) => candidate.url === url)
    if (!item) throw new RangeError(`Article missing from feed: ${url}`)
    return { expected, item }
  })
  return snapshotSchema.parse({ filter, articles })
}

type Capture = {
  request?: unknown
  rawResponse?: unknown
  status?: number
  elapsedMs?: number
}

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: 'string' },
      output: { type: 'string' },
      help: { type: 'boolean' },
    },
  })
  if (values.help) {
    console.log(
      'Usage: node --import tsx scripts/compare-news-models.ts [--input previous-results.json] [--output results.json]\nMakes at most 10 Jev HTTP requests, with retries disabled, plus one Laya request per article. No Redis or Telegram writes. Defaults to the single saved custom filter and ten selected real RSS articles. --input replays the saved filter and articles unchanged.'
    )
    return
  }
  const config = loadAppConfig()
  const apiKey = z.string().min(1).parse(process.env[config.llm.apiKeyEnvVar])
  const snapshot = values.input
    ? snapshotSchema.parse(JSON.parse(await readFile(values.input, 'utf8')))
    : await fetchSnapshot(config.news.defaultFilter)
  const output = resolve(
    values.output ?? `artifacts/news-model-comparison-${Date.now()}.json`
  )
  let jevRequests = 0
  const capture: Capture = {}
  function createDetector(local: boolean) {
    const model = new VeniceDecisionModel({
      model: local ? 'laya-multilingual' : config.news.decisionModel,
      baseURL: local ? 'http://127.0.0.1:1337/v1' : config.llm.baseUrl,
      apiKey: local ? 'local-comparison' : apiKey,
      maxRetries: 0,
      fetch: async (input, init) => {
        if (!local && ++jevRequests > 10) {
          throw new RangeError('Jev HTTP request budget exhausted')
        }
        const url = local
          ? String(input).replace(/\/decisions$/, '/systemone')
          : String(input)
        capture.request = JSON.parse(String(init?.body))
        const start = performance.now()
        const response = await fetch(url, init)
        capture.status = response.status
        capture.rawResponse = await response.clone().json()
        capture.elapsedMs = Math.round(performance.now() - start)
        return response
      },
    })
    return new RelevanceDetector(model, {
      relevanceThreshold: config.news.relevanceThreshold,
      decisionConfidenceThreshold: config.news.decisionConfidenceThreshold,
      systemPrompt: config.llm.roles.newsRelevance.systemPrompt,
    })
  }
  const jev = createDetector(false)
  const laya = createDetector(true)
  async function evaluate(detector: RelevanceDetector, index: number) {
    for (const key of Object.keys(capture)) Reflect.deleteProperty(capture, key)
    const sample = snapshot.articles[index]
    if (!sample) throw new RangeError('Missing evaluation article')
    const result = await detector.detectRelevance(sample.item, snapshot.filter)
    const parsed = decisionResponseSchema.safeParse(capture.rawResponse)
    const validResponse = parsed.success ? parsed.data : null
    return {
      ...capture,
      validResponse,
      result,
      outcome: outcome(result, validResponse !== null),
      gateConfidence: validResponse
        ? Math.min(
            validResponse.answers.interest.confidence,
            validResponse.answers.exclusion.confidence,
            validResponse.answers.title.confidence
          )
        : null,
    }
  }
  type Evaluation = Awaited<ReturnType<typeof evaluate>>
  const rows: {
    readonly title: string
    readonly url: string
    readonly expected: boolean
    readonly jev: Evaluation
    readonly laya: Evaluation
  }[] = []
  const report = {
    startedAt: new Date().toISOString(),
    inputMode: 'title and RSS excerpt, matching FeedReader',
    labelBasis:
      'Preselected expected outcomes based on the original filter and RSS text; not an independent expert-labeled benchmark.',
    ...snapshot,
    settings: {
      jevBaseUrl: config.llm.baseUrl,
      jevModel: config.news.decisionModel ?? 'jev-latest',
      layaBaseUrl: 'http://127.0.0.1:1337/v1',
      layaModel: 'laya-multilingual',
      coverageThreshold: config.news.relevanceThreshold,
      confidenceThreshold: config.news.decisionConfidenceThreshold ?? 0.8,
      systemPrompt: config.llm.roles.newsRelevance.systemPrompt,
    },
    rows,
  }
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
  })
  for (const [index, sample] of snapshot.articles.entries()) {
    const jevResult = await evaluate(jev, index)
    const layaResult = await evaluate(laya, index)
    rows.push({
      title: sample.item.title,
      url: sample.item.url,
      expected: sample.expected,
      jev: jevResult,
      laya: layaResult,
    })
    await writeFile(
      output,
      JSON.stringify({ ...report, jevRequests }, null, 2) + '\n'
    )
    console.log(
      JSON.stringify({
        title: sample.item.title,
        expected: sample.expected,
        jev: jevResult.outcome,
        laya: layaResult.outcome,
      })
    )
  }
  console.log(JSON.stringify({ output, jevRequests, articles: rows.length }))
}

function outcome(result: RelevanceResult | null, validResponse: boolean) {
  if (result) return result.isRelevant ? 'approve' : 'reject'
  return validResponse ? 'uncertain' : 'provider-error'
}

await main()

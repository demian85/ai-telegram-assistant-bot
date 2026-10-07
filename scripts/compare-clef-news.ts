import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import {
  decisionResponseSchema,
  VeniceDecisionModel,
} from '../src/lib/llm/decision-model.js'
import {
  RelevanceDetector,
  type RelevanceResult,
} from '../src/lib/news/relevance-detector.js'

const outcomeSchema = z.enum([
  'approve',
  'reject',
  'uncertain',
  'provider-error',
])
const baselineSchema = z.object({
  filter: z.object({ description: z.string(), instruction: z.string() }),
  settings: z.object({
    coverageThreshold: z.number(),
    confidenceThreshold: z.number(),
    systemPrompt: z.string(),
  }),
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
  rows: z.array(
    z.object({
      url: z.string().url(),
      jev: z.object({
        request: z.unknown(),
        outcome: outcomeSchema,
        validResponse: decisionResponseSchema,
      }),
      laya: z.object({
        outcome: outcomeSchema,
        validResponse: decisionResponseSchema,
      }),
    })
  ),
})
type Capture = {
  request?: unknown
  rawResponse?: unknown
  status?: number
  elapsedMs?: number
}

async function main() {
  const { values } = parseArgs({
    options: {
      input: {
        type: 'string',
        default: 'artifacts/news-model-comparison-2026-10-07.json',
      },
      output: {
        type: 'string',
        default: `artifacts/clef-news-comparison-${Date.now()}.json`,
      },
      'base-url': { type: 'string', default: 'http://127.0.0.1:3785/v1' },
      help: { type: 'boolean' },
    },
  })
  if (values.help) {
    console.log(
      'Usage: node --import tsx scripts/compare-clef-news.ts [--input baseline.json] [--output results.json] [--base-url http://127.0.0.1:3785/v1]\nReplays up to ten saved articles against ggml-org/Clef-Flash-Q4_K_M using native /systemone inference. Jev and Laya results are reused; no remote provider, Redis, or Telegram calls are made. Requires a running Clef-capable llama.cpp server.'
    )
    return
  }
  const baselineFile = resolve(values.input)
  const parsedBaseline = baselineSchema.safeParse(
    JSON.parse(await readFile(baselineFile, 'utf8'))
  )
  if (!parsedBaseline.success) {
    throw new RangeError(
      'Baseline does not match the current eligibility/coverage contract. Record a new baseline with scripts/compare-news-models.ts before replaying Clef.',
      { cause: parsedBaseline.error }
    )
  }
  const baseline = parsedBaseline.data
  const model = 'ggml-org/Clef-Flash-Q4_K_M'
  const baseUrl = z.string().url().parse(values['base-url'])
  const modelsResponse = await fetch(`${baseUrl}/models`, {
    signal: AbortSignal.timeout(5000),
  })
  if (!modelsResponse.ok)
    throw new RangeError(`Model discovery failed: ${modelsResponse.status}`)
  const discovery = z
    .object({ data: z.array(z.object({ id: z.string() })) })
    .parse(await modelsResponse.json())
  if (!discovery.data.some((entry) => entry.id === model)) {
    throw new RangeError(
      'The endpoint does not advertise the requested Clef model'
    )
  }
  const capture: Capture = {}
  const client = new VeniceDecisionModel({
    model,
    baseURL: baseUrl,
    apiKey: 'local-comparison',
    maxRetries: 0,
    timeout: 60_000,
    fetch: async (input, init) => {
      capture.request = JSON.parse(String(init?.body))
      const start = performance.now()
      const response = await fetch(
        String(input).replace(/\/decisions$/, '/systemone'),
        init
      )
      capture.status = response.status
      capture.rawResponse = await response.clone().json()
      capture.elapsedMs = Math.round(performance.now() - start)
      return response
    },
  })
  const detector = new RelevanceDetector(client, {
    relevanceThreshold: baseline.settings.coverageThreshold,
    decisionConfidenceThreshold: baseline.settings.confidenceThreshold,
    systemPrompt: baseline.settings.systemPrompt,
  })
  const rows: {
    readonly title: string
    readonly url: string
    readonly expected: boolean
    readonly jev: string
    readonly laya: string
    readonly clef: string
    readonly result: RelevanceResult | null
    readonly capture: Capture
    readonly score: number | null
    readonly gateConfidence: number | null
    readonly identicalInput: boolean
  }[] = []
  const output = resolve(values.output)
  const report = {
    startedAt: new Date().toISOString(),
    baselineFile,
    model,
    baseUrl,
    settings: baseline.settings,
    additionalJevRequests: 0,
    inferenceMode:
      'Native Clef joint decision head through llama.cpp /systemone; no chat JSON emulation.',
    rows,
  }
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
  })
  for (const sample of baseline.articles) {
    const previous = baseline.rows.find((row) => row.url === sample.item.url)
    if (!previous) throw new RangeError('Missing recorded baseline article')
    for (const key of Object.keys(capture)) Reflect.deleteProperty(capture, key)
    const result = await detector.detectRelevance(sample.item, baseline.filter)
    const parsed = decisionResponseSchema.safeParse(capture.rawResponse)
    if (parsed.success && parsed.data.model !== model) {
      throw new RangeError(
        `Model identity mismatch: received ${parsed.data.model}`
      )
    }
    const request = z
      .object({ state: z.unknown(), questions: z.unknown() })
      .parse(capture.request)
    const oldRequest = z
      .object({ state: z.unknown(), questions: z.unknown() })
      .parse(previous.jev.request)
    const identicalInput =
      JSON.stringify(request) === JSON.stringify(oldRequest)
    if (!identicalInput)
      throw new RangeError(
        'Article input or questions differ from the Jev baseline'
      )
    const clef = result
      ? result.isRelevant
        ? 'approve'
        : 'reject'
      : parsed.success
        ? 'uncertain'
        : 'provider-error'
    rows.push({
      title: sample.item.title,
      url: sample.item.url,
      expected: sample.expected,
      jev: previous.jev.outcome,
      laya: previous.laya.outcome,
      clef,
      result,
      capture: { ...capture },
      identicalInput,
      score: parsed.success
        ? Math.round(parsed.data.answers.relevance.score * 20)
        : null,
      gateConfidence: parsed.success
        ? parsed.data.answers.eligibility.confidence
        : null,
    })
    await writeFile(output, JSON.stringify(report, null, 2) + '\n')
    console.log(
      JSON.stringify(rows.at(-1), (key, value: unknown) =>
        key === 'capture' ? undefined : value
      )
    )
  }
  console.log(
    JSON.stringify({ output, articles: rows.length, additionalJevRequests: 0 })
  )
}

await main()

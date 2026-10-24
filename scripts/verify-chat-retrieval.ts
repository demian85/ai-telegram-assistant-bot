import 'dotenv/config'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import OpenAI from 'openai'
import { ChatOpenAI } from '@langchain/openai'
import { loadAppConfig } from '../src/lib/config/load-config.js'
import { createLlmRoleModels } from '../src/lib/llm/model.js'
import {
  providerOptions,
  noSearch,
  assertChatCapabilities,
} from '../src/lib/llm/provider-options.js'
import { citedResponse } from '../src/lib/llm/response.js'
import {
  ChatRetrieval,
  createRetrievalTools,
} from '../src/lib/agent/retrieval.js'
import { InMemoryRedis } from '../test/test-helpers.js'

const config = loadAppConfig()
const apiKey = process.env[config.llm.apiKeyEnvVar]
if (!apiKey) throw new Error('Configured provider key is missing')
const client = new OpenAI({
  apiKey,
  baseURL: config.llm.baseUrl,
  maxRetries: 0,
  timeout: 60_000,
})
const catalog = await client.models.list()
assertChatCapabilities(config, catalog)
const entry = catalog.data.find(
  (model) => model.id === config.llm.roles.chat.model
)
if (!entry)
  throw new Error('Configured chat model is absent from the live catalog')
const toolsOnly = process.argv.includes('--tools-only')
const outputPath = path.join(
  mkdtempSync(path.join(tmpdir(), 'chat-retrieval-')),
  'results.json'
)
console.log(`Verification output: ${outputPath}`)
const records: Record<string, unknown>[] = [{ kind: 'catalog', entry }]
function probeModel(search: Parameters<typeof providerOptions>[1]) {
  return new ChatOpenAI({
    model: config.llm.roles.chat.model,
    apiKey,
    configuration: { baseURL: config.llm.baseUrl },
    modelKwargs: providerOptions(config, search),
    maxRetries: 0,
    timeout: 90_000,
    maxTokens: 650,
    __includeRawResponse: true,
  })
}
async function probe(
  kind: string,
  model: ChatOpenAI,
  prompt: string,
  reference?: string
) {
  const started = Date.now()
  const response = await model.invoke(
    [
      {
        role: 'system',
        content:
          reference ??
          'Use the requested retrieval feature. Cite actual sources. Be concise and report retrieval failures honestly.',
      },
      { role: 'user', content: prompt },
    ],
    { promptCacheKey: 'chat-retrieval-live-verification-v1' }
  )
  const raw = response.additional_kwargs.__raw_response
  records.push({
    kind,
    milliseconds: Date.now() - started,
    usage: response.usage_metadata,
    raw,
    rendered: citedResponse(response),
  })
  writeFileSync(outputPath, JSON.stringify(records, null, 2) + '\n')
  console.log(
    JSON.stringify({
      kind,
      milliseconds: Date.now() - started,
      usage: response.usage_metadata,
      answer: citedResponse(response),
    })
  )
}
if (!toolsOnly) {
  await probe(
    'x-only',
    probeModel({ ...noSearch, x: true, citations: true }),
    'Search X for two recent public posts by @xai. Return the exact post URLs and dates, and a brief description.'
  )
  await probe(
    'web-only',
    probeModel({ ...noSearch, web: 'on', citations: true }),
    'Search the web for the Venice prompt caching documentation. Cite its URL and state its documented Grok cache lifetime.'
  )
  await probe(
    'scrape-only',
    probeModel({ ...noSearch, scrape: true, citations: true }),
    'Read https://docs.venice.ai/guides/features/prompt-caching and report the Grok cache lifetime and minimum token count stated on that page.'
  )
  const reference = readFileSync('README.md', 'utf8')
  const cacheModel = probeModel(noSearch)
  await probe(
    'cache-cold',
    cacheModel,
    'List the setup commands from this reference. Keep the answer under 50 words.',
    reference
  )
  await probe(
    'cache-warm',
    cacheModel,
    'List the setup commands from this reference. Keep the answer under 50 words.',
    reference
  )
}
const models = createLlmRoleModels(config)
const retrieval = new ChatRetrieval(
  models.retrieval,
  new InMemoryRedis().asRedis(),
  models.reader
)
const reader = createRetrievalTools(retrieval, { search: false, read: true })[0]
if (!reader) throw new Error('Read tool missing')
const invocation = {
  configurable: {
    purpose: 'chat',
    chatScope: 'private:1',
    retrievalBudget: { remaining: 3 },
  },
}
const first = await reader.invoke(
  { url: 'https://docs.venice.ai/guides/features/prompt-caching' },
  invocation
)
const second = await reader.invoke(
  { url: 'https://docs.venice.ai/guides/features/prompt-caching' },
  invocation
)
records.push({
  kind: 'retrieval-tool-cache',
  identical: first === second,
  answer: second,
})
writeFileSync(outputPath, JSON.stringify(records, null, 2) + '\n')

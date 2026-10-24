import { afterEach, expect, test, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadAppConfig } from '../src/lib/config/load-config.js'
import { createLlmRoleModels } from '../src/lib/llm/model.js'
import {
  noSearch,
  validateChatCapabilities,
} from '../src/lib/llm/provider-options.js'

const directories: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

test.each([false, true, undefined])(
  'keeps omitted native search disabled for legacy supportsWebSearch=%s',
  async (supportsWebSearch) => {
    const { rootDir, config } = configuration()
    const {
      search: _search,
      supportsWebSearch: _capability,
      ...chat
    } = config.llm.roles.chat
    writeFileSync(
      path.join(rootDir, 'config.json'),
      JSON.stringify({
        ...config,
        llm: {
          ...config.llm,
          roles: {
            ...config.llm.roles,
            chat: {
              ...chat,
              model: 'legacy-chat-model',
              ...(supportsWebSearch === undefined ? {} : { supportsWebSearch }),
            },
          },
        },
      })
    )
    vi.stubEnv(config.llm.apiKeyEnvVar, 'offline')
    const fetch = vi.fn(() => {
      throw new Error('Unexpected capability request')
    })
    vi.stubGlobal('fetch', fetch)
    const resolved = loadAppConfig({ rootDir })
    const models = createLlmRoleModels(resolved)
    expect(resolved.llm.roles.chat.search).toBeUndefined()
    expect(models.chat.modelKwargs).toMatchObject({
      venice_parameters: {
        enable_web_search: 'off',
        enable_x_search: false,
        enable_web_scraping: false,
      },
    })
    await validateChatCapabilities(resolved)
    expect(fetch).not.toHaveBeenCalled()
  }
)

test('infers the provider from a legacy override URL instead of inheriting the defaults provider', async () => {
  const { rootDir, config } = configuration()
  const { provider: _provider, ...llm } = config.llm
  writeFileSync(
    path.join(rootDir, 'config.json'),
    JSON.stringify({
      ...config,
      llm: {
        ...llm,
        baseUrl: 'https://compatible.example/v1',
        roles: { ...llm.roles, chat: { ...llm.roles.chat, search: noSearch } },
      },
    })
  )
  vi.stubEnv(config.llm.apiKeyEnvVar, 'offline')
  const fetch = vi.fn(() => {
    throw new Error('Unexpected catalog request')
  })
  vi.stubGlobal('fetch', fetch)
  const resolved = loadAppConfig({ rootDir })
  const models = createLlmRoleModels(resolved)
  expect(models.chat.clientConfig.baseURL).toBe('https://compatible.example/v1')
  expect(models.chat.modelKwargs).toEqual({})
  expect(models.summarizer.modelKwargs).toEqual({})
  expect(models.newsPreferences.modelKwargs).toEqual({})
  await validateChatCapabilities(resolved)
  expect(fetch).not.toHaveBeenCalled()
})

function configuration() {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'modern-config-'))
  directories.push(rootDir)
  writeFileSync(
    path.join(rootDir, 'config.defaults.json'),
    readFileSync('config.sample.json', 'utf8')
  )
  return { rootDir, config: loadAppConfig({ rootDir }) }
}

test.each(['venice', 'openai-compatible'] as const)(
  'preserves an explicit %s provider and explicit search settings',
  (provider) => {
    const { rootDir, config } = configuration()
    writeFileSync(
      path.join(rootDir, 'config.json'),
      JSON.stringify({
        ...config,
        llm: {
          ...config.llm,
          provider,
          roles: {
            ...config.llm.roles,
            chat: { ...config.llm.roles.chat, search: noSearch },
          },
        },
      })
    )
    const resolved = loadAppConfig({ rootDir })
    expect(resolved.llm.provider).toBe(provider)
    expect(resolved.llm.roles.chat.search).toEqual(noSearch)
  }
)

test('preserves enabled defaults without a nonempty override and explicit opt-in with one', () => {
  const { rootDir, config } = configuration()
  expect(config.llm.roles.chat.search?.x).toBe(true)
  writeFileSync(path.join(rootDir, 'config.json'), '{}')
  expect(loadAppConfig({ rootDir }).llm.roles.chat.search).toEqual(
    config.llm.roles.chat.search
  )
  writeFileSync(path.join(rootDir, 'config.json'), JSON.stringify(config))
  expect(loadAppConfig({ rootDir }).llm.roles.chat.search).toEqual(
    config.llm.roles.chat.search
  )
})

test('loads complete modern overrides without obsolete model and capability properties', () => {
  // Given
  const { rootDir, config } = configuration()
  writeFileSync(
    path.join(rootDir, 'config.json'),
    JSON.stringify({
      ...config,
      news: {
        ...config.news,
        relevanceThreshold: 75,
        defaultFilter: 'Developer tools and coding agents',
      },
      llm: {
        ...config.llm,
        roles: {
          ...config.llm.roles,
          chat: { ...config.llm.roles.chat, model: 'custom-chat-model' },
        },
      },
    })
  )
  // When
  const resolved = loadAppConfig({ rootDir })
  // Then
  expect(resolved.llm).not.toHaveProperty('defaultModel')
  expect(resolved.llm.roles).not.toHaveProperty('newsRelevance')
  expect(resolved.llm.roles.chat.model).toBe('custom-chat-model')
  expect(resolved.news).toMatchObject({
    relevanceThreshold: 75,
    defaultFilter: 'Developer tools and coding agents',
    decisionModel: 'jev-latest',
  })
})

test.each(['defaults', 'override'])(
  'requires an explicit preference role in %s config',
  (source) => {
    // Given
    const { rootDir, config } = configuration()
    const { newsPreferences: _preferences, ...roles } = config.llm.roles
    if (source === 'defaults') {
      writeFileSync(path.join(rootDir, 'config.json'), JSON.stringify(config))
    }
    writeFileSync(
      path.join(
        rootDir,
        source === 'defaults' ? 'config.defaults.json' : 'config.json'
      ),
      JSON.stringify({ ...config, llm: { ...config.llm, roles } })
    )
    // When
    const load = () => loadAppConfig({ rootDir })
    // Then
    expect(load).toThrow(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: 'invalid_type',
            path: ['llm', 'roles', 'newsPreferences'],
          }),
        ]),
      })
    )
  }
)

test.each(['defaults', 'override'])(
  'rejects the removed news relevance config role in %s config',
  (source) => {
    const { rootDir, config } = configuration()
    const filename =
      source === 'defaults' ? 'config.defaults.json' : 'config.json'
    writeFileSync(
      path.join(rootDir, filename),
      JSON.stringify({
        ...config,
        llm: {
          ...config.llm,
          roles: {
            ...config.llm.roles,
            newsRelevance: { systemPrompt: 'retired-prompt' },
          },
        },
      })
    )
    const load = () => loadAppConfig({ rootDir })
    expect(load).toThrow(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: 'unrecognized_keys',
            path: ['llm', 'roles'],
            keys: ['newsRelevance'],
          }),
        ]),
      })
    )
  }
)

test.each(['defaults', 'override'])(
  'rejects the retired default LLM model in %s config',
  (source) => {
    // Given
    const { rootDir, config } = configuration()
    const filename =
      source === 'defaults' ? 'config.defaults.json' : 'config.json'
    writeFileSync(
      path.join(rootDir, filename),
      JSON.stringify({
        ...config,
        llm: { ...config.llm, defaultModel: 'old-model' },
      })
    )
    // When
    const load = () => loadAppConfig({ rootDir })
    // Then
    expect(load).toThrow(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: 'unrecognized_keys',
            path: ['llm'],
            keys: ['defaultModel'],
          }),
        ]),
      })
    )
  }
)

test.each(['defaults', 'override'])(
  'rejects retired news topics in %s config',
  (source) => {
    // Given
    const { rootDir, config } = configuration()
    const filename =
      source === 'defaults' ? 'config.defaults.json' : 'config.json'
    writeFileSync(
      path.join(rootDir, filename),
      JSON.stringify({ ...config, news: { ...config.news, topics: ['AI'] } })
    )
    // When
    const load = () => loadAppConfig({ rootDir })
    // Then
    expect(load).toThrow(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: 'unrecognized_keys',
            path: ['news'],
            keys: ['topics'],
          }),
        ]),
      })
    )
  }
)

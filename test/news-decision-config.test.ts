import { afterEach, expect, test, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadAppConfig } from '../src/lib/config/load-config.js'
import { createLlmRoleModels } from '../src/lib/llm/model.js'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

function configuration(news: Record<string, unknown>) {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'news-decision-config-'))
  directories.push(rootDir)
  writeFileSync(
    path.join(rootDir, 'config.defaults.json'),
    readFileSync('config.sample.json', 'utf8')
  )
  const defaults = loadAppConfig({ rootDir })
  const {
    decisionModel: _model,
    decisionConfidenceThreshold: _confidence,
    ...legacyNews
  } = defaults.news
  writeFileSync(
    path.join(rootDir, 'config.json'),
    JSON.stringify({
      ...defaults,
      news: { ...legacyNews, ...news },
    })
  )
  return loadAppConfig({ rootDir })
}

test('existing complete overrides inherit Jev without changing generative role models', () => {
  // Given
  const config = configuration({})
  vi.stubEnv(config.llm.apiKeyEnvVar, 'offline-key')
  // When
  const models = createLlmRoleModels(config)
  // Then
  expect(models.newsRelevance.model).toBe('jev-latest')
  expect(models.newsRelevance.baseUrl).toBe(config.llm.baseUrl)
  expect(models.chat.model).toBe(config.llm.roles.chat.model)
  expect(models.summarizer.model).toBe(config.llm.roles.summarizer.model)
  expect(models.newsPreferences.model).toBe(
    config.llm.roles.newsPreferences.model
  )
  expect(config.news.decisionConfidenceThreshold).toBe(0.8)
})

test('uses a separate configured decision model and confidence threshold', () => {
  // Given
  const config = configuration({
    decisionModel: 'jev-custom',
    decisionConfidenceThreshold: 0.95,
  })
  vi.stubEnv(config.llm.apiKeyEnvVar, 'offline-key')
  // When
  const models = createLlmRoleModels(config)
  // Then
  expect(models.newsRelevance.model).toBe('jev-custom')
  expect(config.news.decisionConfidenceThreshold).toBe(0.95)
})

test.each([
  { decisionModel: '' },
  { decisionModel: '   ' },
  { decisionModel: 42 },
  { decisionConfidenceThreshold: -0.1 },
  { decisionConfidenceThreshold: 1.1 },
  { decisionConfidenceThreshold: '0.8' },
])('rejects invalid decision configuration: %j', (news) => {
  // Given / When / Then
  expect(() => configuration(news)).toThrow()
})

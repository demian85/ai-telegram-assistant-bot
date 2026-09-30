# Tests

## Test map

| Behavior                                                               | File                                                    |
| ---------------------------------------------------------------------- | ------------------------------------------------------- |
| Message routing, vision fallback, group admin commands                 | `telegram-routing.test.ts`                              |
| Normalized conversation scope                                          | `telegram-scope.test.ts`                                |
| Telegram reply/news formatting                                         | `telegram-util.test.ts`                                 |
| Live multimodal input and persisted text shadows                       | `agent-content.test.ts`, `agent-memory.test.ts`         |
| Conversation persistence                                               | `conversation-store.test.ts`                            |
| Summary levels, clearing, message counts                               | `summary-store.test.ts`                                 |
| Subscription cadence, delivery isolation, rollback                     | `news-subscriptions.test.ts`                            |
| Config validation and merge behavior                                   | `config-loading.test.ts`, `config-load-config.test.mjs` |
| Filter generation corruption and legacy migration                      | `news-filter-regression.test.ts`                        |
| Shared doubles and update builders                                     | `test-helpers.ts`                                       |
| Preference persistence, model schema, exclusion gates, cache revisions | `news-filter.test.ts`, `news-filter-helpers.ts`         |
| Shared scheduling/query/tool filtering and stale results               | `news-filter-paths.test.ts`                             |

## Harness conventions

- Vitest discovers `test/**/*.test.ts` and `test/**/*.test.mjs` in the Node environment.
- Reuse `InMemoryRedis`, `FakeTelegraf`, `createTextUpdate`, and `createPhotoUpdate`.
- Routing tests construct `Bot` with injected Redis, Telegraf, agent, and subscription services.
- News tests inject a relevance detector and `createNoopQueue`/`createNoopWorker` instead of starting BullMQ.
- Use fixed dates for delivery eligibility, cooldown, and resubscription assertions.
- `captureLoggerRecords` captures structured event fields and restores logger methods in `finally`.

## Limits of the doubles

- `InMemoryRedis.setex` stores values without expiration; these tests do not prove TTL behavior.
- Queue and worker doubles do not schedule or execute jobs.
- `FakeTelegraf.on` assigns text, photo, then inline-query handlers by registration order; it ignores filters.
- If handler registration changes, review the fake alongside the routing tests.
- `createTextUpdate` supplies a leading command entity automatically unless explicitly overridden.
- Passing these tests does not verify Telegram transport, live Redis behavior, or provider responses. `npm run news:evaluate` separately exercises the configured provider against nine labeled cases.

## Config tests

- Create temporary config directories and pass `loadAppConfig({ rootDir })`.
- Keep fixtures self-contained and remove temporary directories after each case.
- Preserve both test formats; the `.mjs` suite uses `createRequire` to load the TypeScript loader.
- Cover required defaults, optional overrides, validation errors, and object/array merge behavior.

## Focused commands

Run from the repository root:

```bash
npm test -- test/telegram-routing.test.ts
npm test -- test/news-subscriptions.test.ts
npm test -- test/config-loading.test.ts test/config-load-config.test.mjs
```

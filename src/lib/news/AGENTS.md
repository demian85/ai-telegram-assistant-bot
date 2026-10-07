# News

## Source map

| File                         | Responsibility                                                            |
| ---------------------------- | ------------------------------------------------------------------------- |
| `scheduler.ts`               | BullMQ jobs, eligibility, relevance cache, send callback                  |
| `feed-reader.ts`             | Feed extraction and per-instance URL deduplication                        |
| `news-store.ts`              | Article records and fetched-time index                                    |
| `news-query-service.ts`      | Cached and on-demand news queries                                         |
| `relevance-detector.ts`      | Structured semantic match/exclusion/score decisions                       |
| `relevance-questions.ts`     | Model-independent semantic questions and coverage rubric                  |
| `preferences.ts`             | Structured criteria generation, durable records, legacy/default migration |
| `preference-schema.ts`       | Criteria validation, source grounding, instruction rendering              |
| `chat-news-filter.ts`        | Shared versioned decision cache and evaluation                            |
| `chat-subscription-store.ts` | Enabled state, cadence, delivery timestamps                               |
| `news-delivery-store.ts`     | Per-chat article delivery records and rollback                            |
| `types.ts`, `index.ts`       | Shared contracts, cadence bounds, public exports                          |

## Scheduled flow

- The `news-polling` queue handles `poll-news` and `deliver-news`; startup registers immediate and repeating jobs.
- Startup removes existing news repeatable registrations by their BullMQ keys before registering the configured cadence; cleanup errors prevent new registrations.
- Polling fetches feeds, caps results with `maxArticlesPerPoll`, and stores new articles without scoring them.
- Delivery loads enabled subscriptions, checks cadence, then evaluates eligible articles against each chat's resolved instruction.
- Subscription and delivery stores use raw Telegram chat IDs. Do not pass conversation keys such as `group:<id>`.
- Delivery considers articles fetched since `deliverAfter`, oldest first, skipping articles already delivered to that chat.
- Send at most one relevant article per chat per cycle. Eligibility is the later of `deliverAfter` and `lastSentAt + interval`.
- Write the delivery record before calling Telegram; remove it if the callback throws. Update `lastSentAt` only after success.
- A send failure is rethrown and stops the current delivery cycle.

## Subscription and query contracts

- New subscriptions are disabled; default cadence is 300 seconds, with integer bounds of 300-86400 seconds.
- Subscribe/resubscribe resets `deliverAfter`; interval and preference updates preserve the enabled state.
- Without a saved preference record, legacy subscription topics migrate once using Redis SET NX. Otherwise use `news.defaultFilter`. Existing custom records and reset markers take precedence. Migration leaves subscription data unchanged.
- Original descriptions are authoritative and always passed to the relevance model. Legacy unstructured records use their original text as the active instruction.
- New custom records contain version 2 structured interests, exclusions, and titleRules. Each rule cites exact sourceText from the original description; validate before saving and render the instruction in application code.
- Telegram `/news`, `/summary`, and the agent's feed tool pass raw chat IDs into query methods. All share the same filter used for delivery; there is no unfiltered fallback.
- `/news` can fetch fresh feeds; `/summary` uses cached articles fetched in the last 24 hours and invokes the chat agent. Queries inspect at most 50 candidates and return at most 10 matches.
- Article title, description, and content are preserved across query and scheduled scoring. Exclusions and missing substantive matches reject an article regardless of score.
- Article evaluation uses the configured provider's typed `/decisions` API with `news.decisionModel`, sharing `llm.baseUrl` and its configured API key. Venice and `jev-latest` are suggested defaults; other models/providers must implement the same Choice/Score contract. Preference extraction remains generative.
- Interest, exclusion, and title Choice gates have a separate confidence threshold (default 0.8). Confident rejections override uncertainty elsewhere; unresolved decisions are withheld and uncached. The six-level Score position maps to a 0-100 coverage score independently of confidence. `news.relevanceThreshold` remains the required minimum coverage score.
- Preference updates during scoring discard stale results before sending/returning. Model errors return no decision and are not cached.

## Redis behavior and verification

- Article values expire after 7 days; the `news:items` index is scored by `fetchedAt`, not publication time.
- Preferences use `news:preferences:<chatId>` with no application expiry, independently of subscription records. Custom records retain description, criteria, instruction, revision, model, and generation time.
- Complete decisions expire after 14 days. Keys include chat/article identity plus a hash of preference revision/original description/instruction, model/provider, API version, question/rubric definitions, confidence/coverage thresholds, and article content. Legacy chat-model and score-only keys are bypassed.
- Unresolved evaluations remain withheld and are not cached as decisions. Separate retry metadata persists for 14 days: at most three evaluations per fingerprint, with 15-minute and one-hour cooldowns. Preference, model/config, and article-content changes receive independent budgets. Concurrent evaluations of the same fingerprint share one promise in the shared filter instance.
- `news.decision.request` records actual provider evaluations and attempt numbers at info level. Cache hits, retry skips, and per-article delivery scores are debug events.
- Delivery values expire after 30 days. Article and delivery indexes do not receive matching expiry.
- `legacyBroadcastedAt` and global relevance helpers remain compatibility surfaces; scheduled delivery uses per-chat records.
- `test/news-subscriptions.test.ts` covers defaults, cadence validation, resubscribe gates, chat isolation, oldest-first delivery, cooldowns, and callback rollback.
- `test/telegram-routing.test.ts` covers group subscription authorization.
- Tests inject Redis, feed/scoring, queue, and worker doubles; use `test/test-helpers.ts` for shared fixtures.

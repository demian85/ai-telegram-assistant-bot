# News

Per-chat preferences and shared decisions filter feed queries and scheduled delivery; BullMQ manages polling and cadence.

## Source map

| File                         | Responsibility                                                            |
| ---------------------------- | ------------------------------------------------------------------------- |
| `scheduler.ts`               | BullMQ jobs, eligibility, delivery evaluation, send callback              |
| `repeatable-jobs.ts`         | News-only repeatable registration cleanup by BullMQ key                   |
| `feed-reader.ts`             | Feed extraction and per-instance URL deduplication                        |
| `news-store.ts`              | Article records and fetched-time index                                    |
| `news-query-service.ts`      | Cached and on-demand news queries                                         |
| `relevance-detector.ts`      | Combined eligibility and unrounded coverage decisions                     |
| `relevance-questions.ts`     | Model-independent semantic questions and coverage rubric                  |
| `preferences.ts`             | Structured criteria generation, durable records, legacy/default migration |
| `preference-schema.ts`       | Criteria validation, source grounding, instruction rendering              |
| `chat-news-filter.ts`        | Shared versioned decision cache and evaluation                            |
| `chat-subscription-store.ts` | Enabled state, cadence, delivery timestamps                               |
| `news-delivery-store.ts`     | Per-chat article delivery records and rollback                            |
| `types.ts`, `index.ts`       | Shared contracts, cadence bounds, public exports                          |

## Scheduled flow

- The `news-polling` queue handles `poll-news` and `deliver-news`; startup registers immediate and repeating jobs.
- Startup removes only `poll-news` and `deliver-news` repeatable registrations by BullMQ key, preserving unrelated jobs. Listing or removal failure prevents all immediate and repeating jobs from being enqueued.
- Polling fetches feeds, caps results with `maxArticlesPerPoll`, and stores new articles without scoring them.
- Delivery loads enabled subscriptions, checks cadence, then evaluates eligible articles against each chat's resolved instruction.
- Delivery considers articles fetched since `deliverAfter`, oldest first, skipping articles already delivered to that chat.
- Send at most one relevant article per chat per cycle. Eligibility is the later of `deliverAfter` and `lastSentAt + interval`.
- Write the delivery record before calling Telegram; remove it if the callback throws. Update `lastSentAt` only after success.
- A send failure is rethrown and stops the current delivery cycle.

## Subscription and query contracts

- New subscriptions are disabled; default cadence is 300 seconds, with integer bounds of 300-86400 seconds.
- Subscribe/resubscribe resets `deliverAfter`; interval and preference updates preserve the enabled state.
- Without a saved preference record, legacy subscription topics migrate once using Redis SET NX. Otherwise use `news.defaultFilter`. Existing custom records and reset markers take precedence. Migration leaves subscription data unchanged.
- Legacy unstructured preference records use their original text as the active instruction.
- New custom records contain version 2 structured interests, exclusions, and titleRules. Each rule cites exact sourceText from the original description; validate before saving and render compact display sections in application code. Existing records render compactly without rewriting their original description, criteria, or revision.
- Queries have no unfiltered fallback.
- `/news` can fetch fresh feeds; `/summary` uses cached articles fetched in the last 24 hours and invokes the chat agent. Queries inspect at most 50 candidates and return at most 10 matches.
- Relevance evaluates bounded title and description together; original preferences are sent once, and compiled instructions and article bodies are omitted. Explicit title requirements apply only to titles. Missing substantive matches or explicit preference violations make an article ineligible regardless of score.
- One eligibility Choice has a confidence threshold (default 0.8); uncertain acceptances and rejections are withheld and uncached. The six-level Score position maps to unrounded 0-100 coverage independently of confidence. Compare that unrounded value against `news.relevanceThreshold`, retain it in the cache, and round only for display.
- Preference updates during scoring discard stale results before sending/returning. Model errors return no decision and are not cached.

## Redis behavior

- Article values expire after 7 days; the `news:items` index is scored by `fetchedAt`, not publication time.
- Preferences use `news:preferences:<chatId>` with no application expiry, independently of subscription records. Custom records retain description, criteria, instruction, revision, model, and generation time.
- Complete decisions expire after 14 days. Keys include chat/article identity plus a hash of preference revision/original description, model/provider, decision version, question/rubric definitions, confidence/coverage thresholds, and evaluated title/description. Legacy four-question, chat-model and score-only keys are bypassed.
- Unresolved evaluations remain withheld and are not cached as decisions. Separate retry metadata persists for 14 days: at most three evaluations per fingerprint, with 15-minute and one-hour cooldowns. Preference, model/config, and article-content changes receive independent budgets. Concurrent evaluations of the same fingerprint share one promise in the shared filter instance.
- `news.decision.request` records actual provider evaluations and attempt numbers at info level. Cache hits, retry skips, and per-article delivery scores are debug events.
- Delivery values expire after 30 days. Article and delivery indexes do not receive matching expiry.
- `legacyBroadcastedAt` and global relevance helpers remain compatibility surfaces; scheduled delivery uses per-chat records.

## Verification

| Behavior                                                         | Test file                             |
| ---------------------------------------------------------------- | ------------------------------------- |
| Shared delivery/query/summary/tool preferences and stale results | `test/news-filter-paths.test.ts`      |
| Decision HTTP contract, eligibility confidence and raw coverage  | `test/news-decisions.test.ts`         |
| Generator corruption, source grounding and legacy migration      | `test/news-filter-regression.test.ts` |
| Persistent retry budgets, cooldowns and concurrent evaluations   | `test/news-filter-retries.test.ts`    |
| Repeat schedule replacement, unrelated jobs and cleanup failure  | `test/news-scheduler.test.ts`         |
| Defaults, cadence, isolation, ordering, cooldowns and rollback   | `test/news-subscriptions.test.ts`     |
| Group subscription and preference authorization                  | `test/telegram-routing.test.ts`       |

Use injected Redis, feed/scoring, queue and worker doubles from `test/test-helpers.ts`; these do not prove live scheduling or transport.

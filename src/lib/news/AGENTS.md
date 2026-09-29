# News

## Source map

| File                         | Responsibility                                                                |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `scheduler.ts`               | BullMQ jobs, eligibility, relevance cache, send callback                      |
| `feed-reader.ts`             | Feed extraction and per-instance URL deduplication                            |
| `news-store.ts`              | Article records and fetched-time index                                        |
| `news-query-service.ts`      | Cached and on-demand news queries                                             |
| `relevance-detector.ts`      | Structured semantic match/exclusion/score decisions                           |
| `preferences.ts`             | Instruction generation, durable preference records, legacy/default resolution |
| `chat-news-filter.ts`        | Shared versioned decision cache and evaluation                                |
| `chat-subscription-store.ts` | Enabled state, cadence, topics, delivery timestamps                           |
| `news-delivery-store.ts`     | Per-chat article delivery records and rollback                                |
| `types.ts`, `index.ts`       | Shared contracts, cadence bounds, public exports                              |

## Scheduled flow

- The `news-polling` queue handles `poll-news` and `deliver-news`; startup registers immediate and repeating jobs.
- Polling fetches feeds, caps results with `maxArticlesPerPoll`, and stores new articles without scoring them.
- Delivery loads enabled subscriptions, checks cadence, then evaluates eligible articles against each chat's resolved instruction.
- Subscription and delivery stores use raw Telegram chat IDs. Do not pass conversation keys such as `group:<id>`.
- Delivery considers articles fetched since `deliverAfter`, oldest first, skipping articles already delivered to that chat.
- Send at most one relevant article per chat per cycle. Eligibility is the later of `deliverAfter` and `lastSentAt + interval`.
- Write the delivery record before calling Telegram; remove it if the callback throws. Update `lastSentAt` only after success.
- A send failure is rethrown and stops the current delivery cycle.

## Subscription and query contracts

- New subscriptions are disabled; default cadence is 300 seconds, with integer bounds of 300-86400 seconds.
- Subscribe/resubscribe resets `deliverAfter`; interval and topic updates preserve the enabled state.
- Without a saved preference record, legacy topics fall back to `news.topics`. Custom instructions take precedence; reset stores a default marker that ignores legacy topics. Preference changes do not change subscriptions or cadence.
- Telegram `/news`, `/summary`, and the agent's feed tool pass raw chat IDs into query methods. All share the same filter used for delivery; there is no unfiltered fallback.
- `/news` can fetch fresh feeds; `/summary` uses cached articles fetched in the last 24 hours and invokes the chat agent. Queries inspect at most 50 candidates and return at most 10 matches.
- Article title, description, and content are preserved across query and scheduled scoring. Exclusions and missing substantive matches reject an article regardless of score.
- Preference updates during scoring discard stale results before sending/returning. Model errors return no decision and are not cached.

## Redis behavior and verification

- Article values expire after 7 days; the `news:items` index is scored by `fetchedAt`, not publication time.
- Preferences use `news:preferences:<chatId>` with no application expiry, independently of subscription records. Custom records retain description, instruction, revision, model, and generation time.
- Complete decisions expire after 14 days. Keys include chat/article identity plus a hash of preference revision/instruction, model/provider, scoring configuration, and article content. Legacy score-only keys are ignored.
- Delivery values expire after 30 days. Article and delivery indexes do not receive matching expiry.
- `legacyBroadcastedAt` and global relevance helpers remain compatibility surfaces; scheduled delivery uses per-chat records.
- `test/news-subscriptions.test.ts` covers defaults, cadence validation, resubscribe gates, chat isolation, oldest-first delivery, cooldowns, and callback rollback.
- `test/telegram-routing.test.ts` covers group subscription authorization.
- Tests inject Redis, feed/scoring, queue, and worker doubles; use `test/test-helpers.ts` for shared fixtures.

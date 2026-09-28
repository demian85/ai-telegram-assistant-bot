# News

## Source map

| File                         | Responsibility                                           |
| ---------------------------- | -------------------------------------------------------- |
| `scheduler.ts`               | BullMQ jobs, eligibility, relevance cache, send callback |
| `feed-reader.ts`             | Feed extraction and per-instance URL deduplication       |
| `news-store.ts`              | Article records and fetched-time index                   |
| `news-query-service.ts`      | Cached and on-demand news queries                        |
| `relevance-detector.ts`      | Structured model scoring against supplied/default topics |
| `chat-subscription-store.ts` | Enabled state, cadence, topics, delivery timestamps      |
| `news-delivery-store.ts`     | Per-chat article delivery records and rollback           |
| `types.ts`, `index.ts`       | Shared contracts, cadence bounds, public exports         |

## Scheduled flow

- The `news-polling` queue handles `poll-news` and `deliver-news`; startup registers immediate and repeating jobs.
- Polling fetches feeds, caps results with `maxArticlesPerPoll`, and stores new articles without scoring them.
- Delivery loads enabled subscriptions, checks cadence, then scores eligible articles using each chat's topics.
- Subscription and delivery stores use raw Telegram chat IDs. Do not pass conversation keys such as `group:<id>`.
- Delivery considers articles fetched since `deliverAfter`, oldest first, skipping articles already delivered to that chat.
- Send at most one relevant article per chat per cycle. Eligibility is the later of `deliverAfter` and `lastSentAt + interval`.
- Write the delivery record before calling Telegram; remove it if the callback throws. Update `lastSentAt` only after success.
- A send failure is rethrown and stops the current delivery cycle.

## Subscription and query contracts

- New subscriptions are disabled; default cadence is 300 seconds, with integer bounds of 300-86400 seconds.
- Subscribe/resubscribe resets `deliverAfter`; interval and topic updates preserve the enabled state.
- Missing custom topics fall back to `news.topics`. Changing topics alone does not subscribe a chat.
- Telegram `/news` and `/summary` pass per-chat topics to query methods. The agent's `get_recent_news` tool uses the global query path.
- `/news` can fetch fresh feeds; `/summary` uses cached articles fetched in the last 24 hours and invokes the chat agent.
- `getRecentNewsRaw()` clamps to 10 items, including the internal request for 50 candidates from `getRecentNewsForChat()`.

## Redis behavior and verification

- Article values expire after 7 days; the `news:items` index is scored by `fetchedAt`, not publication time.
- Per-chat relevance values expire after 14 days; keys contain chat/article identity without a topics version. Topic updates currently do not invalidate them.
- Delivery values expire after 30 days. Article and delivery indexes do not receive matching expiry.
- `legacyBroadcastedAt` and global relevance helpers remain compatibility surfaces; scheduled delivery uses per-chat records.
- `test/news-subscriptions.test.ts` covers defaults, cadence validation, resubscribe gates, chat isolation, oldest-first delivery, cooldowns, and callback rollback.
- `test/telegram-routing.test.ts` covers group subscription authorization.
- Tests inject Redis, feed/scoring, queue, and worker doubles; use `test/test-helpers.ts` for shared fixtures.

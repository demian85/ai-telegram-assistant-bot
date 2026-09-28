# Memory module

## Where to look

| Change                                | File                                                                                         |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| Context window and summary thresholds | `memory-manager.ts`                                                                          |
| Daily model summarization             | `summarizer.ts`                                                                              |
| Sorted-set summary persistence        | `summary-store.ts`                                                                           |
| Defaults and data types               | `types.ts`                                                                                   |
| Raw message persistence               | `../redis/conversation-store.ts`                                                             |
| Behavioral coverage                   | `test/summary-store.test.ts`, `test/agent-memory.test.ts`, `test/conversation-store.test.ts` |

## Contracts

- `MemoryManager.addMessage()` writes raw history, then synchronously checks daily, weekly, and monthly summary generation. A persistence call can therefore invoke the summarizer model.
- The context window returns the latest 15 raw messages plus up to 7 daily, 4 weekly, and 3 monthly summaries, using defaults in `types.ts`.
- Daily summaries require at least five messages in the period and call `Summarizer`. Weekly summaries require three daily summaries; monthly summaries require two weekly summaries. Weekly/monthly text is aggregated and truncated from existing summaries, without another model call.
- The caller supplies a normalized private/group scope as `chatId`; raw messages use `conversation:<scope>` and summaries use `memory:summary:<scope>:<level>`.
- `ConversationStore.getHistory()` reads the Redis list, skips malformed JSON, sorts by timestamp, then applies the requested limit. Raw history is not pruned by this module.
- `MemoryManager.clearHistory()` deletes both raw conversation history and all summary levels for only the supplied scope. Keep this paired behavior when changing `/clear`.

## Storage details

- `SummaryStore` keeps each summary level in a Redis sorted set scored by `endTime`; recent summaries are returned in chronological order.
- If daily model summarization fails, `Summarizer` returns an unavailable-summary record that is still saved.

## Checks

- Run `npm test -- test/conversation-store.test.ts test/summary-store.test.ts test/agent-memory.test.ts` for storage, context, or clear behavior.
- The in-memory Redis fake in `test/test-helpers.ts` does not enforce TTL; use its list and sorted-set behavior for these tests.

# Agent module

Builds live LangChain invocations, durable text history, and tools with trusted chat context.

## Where to look

| Change                                    | File                                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| Context assembly, invocation, persistence | `index.ts` (`AgentService`)                                                                  |
| Live image input and durable text shadow  | `content.ts`                                                                                 |
| Built-in tools and conditional news tool  | `tools.ts`                                                                                   |
| Behavioral coverage                       | `test/agent-memory.test.ts`, `test/agent-content.test.ts`, `test/agent-news-context.test.ts` |

## Invocation contracts

- Call `initialize()` before `invokeLive()`; it creates the LangChain agent with the configured model and tools.
- `invokeLive()` reads the context window before adding the current user message. It then persists the user's text shadow, invokes the model, and persists the assistant's extracted text on success.
- The model receives a system prompt, any daily/weekly/monthly summary context, recent raw messages, and the current user content.
- With vision enabled, the live content may contain Telegram's image URL. Redis stores `[image attached]` and optional caption text, never the image URL. Without vision, the live user content is that text shadow too.
- `persistUserMessage()` records group messages that do not invoke the agent. Keep that path distinct from `invokeLive()` so a message is not stored twice.

## Tools

- `createAgentTools()` always includes calculator, help, and current time.
- It adds `get_recent_news` only when a news query service exists and the chat role does not declare web-search support.
- `invokeLive()` strips the private/group prefix for `configurable.newsChatId`; `get_recent_news` passes that trusted value to `fetchAndGetRecentNewsForChat()`. Its model-supplied schema contains only `count` (1-10, default 5); missing context fails closed.
- Tool definitions live in `tools.ts`; adding a tool requires wiring it into the factory used by `src/index.ts`.

## Checks

- Run `npm test -- test/agent-content.test.ts test/agent-memory.test.ts` for image and persistence changes.
- Run `npm test -- test/agent-news-context.test.ts` for invocation/tool context changes. It exercises real `AgentService` to news tool to `NewsQueryService` wiring with a fake chat model and a retrieval spy: `group:-123` reaches retrieval as raw `-123`, while the model supplies only `count`.
- Use the injected model/Redis seams in tests; live Telegram and provider calls are not needed for these contracts.

# Telegram boundary

## Where to look

| Concern                          | Entry point                                                    |
| -------------------------------- | -------------------------------------------------------------- |
| Middleware and handlers          | `index.ts`: `Bot` constructor, `buildCommands`                 |
| Advertised commands              | `index.ts`: `registeredCommands`, `init`                       |
| Text/photo normalization         | `index.ts`: `normalizeIncomingMessage`, `getParsedMessageText` |
| Agent invocation and persistence | `index.ts`: `handleAgentTextCompletion`                        |
| Group subscription permissions   | `index.ts`: `ensureSubscriptionCommandAccess`                  |
| Chat identity                    | `scope.ts`, `types.ts`                                         |
| Reply/news formatting            | `util.ts`                                                      |

## Routing and identity

- Preserve registration order: context middleware, command handlers, generic text/photo handlers.
- Middleware resolves chat scope before authorization, mention detection, and parsed text.
- Private chats require a Telegram username even when the whitelist is empty; a nonempty whitelist additionally requires a match.
- Commands are handled before generic text. Unknown leading bot commands receive the help fallback.
- `registeredCommands` controls Telegram's advertised menu; handlers live in `buildCommands`. Keep both aligned for public commands.
- `debugnews` is an internal handler omitted from the menu. `/start` is registered separately.
- `/abort` currently reports that no interactive operation is running; it does not cancel agent or scheduler work.
- `scope.ts` normalizes supergroups to groups and rejects unsupported chat types.
- Pass `ctx.chatScope` to agent/history operations; use `getSubscriptionChatId` for news subscriptions and topics.
- Group invocation requires an explicit Telegram mention of the configured bot username, including photo caption entities.
- Strip explicit bot mentions from model input and preserve existing sender attribution for parsed group text and captions.
- Command handlers have their own routing; ordinary message mention gating happens in `normalizeIncomingMessage`.

## Photos and output

- Select the last photo size and resolve its file link for the current invocation.
- Keep that URL transient: agent content helpers persist an image marker and caption as a text shadow.
- Unmentioned group photos persist without a reply. For an invoked photo with unsupported vision, persist its shadow and send the limitation message.
- Use `formatTelegramMarkdownReply` with Telegram `parse_mode: 'Markdown'` for model responses.
- Treat RSS titles, descriptions, sources, and URLs as literal data; scheduled articles, `/news`, and `/debugnews` use HTML formatting with escaped fields.
- Reuse `formatNewsArticle` / `formatNewsArticles` for news formatting and their plain-text mode for summary input.

## Subscription commands

- `/subscribe`, `/unsubscribe`, `/interval`, and `/topics` call the shared access check before reading or changing settings.
- Private chats pass that check; groups require `administrator` or `creator` status from Telegram.
- Missing identity or failed membership lookup denies access with an explanatory reply.
- `/news` and `/summary` obtain the chat's topics, falling back to configured defaults.

## Verification

Use `test/telegram-routing.test.ts`, `test/telegram-scope.test.ts`, and `test/telegram-util.test.ts`. Photo persistence also crosses into `test/agent-content.test.ts` and `test/agent-memory.test.ts`. Reuse the injected bot/agent fixtures instead of launching a live polling instance.

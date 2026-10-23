# Telegram boundary

Telegraf middleware routes authorized commands and ordinary text/photos into scoped memory, agent invocations and formatted replies.

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
- Groups and supergroups must match `telegram.allowedGroupIds`, an array of negative numeric chat ID strings. Missing or empty means no groups are allowed. Denied group updates return silently before mention detection, parsing, persistence, file lookup, or command dispatch, regardless of sender identity or admin status.
- Private chats require a Telegram username even when the whitelist is empty; a nonempty whitelist additionally requires a match.
- Commands are handled before generic text. Unknown leading bot commands receive the help fallback.
- `registeredCommands` controls Telegram's advertised menu; handlers live in `buildCommands`. Keep both aligned for public commands.
- `debugnews` is an internal handler omitted from the menu. `/start` is registered separately.
- `/abort` currently reports that no interactive operation is running; it does not cancel agent or scheduler work.
- `scope.ts` normalizes supergroups to groups and rejects unsupported chat types.
- Pass `ctx.chatScope` to agent/history operations; use `getSubscriptionChatId` for news subscriptions and preferences.
- Pass trusted `ctx.chatType` as the third argument to agent invocations for ordinary text/photos and `/summary`, selecting the required private or group prompt. Never take the type from user/model input.
- Allowed group invocation requires an explicit Telegram mention of the configured bot username (including photo caption entities) or a direct reply to this bot's message, identified by `reply_to_message.from.id === ctx.botInfo.id`.
- Authorized private ordinary text invokes the agent directly without a mention.
- Telegram privacy mode determines which group updates the bot receives; there is no application privacy-mode toggle.
- Strip explicit bot mentions from model input and preserve existing sender attribution for parsed group text and captions.
- Command handlers have their own routing; ordinary message mention gating happens in `normalizeIncomingMessage`.

## Photos and output

- Select the last photo size and resolve its file link for the current invocation.
- Keep that URL transient: agent content helpers persist an image marker and caption as a text shadow.
- Unmentioned photos in allowed groups persist without a reply unless they directly reply to this bot's message. For an invoked photo with unsupported vision, persist its shadow and send the limitation message.
- `Bot.sendNewsArticle` throws for negative chat IDs absent from `telegram.allowedGroupIds`, before sending to Telegram. Positive private-chat IDs are unaffected by this group guard.
- Use `formatTelegramMarkdownReply` with Telegram `parse_mode: 'Markdown'` for model responses.
- `send-message.ts` wraps string replies in middleware and scheduled news sends: split long rendered text at paragraph, sentence, word, or Unicode boundaries, preserve formatting with entities, await chunks in order, and honor Telegram's `retry_after`. Use this shared sender for standalone command handlers too. Unparseable long formatting falls back to literal plain text.
- Treat RSS titles, descriptions, sources, and URLs as literal data; scheduled articles, `/news`, and `/debugnews` use HTML formatting with escaped fields.
- Reuse `formatNewsArticle` / `formatNewsArticles` for news formatting and their plain-text mode for summary input.

## Subscription commands

- `/subscribe`, `/unsubscribe`, `/interval`, and `/newsfilter` call the shared access check before reading or changing settings.
- Private chats pass that check; allowed groups additionally require `administrator` or `creator` status from Telegram. Unlisted groups never reach this check.
- Missing identity or failed membership lookup denies access with an explanatory reply.
- `/newsfilter` delegates to `news-filter-command.ts`: view, generate/replace, or reset. Generation is serialized per chat in this single bot process; overlapping requests receive a retry message. Structured criteria and their source quotes are validated before persistence. `/topics` is removed.
- `/news` and `/summary` pass raw chat IDs to the shared filtering query service.

## Verification

Use `test/telegram-routing.test.ts`, `test/telegram-scope.test.ts`, and `test/telegram-util.test.ts`. Photo persistence also crosses into `test/agent-content.test.ts` and `test/agent-memory.test.ts`. Reuse the injected bot/agent fixtures instead of launching a live polling instance.

Routing fixtures explicitly allow their existing `-100` group. Keep regressions for omitted/empty allowlists, denied mentions/photos/commands without side effects, allowed groups, unchanged private authorization, and rejected outbound group news.

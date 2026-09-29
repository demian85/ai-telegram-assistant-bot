# AI Telegram Bot

An AI-powered Telegram bot for private chats and group chats, with long-term memory, optional image understanding, and automated news delivery.

The bot is provider-agnostic: any OpenAI-compatible LLM provider can be used by configuring `llm.baseUrl`, `llm.apiKeyEnvVar`, and the role models in `config.json`. If you want private, uncensored AI access out of the box, [Venice.ai](https://venice.ai/) is a good default platform and is what the sample defaults point to.

## What it does

### Private chats

- Every text message goes straight to the AI agent
- Photo messages can be analyzed when the configured chat model supports vision
- Conversation history is stored in Redis and compressed into hierarchical summaries so the bot can keep context over time

### Group chats

- Group text and photo messages are persisted for shared memory
- The bot only replies when it is explicitly mentioned
- Messages are stored with sender attribution, for example `Alice: can you summarize this?`, so shared context stays readable
- News subscription commands are limited to group admins

This makes the bot usable as both a personal assistant in DMs and a passive-memory assistant in team or community groups.

## Features

- Telegram chat agent powered by LangChain + OpenAI-compatible chat models
- Four separate LLM roles: chat, summarizer, news relevance scoring, and news preference generation
- Hierarchical memory with recent context plus daily, weekly, and monthly summaries
- Optional vision support for photo messages
- Tool-enabled responses with built-in calculator, help, and time tools
- Configurable web-search-aware chat role (`supportsWebSearch`)
- RSS news polling, relevance scoring, storage, and per-chat delivery
- Persistent per-chat news preferences, exclusions, and delivery cadence
- On-demand recent news retrieval and 24-hour news summaries
- Optional private-chat username whitelist

## Command reference

The bot registers these Telegram commands:

```text
/start                 Show a quick overview for this chat
/help                  Show commands, ingress behavior, and news status
/abort                 Abort the current interactive operation
/clear                 Clear stored conversation history for this chat scope
/info                  Show chat scope and subscription details
/news [count]          Get recent news (1-10 articles, default: 5)
/summary               Summarize the most relevant news from the last 24 hours
/subscribe             Enable relevant news delivery for this chat
/unsubscribe           Disable relevant news delivery for this chat
/interval [seconds]    Show or set the news cadence
/topics [a, b, c]      Show or set news topics for this chat
/newsfilter [text]     Describe preferences, or show the active filter
/newsfilter reset      Restore the configured default news filter
```

In private chats, subscription commands are self-service. In group chats, `/subscribe`, `/unsubscribe`, `/interval`, `/topics`, and `/newsfilter` require admin access, including viewing preferences.

### Configure your news filter

Send your interests and exclusions in your own words:

```text
/newsfilter I prefer articles about coding agents, coding tools, agent harnesses and programming languages, but I'm not interested in Python or new releases of LangChain tools.
```

The `newsPreferences` model turns that description into a precise instruction. The bot saves it and replies with the generated instruction so you can check its interpretation. Descriptions and generated instructions are limited to 3000 characters each.

- `/newsfilter` shows your original description and active instruction.
- `/newsfilter <new description>` replaces the previous preferences completely. Include everything you want to retain.
- `/newsfilter reset` restores the current `news.topics` defaults, even if you previously set custom `/topics`.
- Failed generation leaves the previous saved filter intact. A second update while generation is running is rejected; retry after it finishes.
- Changes do not subscribe or unsubscribe the chat, change its interval, or resend already delivered articles.

The instruction is reused until you change or reset it. The generator is not called for each article. Preferences are stored per chat in Redis without an application expiry; Redis persistence/backups are still needed to survive data loss. Group preferences are shared by that group.

Articles must substantively match at least one interest, avoid explicit exclusions, and meet the relevance score threshold. A high score cannot override an exclusion. By default, an exclusion concerns the article's main subject; an incidental mention does not disqualify it. Say explicitly if you want a stricter rule.

## Tech stack

- **Node.js 24**
- **TypeScript**
- **Telegraf** for Telegram bot handling
- **LangChain** with **@langchain/openai** for the agent runtime
- **Redis** for sessions, conversation memory, summaries, and news storage
- **BullMQ** for polling and delivery scheduling
- **tsx** for local development
- **Pino** + `pino-pretty` for logging
- **Vitest** for tests
- **Docker / Docker Compose** for containerized local runs

## Requirements

- Node.js `>=24.0.0`
- npm
- Redis
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- An API key for your chosen OpenAI-compatible provider

## Configuration

### 1. Environment variables

Copy `env.sample` to `.env`:

```bash
cp env.sample .env
```

Required values:

```env
TELEGRAM_BOT_TOKEN=
REDIS_URL=redis://localhost:6379
LLM_API_KEY=
LOG_LEVEL=info
```

### 2. Application config

`config.defaults.json` is the baseline configuration shipped with the repo.

To override it, copy `config.sample.json` to `config.json`:

```bash
cp config.sample.json config.json
```

Important config areas:

- `telegram.botUsername` - used for mention handling in groups (do not include the `@` prefix)
- `telegram.whitelistedUsers` - optional allowlist for private chats
- `news.feeds` - RSS feeds to monitor
- `news.pollIntervalMinutes` - how often feeds are polled
- `news.deliveryCheckIntervalSeconds` - how often subscriptions are checked for delivery
- `news.relevanceThreshold` - minimum score to deliver an article to a chat (scored per-chat)
- `news.topics` - default interests for new chats and `/newsfilter reset`
- `llm.apiKeyEnvVar` - env var holding the provider API key
- `llm.baseUrl` - OpenAI-compatible base URL
- `llm.roles.newsPreferences` - model and system prompt that convert user descriptions into filtering instructions
- `llm.roles.newsRelevance` - model and system prompt that evaluate articles using saved preferences
- `llm.roles.chat` and `llm.roles.summarizer` - conversational and memory models

Both news roles share `llm.baseUrl` and the API key but can use different model names. Set `llm.roles.newsPreferences.model` independently of `llm.roles.newsRelevance.model` in your full `config.json` (see `config.sample.json`). Choose models that support structured JSON output. The preference role's system prompt controls instruction generation; the relevance role's system prompt is combined with fixed selection rules and the saved chat instruction.

Existing three-role configurations remain valid. If your override omits `newsPreferences`, it inherits the shipped default role. If both files omit it, the loader uses the relevance model with a dedicated preference-generation prompt. The loader still validates a nonempty override as a full config before merging: a file containing only the new role is not sufficient.

By default, `config.defaults.json` points to Venice's API base URL, but you can swap that to any compatible provider.

## Running locally

Install dependencies:

```bash
npm install
```

Start Redis only:

```bash
docker compose up redis
```

Run the bot in development mode:

```bash
npm run start:dev
```

Build and run the production build locally:

```bash
npm run build
npm start
```

## Docker

Build and run the full stack:

```bash
docker compose up --build
```

Run in the background:

```bash
docker compose up -d --build
```

Stop containers:

```bash
docker compose down
```

The compose setup starts:

- `redis` - Redis 7 with append-only persistence
- `bot` - the Node 24 application container

## Development commands

```bash
npm run start:dev
npm run build
npm start
npm run tscheck
npm test
npm run lint
npm run lint:fix
npm run format
npm run format:check
```

## How memory works

Conversation state is stored in Redis.

- Recent messages are kept as the live context window
- Daily summaries are generated from raw conversation history
- Weekly summaries are generated from daily summaries
- Monthly summaries are generated from weekly summaries

This keeps the bot context-aware without letting conversation history grow unbounded.

## How news works

The bot continuously monitors configured RSS feeds and stores recent articles in Redis.

1. Feeds are polled on a schedule
2. New articles are stored and indexed in Redis (duplicates are skipped, and items expire after 7 days)
3. Subscribed chats receive articles according to their own delivery interval
4. At delivery time, each candidate article is evaluated against **that chat's saved filtering instruction** using the dedicated news relevance model
5. The first article that matches an interest, is not excluded, meets the relevance threshold, and has not been delivered to that chat before is sent
6. Users can also request recent articles manually with `/news` or ask for a digest with `/summary`

Scheduled delivery, `/news`, `/summary`, and the built-in `get_recent_news` feed tool share the same filter and decision cache. The tool receives chat identity from the application, not from model arguments. Provider-native web search is separate and is not filtered by this feed pipeline.

Chats without a saved `/newsfilter` setting retain legacy `/topics` preferences, falling back to `news.topics`. Once `/newsfilter` is set or reset, it takes precedence over `/topics`. No existing subscriptions need migration.

Complete decisions are cached for 14 days, including the exclusion flag and reason. Cache keys include chat, article content, preference revision, model/provider, scoring prompt, and threshold. Preference changes take effect on subsequent evaluations; old score-only cache entries are ignored. Failed or malformed model responses do not deliver articles or create cached rejections. A preference change during scoring discards that request's results before delivery.

Filtering uses RSS title, description, and available content (bounded to 1000, 3000, and 8000 characters respectively), not a fetched full webpage. On-demand requests inspect up to 50 recent candidates and return up to 10 matches; zero matches is a valid result.

### Evaluate model quality

Run offline regression tests with `npm test`. To check actual provider decisions after changing models or prompts:

```bash
npm run news:evaluate
```

This uses your configured provider credentials, generates one instruction from the example above, and scores eight labeled synthetic articles. It runs nine model calls (SDK retries may add requests), prints each decision and a pass count, and exits unsuccessfully for mismatches. It stops immediately on a provider failure. Generation and scoring each have a 60-second timeout. It does not start Telegram, connect to Redis, change preferences, or send messages. The cases include direct matches, Python and LangChain exclusions, incidental mentions, generic AI news, insufficient detail, and instructions embedded in article text. A successful run is a small quality check, not proof of accuracy across real feeds; add representative false positives when tuning the models.

Implementation verification on 2026-09-29: the offline regression suite passed, and live instruction generation succeeded with `qwen3-5-35b-a3b`. The first live scoring call to `qwen3-5-9b` timed out, so live classification accuracy remains unverified. Rerun the evaluation before relying on a chosen model configuration in production.

## Project structure

- `src/index.ts` - bootstrap and service wiring
- `src/lib/telegram/` - Telegram routing, command handling, reply formatting
- `src/lib/agent/` - LangChain agent service and built-in tools
- `src/lib/memory/` - hierarchical memory and summarization
- `src/lib/news/` - feed reading, scoring, storage, subscriptions, scheduling
- `src/lib/redis/` - Redis-backed persistence
- `config.defaults.json` - default runtime config
- `config.sample.json` - example override config
- `env.sample` - environment template

## Notes and gotchas

- If the chat model does not support vision, photo messages are still persisted to memory, but the bot will not answer image-specific questions about them.
- In groups, Telegram privacy mode affects how much context the bot can see. Disabling privacy mode is recommended if you want passive group memory capture for all messages.
- Only one Telegram polling instance should run at a time. If you get a Telegram `409 Conflict`, another bot instance is already connected.

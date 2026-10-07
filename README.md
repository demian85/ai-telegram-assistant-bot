# AI Telegram Bot

An AI-powered Telegram bot for private chats and group chats, with long-term memory, optional image understanding, and automated news delivery.

Chat, summaries, and preference generation use OpenAI-compatible LLMs. News filtering uses a configurable decision model through a typed `/decisions` API, sharing the provider URL and API key configured through `llm.baseUrl` and `llm.apiKeyEnvVar`. [Venice.ai](https://venice.ai/) is the suggested provider and Jev is the shipped decision model; other providers and models can be used when they support the same decision API contract.

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
- Three generative LLM roles: chat, summarizer, and news preference generation; a separate decision model supplies typed news judgments
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
/newsfilter [text]     Describe preferences, or show the active filter
/newsfilter reset      Restore the configured default news filter
```

In private chats, subscription commands are self-service. In group chats, `/subscribe`, `/unsubscribe`, `/interval`, and `/newsfilter` require admin access, including viewing preferences.

### Configure your news filter

Send your interests and exclusions in your own words:

```text
/newsfilter I prefer articles about coding agents, coding tools, agent harnesses and programming languages, but I'm not interested in Python or new releases of LangChain tools.
```

The `newsPreferences` model extracts structured interests, exclusions, and title requirements. Each rule must cite exact text from your description. The app validates those fields and builds the readable instruction; a heading-only, empty, or structurally incomplete response is rejected. Descriptions and compiled instructions are limited to 3000 characters each.

- `/newsfilter` shows your original description and active instruction.
- `/newsfilter <new description>` replaces the previous preferences completely. Include everything you want to retain.
- `/newsfilter reset` restores the current `news.defaultFilter`, including for chats migrated from the removed `/topics` command.
- Failed generation leaves the previous saved filter intact. A second update while generation is running is rejected; retry after it finishes.
- Changes do not subscribe or unsubscribe the chat, change its interval, or resend already delivered articles.

Your original description is always supplied to the relevance model and takes precedence over the compiled instruction. This preserves exclusions and title rules even if the generator omits a detail. The structured criteria and instruction are reused until you change or reset them. The generator is not called for each article. Preferences are stored per chat in Redis without an application expiry; Redis persistence/backups are still needed to survive data loss. Group preferences are shared by that group.

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
- `news.relevanceThreshold` - minimum article coverage score on a 0-100 scale; still enforced independently of decision confidence
- `news.decisionModel` - model ID accepted by your provider's decision API; the shipped default is `jev-latest`
- `news.decisionConfidenceThreshold` - minimum semantic gate confidence from 0-1, default `0.8`
- `news.defaultFilter` - natural-language selection instructions for new chats and `/newsfilter reset`
- `llm.apiKeyEnvVar` - env var holding the provider API key
- `llm.baseUrl` - shared provider API base URL for generative and decision requests; the suggested Venice URL is `https://api.venice.ai/api/v1`
- `llm.roles.newsPreferences` - model and system prompt that convert user descriptions into filtering instructions
- `llm.roles.newsRelevance.systemPrompt` - supplementary instructions supplied to each news decision question
- `llm.roles.chat` and `llm.roles.summarizer` - conversational and memory models

Preference generation and news decisions share `llm.baseUrl` and the API key. Set `llm.roles.newsPreferences.model` to a generative model that supports structured JSON output, and select the article evaluator with `news.decisionModel`. Modern `llm.roles.newsRelevance` config contains only `systemPrompt`; its retired model and capability fields are optional legacy inputs and do not control article inference. The unused `llm.defaultModel` is also optional for old configs and omitted from the shipped examples. Existing full overrides inherit the new news settings from defaults. The preference role extracts structured criteria; the decision model receives your original description, supplementary compiled instruction, and fixed selection rules in each question.

Existing three-role configurations remain valid. If your override omits `newsPreferences`, it inherits the shipped default role. If both files omit it, the loader uses the legacy relevance model when supplied, otherwise the summarizer model, with a dedicated preference-generation prompt. It never uses the decision model to generate preferences. The loader still validates a nonempty override as a full config before merging: a file containing only the new role is not sufficient.

The current adapter requires `POST /decisions` with the typed Choice and Score request/response contract described in [News decision model setup](docs/news-decision-models.md). The shared provider must also support OpenAI-compatible chat completions for the generative roles. Providers with a different decision API need an adapter; a chat-completion model alone is not a drop-in replacement. See [Choosing a news decision model](docs/news-model-selection.md) for selection criteria.

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
4. At delivery time, each candidate article is evaluated against **that chat's original preferences and saved instruction** through the configured provider's `/decisions` endpoint
5. The first article that matches an interest, is not excluded, satisfies title requirements, meets the coverage threshold with confident semantic gates, and has not been delivered to that chat before is sent
6. Users can also request recent articles manually with `/news` or ask for a digest with `/summary`

Scheduled delivery, `/news`, `/summary`, and the built-in `get_recent_news` feed tool share the same filter and decision cache. The tool receives chat identity from the application, not from model arguments. Provider-native web search is separate and is not filtered by this feed pipeline.

`/topics` has been removed. On first filter access, a chat with old subscription topics and no filter gets a persistent filter record derived from those topics. Existing custom filters and explicit resets take precedence; subscription status, interval, and delivery history remain unchanged. Old `news.topics` arrays in JSON config are converted to `news.defaultFilter` before merging, so existing overrides keep their meaning; update those files to the new field when convenient. An explicit `defaultFilter` wins if both fields exist.

Previously saved unstructured filters use their original description instead of trusting the generated instruction. This immediately protects chats with the old heading-only failure. Use `/newsfilter <description>` to replace one with validated structured criteria. Failed generation keeps the existing filter intact.

The decision model evaluates three Choice questions (interest, exclusion, and title rules) and a six-level coverage Score in one request. The rubric position is multiplied by 20 and rounded to a 0-100 coverage score; confidence is a separate gate. `news.relevanceThreshold` still sets the minimum coverage score: a rubric position of 3.5 becomes 70 and fails a threshold of 80 even if all semantic judgments are confident. All three semantic judgments must meet `news.decisionConfidenceThreshold` for acceptance. A confident nonmatch, exclusion, or title failure can reject even if another judgment is uncertain. Otherwise an uncertain decision is withheld and left uncached. Explanations are generated by application code from the gates.

Complete decisions are cached for 14 days, including exclusion and title flags and the reason. Cache keys include chat, article content, preference revision, original description, model/provider, decision API version, questions, coverage threshold, and confidence threshold. Preference changes take effect on subsequent evaluations; old chat-model decisions and score-only cache entries are bypassed. Failed or malformed model responses do not deliver articles or create cached rejections. A preference change during scoring discards that request's results before delivery.

Filtering uses RSS title, description, and available content (bounded to 1000, 3000, and 8000 characters respectively), not a fetched full webpage. On-demand requests inspect up to 50 recent candidates and return up to 10 matches; zero matches is a valid result.

### Evaluate model quality

Run offline regression tests with `npm test`. To check actual provider decisions after changing models or prompts:

```bash
npm run news:evaluate
```

This reuses your configured provider credentials, generates preferences with the generative preference model, and sends nine labeled articles to the decision API. It runs ten model calls (SDK retries may add requests), prints each decision and a pass count, and exits unsuccessfully for mismatches. It stops if no usable decision is available, including provider errors or unresolved low confidence. Decision requests use at most two SDK retries, a 20-second per-attempt timeout, and a 60-second overall cancellation deadline. It does not start Telegram, connect to Redis, change preferences, or send messages. The cases include the reported Siri settlement false positive, direct matches, Python and LangChain exclusions, incidental mentions, generic AI news, insufficient detail, and instructions embedded in article text. A successful run is a small quality check, not proof of accuracy across real feeds; add representative false positives when tuning the models.

A passing offline suite proves the application gates and data flow, not model accuracy. Run the provider evaluation after changing models or prompts.

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

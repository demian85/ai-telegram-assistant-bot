# Chat retrieval

Normal authorized private and group chats can use web search, Grok X search,
URL reading, citations, and prompt caching. Filtering, preference generation,
memory summarization, and `/summary` cannot invoke these search features.
The personalized RSS tool remains available alongside general search.

## Provider boundary

Search configuration is provider-neutral: `llm.roles.chat.search` contains
`web` (`off`, `auto`, `on`), `x`, `scrape`, and `citations`. The LLM adapter
translates these settings to the provider's chat-completion request fields.
No search, scrape, or other provider-specific endpoints were added. The
existing typed news-decision endpoint is unchanged.

The Venice adapter supports these features. The generic `openai-compatible`
adapter sends no Venice fields and rejects enabled native retrieval, since
OpenAI-compatible chat completions do not define a universal search protocol.
Supporting another provider requires implementing its parameter mapping in
the adapter. Switching `baseUrl` alone does not create native search support.
For nonempty overrides, omitted search settings disable retrieval, and an
omitted provider is inferred from the resolved base URL. Explicit settings
remain authoritative. Empty or absent overrides continue using the defaults.
For Venice, startup checks the standard `/models` catalog for required
function-calling, web-search, and X-search capabilities.

## Native retrieval and limits

The normal chat request carries Venice's `venice_parameters`:
`enable_web_search`, `enable_x_search`, `enable_web_scraping`, and
`enable_web_citations`. The provider handles retrieval within that request.
There are no application search or URL-reading tools, extra retrieval models,
or application retrieval caches. The RSS tool remains separate and uses the
chat's saved news preferences.

X search can supply recent posts and sources; it does not guarantee access to
X's official platform-wide trend ranking. URL reading returns model-generated
evidence, not raw HTML or guaranteed verbatim extraction.

Requests retain a 60-second per-attempt timeout and one SDK retry. A shared
75-second cancellation deadline covers the agent graph and any synchronous
memory-model call during message persistence. It cancels work before Telegraf's
90-second update deadline. A timeout produces a retry message and does not stop
polling. Passive group messages retain their silent behavior on timeout.
The agent graph has a recursion limit of 12. Provider-native internal search
and reasoning can consume substantial tokens within a single request.

For another provider, disable web, X, and scraping in the current compatible
adapter. A ChatGPT subscription is not an API credential for this bot; using
subscription-backed Codex would require a separate integration with its own
capabilities. OpenAI API billing is separate from ChatGPT subscription billing.
Changing providers also requires support for the news `/decisions` contract.

## Prompt caching and sources

Each chat has a stable opaque prompt-cache key, separated from summary keys.
System instructions and tools remain stable; rolling history and updated
summaries can reduce reusable prefixes. Prompt caching remains provider-managed;
there is no padding or artificial warming in normal bot operation.
`llm.usage` logs per-call token/cache metadata, including agent tool-loop calls.

Native model text, citation markers, links, and any model-written source list
are preserved unchanged. Private replies may append a Sources list from provider
metadata; group replies skip that addition.

## Verification

Run offline checks with `npm test`, `npm run tscheck`, `npm run lint`,
`npm run format:check`, and `npm run build`.

`node --import tsx scripts/verify-chat-retrieval.ts` makes up to five paid inference
calls plus one catalog request. It loads the configured API key without
printing it, sends no Telegram messages, and does not connect to Redis.
It records responses and cache usage in a fresh temporary directory and prints
the output path. Generated captures are not stored in the repository.
The cache probe repeats the repository README as a controlled reference.
Use `--chat-only` for one paid native-search call with the reported prompt,
`show me top trending news from x`, plus the catalog request.

The October 24, 2026 native-search check returned an answer with source links
for that exact prompt in 37.2 seconds. The contents and trend rankings were
not independently verified. Offline regressions exercise cancellation during
chat and memory calls and use real Telegraf update handling to verify timeout
recovery and subsequent messages. No live Telegram exchange was performed.

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

## Tools and limits

- `search_web`: retrieves current cited evidence through chat completions.
- `read_webpage`: reads a public HTTP(S) URL through chat completions with
  scraping enabled and web/X search disabled. Returns model-generated page
  evidence, not raw HTML or a guaranteed verbatim Markdown extraction.
- Tools accept no model-supplied chat identity; trusted invocation scope and
  a three-call shared budget are required. The agent graph has a recursion
  limit of 12. Requests have a 60-second timeout and one SDK retry; native
  upstream search work can consume substantial tokens within one request.
- Retrieval responses above 24,000 characters are rejected. Retrieval models
  request at most 2,000 output tokens; provider-native internal search and
  reasoning usage is not a hard spend cap.
- Search cache TTL is five minutes; URL-reading cache TTL is one hour. Cache
  identity includes chat scope, model, provider options, operation, and input.
  Cache writes require a validated source URL and nonempty evidence content in
  structured provider metadata. Echoed URLs and source links without evidence
  are not sufficient. Responses without that metadata remain usable but are
  not cached, even if their native text appears successful. Provider errors
  are not cached. The cache version bypasses entries created by the older
  URL-only check.
  Concurrent identical retrieval requests share one inference.

## Prompt caching and sources

Each chat has a stable opaque prompt-cache key, separated from summary keys.
System instructions and tools remain stable; rolling history and updated
summaries can reduce reusable prefixes. Prompt caching remains provider-managed;
there is no padding or artificial warming in normal bot operation.
`llm.usage` logs per-call token/cache metadata, including agent tool-loop calls.
`retrieval.cache_hit` identifies application cache hits separately.

Native model text, citation markers, links, and any model-written source list
are preserved unchanged. Private replies may append a Sources list from provider
metadata; group replies skip that addition. Retrieval tool results retain the
metadata source list internally so the model can use it when composing an answer.

## Verification

Run offline checks with `npm test`, `npm run tscheck`, `npm run lint`,
`npm run format:check`, and `npm run build`.

`node --import tsx scripts/verify-chat-retrieval.ts` makes up to seven paid inference
calls plus one catalog request. It loads the configured API key without
printing it, sends no Telegram messages, and uses an in-memory Redis double.
It records responses and cache usage in a fresh temporary directory and prints
the output path. Generated captures are not stored in the repository.
The cache probe repeats the repository README as a controlled reference.
Use `--tools-only` for a live URL-tool/cache verification (up to two paid calls) without running
the other probes. It requires no previous capture. The Redis double proves
result reuse but not real Redis expiry.

The October 23, 2026 live check confirmed web-search source metadata,
page-specific reading, X-enabled responses with post URLs, and a repeated
prompt cache hit of 6,400 out of 6,437 input tokens. X post contents were not
independently verified. The offline suite passed 445 tests, plus typecheck,
lint, formatting, and build. No live Telegram exchange or real Redis expiry
test was performed. Disposable raw captures and the separate run report were
removed after verification.

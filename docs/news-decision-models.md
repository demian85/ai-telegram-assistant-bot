# News decision model setup

The bot evaluates RSS articles with the model selected by `news.decisionModel`. It sends typed questions to `POST /decisions` on `llm.baseUrl`, using the same Bearer key named by `llm.apiKeyEnvVar` as the generative roles. The model ID is configurable; the implementation does not restrict it to a particular model family.

Venice is the suggested provider and `jev-latest` is the shipped decision model. For that setup, use `https://api.venice.ai/api/v1` as the base URL. Other models and providers can be used when they satisfy the API requirements below. [Venice decision API](https://docs.venice.ai/api-reference/endpoint/decisions/create)

## Provider and model requirements

The current adapter expects a provider to support:

- `POST /decisions` with a model ID, structured article/preferences state, and named typed questions.
- Choice questions with `yes`/`no` options, the selected option, confidence between 0 and 1, and probabilities for both options summing to 1.
- Score questions with an ordered six-level rubric and a probability-weighted position between 0 and 5, plus confidence.
- A response containing the model ID, named answers, and input/output token usage.
- Bearer authentication and OpenAI-compatible chat completions on the same base URL/key for chat, summaries, and preference generation.

A model ID must be accepted by that provider's decision endpoint; an ordinary chat model is not interchangeable with a decision model just because both are available from the same provider. A provider exposing a different decision protocol, such as a different route or answer schema, requires an adapter. Independent providers/keys for the generative and decision roles also require a configuration change; the current runtime shares them.

## Configuration

Existing complete overrides inherit the decision settings from `config.defaults.json`. To customize them, edit the news section of your existing full `config.json`:

```json
{
  "decisionModel": "your-provider-decision-model-id",
  "decisionConfidenceThreshold": 0.8,
  "relevanceThreshold": 80
}
```

This is a news-section fragment, not a complete override file. The loader still requires a complete nonempty override before merging. The model must be a nonempty string and the confidence threshold must be between 0 and 1. Choose a coverage threshold on the 0-100 scale.

The shipped decision defaults are `decisionModel: "jev-latest"`, `decisionConfidenceThreshold: 0.8`, and `relevanceThreshold: 70`; the sample config uses coverage threshold 80. Set `llm.baseUrl` to your provider's API base URL and `llm.apiKeyEnvVar` to the name of the environment variable containing its key. Changing these shared settings also affects the generative roles.

`llm.roles.newsPreferences.model` extracts preferences when `/newsfilter` changes them and must be explicitly configured. Chat and summaries use their configured generative models. `llm.roles.newsRelevance` accepts only `systemPrompt`, which supplements both decision questions and contributes to the decision cache fingerprint. Article evaluation uses `news.decisionModel`, independently of the generative roles. Retired relevance `model`, `supportsVision`, and `supportsWebSearch` fields, `llm.defaultModel`, and `news.topics` are rejected; use `news.defaultFilter` for default preferences. Defaults and every nonempty override must define all four roles.

## Coverage threshold and confidence threshold

`news.relevanceThreshold` is still active. It determines how much substantive coverage an article needs, independently of how certain the model is about its judgments.

| Setting                            | Meaning                                               | Effect                                                           |
| ---------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------- |
| `news.relevanceThreshold`          | Minimum article coverage score, on a 0-100 scale      | Increasing it requires stronger coverage of the user's interests |
| `news.decisionConfidenceThreshold` | Minimum confidence for semantic gates, on a 0-1 scale | Increasing it withholds more uncertain judgments                 |

The six coverage rubric positions describe unrelated content (0), very weak connection (1), incidental coverage (2), partial substantive coverage (3), direct substantive coverage (4), and central focus on an interest (5). Intermediate positions represent probability-weighted judgments. The application computes `position * 20`.

For example, position 3.5 becomes coverage score 70. With `relevanceThreshold: 80`, the article is rejected even if it is eligible with confidence 1. The application compares the unrounded `position * 20` against the threshold and retains that value in cached decisions; it rounds only the score displayed for a selected article. A score of 69.8 therefore fails a threshold of 70. A high coverage score cannot override ineligibility or unresolved eligibility confidence. Coverage is not a probability of relevance, and confidence is not a relevance score.

## Selection and caching

Each article/chat pair sends the original preferences once, plus the RSS title (up to 1000 characters) and description (up to 3000 characters), in one request. Both questions evaluate the title and description together; an informative description can establish relevance when the title alone cannot. Missing descriptions remain absent and the model must not invent evidence. Full article bodies and compiled instructions are omitted to reduce input tokens.

One `eligibility` Choice combines substantive interest matching, explicit exclusions and exceptions, and any expressly stated title requirements. The `relevance` Score separately evaluates coverage. Acceptance requires eligibility=yes, eligibility confidence at or above `decisionConfidenceThreshold`, and unrounded coverage at or above `relevanceThreshold`. Uncertain eligibility returns no decision, including uncertain rejections. Score confidence is not an eligibility gate; uncertainty between coverage levels is reflected in the weighted rubric position. Explicit title requirements still apply only to the title; a description cannot override a prohibited title.

The original preferences remain authoritative, including exceptions or title rules omitted by compilation. Compiled rules remain a compact, inspectable display in `/newsfilter`; existing structured records are rendered compactly without rewriting saved descriptions or criteria. Article text is untrusted input. Reasons are generated in application code from eligibility, without inventing separate interest/exclusion/title answers. There is no chat-completion fallback for article evaluation.

Scheduled delivery, `/news`, `/summary`, and `get_recent_news` share this filter. Complete decisions use the existing 14-day cache. Its identity includes provider/base URL, model, decision version, questions, coverage/confidence thresholds, preference revision/original text, and the bounded title/description actually evaluated. Display-only instruction changes and unused article-body changes do not spend new requests. Old four-question and chat-model decisions are bypassed. Malformed, failed, and unresolved decisions remain uncached. Preference changes during evaluation still prevent stale delivery.

## Verify a model change

```bash
npm run tscheck
npm test
npm run lint
npm run format:check
npm run build
npm run news:evaluate
```

The final command makes live, billable requests with the configured provider/key. It generates preferences and evaluates nine labeled articles without Telegram sends or Redis writes. Provider errors or unresolved confidence stop it unsuccessfully. Test exclusions, incidental mentions, title rules, sparse content, and injected article instructions on your own feeds when changing the model or thresholds. See [Choosing a news decision model](news-model-selection.md).

For a real-feed comparison with recorded inputs and a strict remote-request budget, use the separate scripts described in [Live news model comparisons](news-model-evaluation.md). These evaluation adapters do not change the bot's production provider configuration.

The [October 7 compact-request evaluation](../artifacts/news-relevance-improvements-2026-10-07.json) replayed ten recorded articles against Jev with the same preferences and thresholds. Input usage fell from 14,883 to 8,143 tokens (45.3%); output usage fell from 1,050 to 490. The new filter accepted four, rejected both exclusion controls, and withheld four, compared with three acceptances, two rejections and five withheld decisions in the previous run. These informal labels are not a general accuracy benchmark. Three additional cases used the same non-specific title: a coding-harness description was accepted, a Python-release description rejected, and a missing description rejected. The run made 13 successful evaluations plus one rate-limited request, with remaining calls spaced out; it made no Telegram sends or Redis writes.

HTTP calls use the installed OpenAI SDK as a transport for the custom decision route, with two retries, a 20-second per-attempt timeout, and a 60-second overall abort signal. Invalid answers are parsed at the response boundary and withheld. Rate-limit failures do not create cached rejections, so later evaluations can retry.

After building, restart the existing bot process through its normal deployment procedure. Only one polling instance may use the bot token. Observe scheduled delivery and manual news queries after restart.

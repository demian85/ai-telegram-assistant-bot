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

`llm.roles.newsPreferences.model` still extracts preferences when `/newsfilter` changes them. Chat and summaries retain their configured generative models. `llm.roles.newsRelevance.systemPrompt` supplements each decision question. Its legacy `model` and capability flags remain for config compatibility and older preference fallback configurations; they no longer select article inference.

## Coverage threshold and confidence threshold

`news.relevanceThreshold` is still active. It determines how much substantive coverage an article needs, independently of how certain the model is about its judgments.

| Setting                            | Meaning                                               | Effect                                                           |
| ---------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------- |
| `news.relevanceThreshold`          | Minimum article coverage score, on a 0-100 scale      | Increasing it requires stronger coverage of the user's interests |
| `news.decisionConfidenceThreshold` | Minimum confidence for semantic gates, on a 0-1 scale | Increasing it withholds more uncertain judgments                 |

The six coverage rubric positions describe unrelated content (0), very weak connection (1), incidental coverage (2), partial substantive coverage (3), direct substantive coverage (4), and central thorough coverage (5). Intermediate positions represent probability-weighted judgments. The application computes `Math.round(position * 20)`.

For example, position 3.5 becomes coverage score 70. With `relevanceThreshold: 80`, the article is rejected even if all semantic gates are correct and their confidence is 1. Conversely, a high coverage score cannot override an exclusion, a failed title rule, or unresolved semantic confidence. Coverage is not a probability of relevance, and confidence is not a relevance score.

## Selection and caching

Each article/chat pair sends the original description, supplementary compiled instruction, and bounded RSS title/description/content in a single request. Three Choice questions independently evaluate substantive interest, explicit exclusion, and title requirements; the Score question evaluates coverage.

Acceptance requires an interest match, no exclusion, satisfied title rules, sufficient coverage score, and enough confidence for all three semantic gates. A confident rejecting gate rejects regardless of uncertainty elsewhere. With no confident rejection, uncertain semantic gates return no decision. Score confidence is not a semantic gate; uncertainty between coverage levels is reflected in the weighted rubric position.

The original preferences remain authoritative, including exceptions or title rules omitted by compilation. Article text is untrusted input. Reasons are generated in application code from the returned gates. There is no chat-completion fallback for article evaluation.

Scheduled delivery, `/news`, `/summary`, and `get_recent_news` share this filter. Complete decisions use the existing 14-day cache. Its identity includes provider/base URL, model, decision API version, questions, coverage/confidence thresholds, preferences, and article content. Old chat-model decisions are bypassed. Malformed, failed, and unresolved decisions remain uncached. Preference changes during evaluation still prevent stale delivery.

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

HTTP calls use the installed OpenAI SDK as a transport for the custom decision route, with two retries, a 20-second per-attempt timeout, and a 60-second overall abort signal. Invalid answers are parsed at the response boundary and withheld. Rate-limit failures do not create cached rejections, so later evaluations can retry.

After building, restart the existing bot process through its normal deployment procedure. Only one polling instance may use the bot token. Observe scheduled delivery and manual news queries after restart.

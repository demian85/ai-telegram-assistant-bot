# Choosing a news decision model

Article filtering is a bounded semantic decision: determine whether an article substantively matches a chat's interests, violates an exclusion, or fails a title requirement. Keep polling, subscriptions, deduplication, caching, score thresholds, and delivery in application code. Use a decision model for judgments and a generative model for preference extraction, chat, and summaries.

The [LangChain article on decision models](https://www.langchain.com/blog/building-prod-with-jev-and-langgraph) illustrates this division of responsibilities. A decision component fits the existing shared news filter; adopting it does not require replacing the scheduler with LangGraph.

## Suggested defaults and alternatives

Venice is the suggested provider and Jev (`jev-latest`) is the shipped decision model. They are defaults, not a restriction on the configurable model ID. Choose another provider/model when it meets the current API contract, or implement an adapter for its native protocol. [News decision model setup](news-decision-models.md) describes that contract and the shared provider/key configuration.

| Model approach                          | Useful for                                                 | Integration requirement                                                                  |
| --------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Dedicated typed decision model          | Repeated semantic gates with probabilities and confidence  | Direct use when its provider supports the existing Choice/Score contract                 |
| Zero-shot or trained classifier         | Stable labels and well-defined categories at high volume   | An adapter mapping classifications to the filter's gates and coverage rubric             |
| Generative model with structured output | Complex exceptions or cases needing broader interpretation | A decision adapter; chat-completion output is not the current decision protocol          |
| Relevance reranker                      | Ordering a candidate shortlist                             | Separate decisions for exclusions and title rules; a ranking score alone is insufficient |

Changing `news.decisionModel` selects a model on the configured decision endpoint. It does not enable a new protocol, a chat-completion fallback, independent provider credentials, or a second evaluation stage.

## Compare quality and operating cost

Compare models against the same human-labeled article/filter pairs and frozen original preferences. Include direct matches, passing mentions, explicit exclusions, exceptions, title requirements, insufficient text, non-English content when relevant, and instructions embedded in articles. Agreement with the previous model alone does not establish correctness.

- For quality, prioritize accepted-article precision, exclusion/title violations, recall, and unresolved judgments.
- For cost, measure billed input/output usage, retries, and any additional evaluation stages per article/chat pair. Cache hits avoid new requests.
- For balance, include latency, quota behavior, consistency, and integration effort alongside quality and cost.

Use held-out cases after tuning; avoid calibrating thresholds on the same examples used to compare final results. Published benchmark ratios or token prices do not establish the best model for your feeds.

## Tune the two independent thresholds

`news.relevanceThreshold` remains the minimum coverage score, computed as `rubricPosition * 20` on a 0-100 scale, with rounding only for display. `news.decisionConfidenceThreshold` separately controls certainty in the combined eligibility judgment. Both eligibility and coverage use the article title and description together. A model can confidently find partial coverage that falls below the coverage threshold.

Retune both settings when changing models. Keep exclusions dominant, original descriptions authoritative, and article text untrusted. Verify the shared paths for scheduled delivery, `/news`, `/summary`, and the feed tool. Failed or unresolved decisions must remain uncached.

The current implementation uses one configured decision model without an automatic fallback or shadow mode. Additional routing or staged evaluation can be introduced if measured results justify the added complexity.

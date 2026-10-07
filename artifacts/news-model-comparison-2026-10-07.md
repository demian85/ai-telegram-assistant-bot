# Jev versus local Laya: live news-filter evaluation

Date: October 7, 2026. Exactly 10 Jev HTTP requests and 10 local Laya HTTP requests were made. Both providers returned HTTP 200 with responses accepted by the bot's decision schema. No mocked provider responses were used. No Telegram sends, Redis writes, preference-generation calls, or production configuration changes were made.

## Method

The evaluation used the single saved custom news filter, including its original description, compiled criteria, exclusions for Python and LangChain releases, and requirements against vague, commit-SHA, or semver-only titles. Chat identifiers and API keys are absent from the saved evidence.

Ten actual articles were fetched from the configured Planet AI RSS feed: eight likely matches and two exclusion controls. These expectations were assigned before either model was called, based on the filter and RSS text. They are informal annotations, not an independently labeled benchmark. Both models received identical state and question objects, except for the model name. The state contained title and RSS description, as used by the current FeedReader; full article bodies were not scraped.

The real VeniceDecisionModel and RelevanceDetector were used with the configured system prompt, a coverage threshold of 70/100, and a Choice confidence threshold of 0.8. Jev used the configured Venice endpoint and jev-latest. Local Laya used Atomic Chat on http://127.0.0.1:1337/v1 with laya-multilingual; only its outgoing route was translated from /decisions to /systemone. The fetch hook sent real HTTP requests and captured the real responses. Automatic retries were disabled and an explicit counter capped Jev requests at 10.

An uncertain outcome means the model returned a valid response but the bot withheld it because the Choice gates were insufficiently confident. It is distinct from a confident rejection or a provider error. The coverage score is independent of confidence.

## Results

Scores are coverage out of 100. Confidence is the minimum of the interest, exclusion, and title Choice confidences. Confident rejection can override uncertainty in another gate.

| Article                                                                                                                                           | Expected | Jev outcome / score / confidence | Laya outcome / score / confidence |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------- | --------------------------------- |
| [Cloud-native agent harness](https://www.latent.space/p/stacklok)                                                                                 | Approve  | Approve / 91 / 0.960             | Uncertain / 58 / 0.148            |
| [Personal Agent Protocol](https://cellcog.ai/blog/personal-agent-protocol/)                                                                       | Approve  | Uncertain / 79 / 0.620           | Uncertain / 58 / 0.609            |
| [Grok finance-agent Slack leak](https://cellcog.ai/blog/grok-bot-personal-cfo-slack-leak/)                                                        | Approve  | Uncertain / 64 / 0.200           | Uncertain / 58 / 0.051            |
| [Claude for Google Workspace](https://cellcog.ai/blog/claude-for-google-workspace/)                                                               | Approve  | Approve / 89 / 0.940             | Uncertain / 59 / 0.367            |
| [Five AI coding assistants](https://www.kdnuggets.com/i-tested-5-ai-coding-assistants-for-a-month-heres-what-i-actually-found)                    | Approve  | Uncertain / 83 / 0.620           | Uncertain / 59 / 0.766            |
| [Choosing an agentic AI framework](https://machinelearningmastery.com/choosing-the-right-agentic-ai-framework-for-2026-a-decision-tree-approach/) | Approve  | Uncertain / 78 / 0.300           | Uncertain / 62 / 0.565            |
| [OpenAI's always-on agent](https://www.wired.com/story/openai-wants-its-new-agent-to-run-your-life-mine-said-it-loved-me/)                        | Approve  | Approve / 84 / 0.920             | Uncertain / 59 / 0.046            |
| [Coding-agent reliability quadrant](https://towardsdatascience.com/the-consistency-quadrant-a-visual-guide-to-llm-reliability/)                   | Approve  | Uncertain / 63 / 0.100           | Uncertain / 57 / 0.584            |
| [Multi-armed bandits in Python](https://towardsdatascience.com/introduction-to-reinforcement-learning-multi-armed-bandit-simulation-in-python/)   | Reject   | Reject / 8 / 0.840               | Uncertain / 66 / 0.208            |
| [Langfuse release titled v4.54.0](https://github.com/langfuse/langfuse/releases/tag/v4.54.0)                                                      | Reject   | Reject / 18 / 0.920              | Uncertain / 60 / 0.331            |

Jev approved 3, confidently rejected 2, and withheld 5. Laya approved 0, confidently rejected 0, and withheld 10. All three Jev-approved articles were withheld by Laya. Exact outcome agreement was 5/10, entirely from cases where both withheld the article. Agreement on send versus do-not-send was 7/10; abstention on excluded articles must not be confused with understanding the exclusions.

Laya chose exclusion=yes for all ten inputs, including the three Jev approvals. It chose interest=yes for the Python control and title=yes for the semver-only control, at low confidence. Its coverage scores ranged from 57 to 66, below the configured minimum even on Jev-approved articles. Lowering only the confidence threshold would therefore not restore the expected deliveries and could turn uncertain exclusion answers into definitive rejections.

The local runtime reported calibration=none and no warnings. That metadata alone does not establish the cause of the disagreement. The sample proves a substantial behavior difference under the existing prompts, runtime, and thresholds; it does not prove that every Laya checkpoint or a different question design has worse intrinsic accuracy. Jev is also not ground truth: it withheld five of the eight informally expected matches. This small, deliberately selected sample measures the current workflow, not general model accuracy or statistical significance.

## Unit tests versus this evaluation

The existing unit tests supply fake provider responses to verify request construction, parsing, coverage conversion, confidence handling, exclusions, and error behavior. They prove that the bot handles a supplied answer correctly, not that a model produces a correct answer. Internal pure logic can be tested without mocks; mocking is appropriate for the remote provider boundary in an offline unit suite.

The earlier compatibility checks and this comparison called the actual local model. This script is an opt-in live evaluation, separate from npm test. The existing twelve decision tests passed; they are verification of the decision plumbing, not evidence for the model-quality comparison. Type checking, script linting, formatting, CLI help, and rejection of an unknown CLI option were also checked.

## Evidence and replay

The adjacent JSON file contains the filter snapshot, original RSS inputs, settings, every outgoing request body, each raw response, parsed decisions, timings, and the Jev request count. No authorization headers are retained.

To replay these exact article inputs and the saved filter against the currently configured prompt and thresholds, deliberately making up to ten additional paid-provider requests:

```bash
node --import tsx scripts/compare-news-models.ts \
  --input artifacts/news-model-comparison-2026-10-07.json \
  --output artifacts/news-model-comparison-replay.json
```

The output path must be new. The default run fetches the selected articles from the live feed and requires the single saved custom filter (or uses the configured default when no custom filter exists). A replay requires neither Redis nor fetching the articles again. The prompt and thresholds come from current configuration and are recorded in the new output.

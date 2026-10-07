# Live news model comparisons

The mocked decision tests verify request construction, answer validation, confidence gates, exclusions, and coverage conversion. They cannot establish whether a model makes correct judgments. The scripts below call real providers through the existing decision client and RelevanceDetector, retaining the actual inputs and responses for review. They are opt-in evaluations, separate from `npm test`.

## Compare Jev and local Laya

Use the configured remote decision provider and a running Atomic Chat Laya endpoint at `http://127.0.0.1:1337/v1`. The local model is fixed to `laya-multilingual`; the evaluation translates only its outgoing `/decisions` route to `/systemone`.

To replay the recorded October 7 article and preference snapshot:

```bash
node --import tsx scripts/compare-news-models.ts \
  --input artifacts/news-model-comparison-2026-10-07.json \
  --output artifacts/news-model-comparison-replay.json
```

This makes up to ten requests to the configured remote decision model and one local Laya request per article. SDK retries are disabled, and a counter caps remote requests at ten. Credentials, model ID, supplementary system prompt, and thresholds come from the current application config and `.env`. The snapshot freezes the original preference description, compiled instruction, and RSS article inputs, not the current prompt or thresholds. Changing those settings is recorded in the new output.

Without `--input`, the script reads the single saved custom filter from Redis, or uses `news.defaultFilter` when no custom filter exists, and fetches ten selected URLs from the configured Planet AI feed. It stops if multiple custom filters exist or a selected article is no longer in the feed. Use the committed snapshot for reproducible inputs after the feed rotates. Replay does not connect to Redis or fetch articles again.

The output path must be new. The script checkpoints results after each article and retains raw request bodies, raw answers, HTTP status, timing, parsed decisions, confidence, and outcomes. It saves no authorization headers. There are no preference-generation calls, Redis writes, or Telegram sends. A completed run may contain uncertain or rejected outcomes: inspect the saved decisions rather than treating exit status zero as a model-quality pass.

Inspect the returned model identity as well as the requested model name. A server can advertise one model while its decision route evaluates another. Keep uncertain decisions distinct from confident rejections and provider errors. Coverage scores and confidence remain separate, and confidence scales need evaluation when switching models.

## Recorded evidence

The October 7 comparison used actual titles and RSS excerpts with the saved custom filter, a coverage threshold of 70/100, and a Choice confidence threshold of 0.8. Jev approved three articles, rejected two exclusion controls, and withheld five. Laya withheld all ten. These are results for the recorded input, model, prompt, and runtime combination, not general model-accuracy estimates. The informal expected labels were assigned before provider calls; Jev agreement is not ground truth.

- [Jev/Laya comparison and interpretation](../artifacts/news-model-comparison-2026-10-07.md)
- [Frozen inputs, request bodies, and raw answers](../artifacts/news-model-comparison-2026-10-07.json)

Use `--help` on each script for its options. Ordinary repository checks such as `npm run tscheck`, `npm test`, and `npm run lint` do not make live provider requests.

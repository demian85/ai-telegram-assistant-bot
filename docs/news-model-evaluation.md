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

## Compare native Clef without new Jev requests

`scripts/compare-clef-news.ts` reuses recorded Jev/Laya answers and evaluates only `ggml-org/Clef-Flash-Q4_K_M`. It freezes the saved supplementary prompt and thresholds as well as the preferences and articles. It verifies discovery and response model identities, and checks each outgoing state and question object against the recorded Jev request. Changed question-builder code can therefore cause replay to stop with an input-mismatch error. The committed October 7 baseline uses the previous four-question contract; it remains historical evidence, but is not accepted by the new eligibility/coverage response parser. Record a new baseline with `compare-news-models.ts` before running Clef against the new contract. The old baseline is rejected before contacting a provider.

Clef's GGUF is a native decision model, not a text-generating chat model. Its [model card](https://huggingface.co/ggml-org/Clef-Flash-GGUF) specifies `/v1/systemone`. Atomic Chat 2.1.8 advertised the downloaded Clef model under its regular chat provider during the recorded run, but chat completions failed and its decision endpoint still returned Laya. Use a native Clef-capable server and inspect the actual returned model identity.

Start an existing compatible `llama-server` binary with your downloaded GGUF. The recorded run used Atomic Chat's installed llama.cpp b11463 backend; no new installation was needed. Replace the model path below with your existing file:

```bash
llama-server \
  --model /path/to/your/model.gguf \
  --alias ggml-org/Clef-Flash-Q4_K_M \
  --host 127.0.0.1 --port 3785 \
  --ctx-size 8192 --batch-size 4096 --ubatch-size 4096 \
  --parallel 1 --gpu-layers all --no-webui
```

The [b11463 server documentation](https://github.com/ggml-org/llama.cpp/blob/b11463/tools/server/README.md) explains that Clef reads all questions jointly and the whole prompt must fit the microbatch. After the server reports that the model is loaded, run in another terminal:

```bash
node --import tsx scripts/compare-clef-news.ts \
  --input artifacts/news-model-comparison-replay.json \
  --output artifacts/clef-news-comparison-replay.json \
  --base-url http://127.0.0.1:3785/v1
```

The output path must be new. This sends up to ten native Clef requests with SDK retries disabled. It makes no Jev or Laya requests, and requires neither Redis nor fetching articles again. Stop the temporary server with Ctrl+C when finished. The evaluation script does not start or stop the server itself or change Atomic Chat's settings. The two recorded support-routing sanity checks are separate evidence and are not automatically rerun by this driver.

## Recorded evidence

The October 7 comparison used actual titles and RSS excerpts with the saved custom filter, a coverage threshold of 70/100, and a Choice confidence threshold of 0.8. Jev approved three articles, rejected two exclusion controls, and withheld five. Laya withheld all ten. These are results for the recorded input, model, prompt, and runtime combination, not general model-accuracy estimates. The informal expected labels were assigned before provider calls; Jev agreement is not ground truth.

- [Jev/Laya comparison and interpretation](../artifacts/news-model-comparison-2026-10-07.md)
- [Frozen inputs, request bodies, and raw answers](../artifacts/news-model-comparison-2026-10-07.json)

The native Clef follow-up reused the same inputs and recorded Jev/Laya answers. Clef withheld all ten articles, with coverage scores from 46 to 52, and selected the correct teams in two short support-routing sanity checks. This describes the tested Q4_K_M GGUF/backend combination with unchanged prompts and thresholds; it does not isolate intrinsic model accuracy from quantization, runtime, or prompt effects.

- [Clef comparison, serving behavior, and limitations](../artifacts/clef-news-comparison-2026-10-07.md)
- [Native Clef request bodies and raw answers](../artifacts/clef-news-comparison-2026-10-07.json)
- [Support-routing sanity-check inputs and answers](../artifacts/clef-sanity-2026-10-07.json)

Use `--help` on each script for its options. Ordinary repository checks such as `npm run tscheck`, `npm test`, and `npm run lint` do not make live provider requests.

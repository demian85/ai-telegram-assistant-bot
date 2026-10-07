# Clef-Flash Q4_K_M versus Jev and Laya

Date: October 7, 2026. The ten previous article inputs, saved preferences, questions, coverage threshold of 70/100, and confidence threshold of 0.8 were reused unchanged. Jev and Laya answers are the recorded baseline from the earlier run. Zero additional Jev requests were made.

## Atomic Chat serving behavior

Atomic Chat advertised ggml-org/Clef-Flash-Q4_K_M in its regular /v1/models list. Its /v1/systemone route accepted a request naming that model but returned model=laya-multilingual with Laya answers. A short chat-completion probe against the advertised Clef model returned HTTP 500: "the current context does not support logits computation. skipping". That is a serving mismatch, not a Clef quality result.

The GGUF is a native decision model. Its [model card](https://huggingface.co/ggml-org/Clef-Flash-GGUF) specifies /v1/systemone. The [llama.cpp b11463 server documentation](https://github.com/ggml-org/llama.cpp/blob/b11463/tools/server/README.md) explains that Clef jointly evaluates typed questions and does not support text generation. Loading it under a chat provider does not make chat completions a valid inference route.

To evaluate the actual model, a temporary llama.cpp b11463 server was started using Atomic Chat's existing installed backend and existing model.gguf. No weights or backend were downloaded. The server listened on 127.0.0.1:3785, used all GPU layers, an 8192-token context, batch and microbatch sizes of 4096, one slot, and no web UI. Metal access required running outside the filesystem sandbox after the sandbox prevented creating a GPU command queue. The temporary server was stopped after the evaluation. Atomic Chat's settings and running instances were left unchanged.

The actual log identified the native decision model type as clef. Model discovery advertised the requested model identity, and every evaluation response identified ggml-org/Clef-Flash-Q4_K_M. All ten responses returned HTTP 200 and passed the existing decision-response schema. The script checked that each outgoing state and questions object exactly matched the corresponding saved Jev request. The real RelevanceDetector applied the original filtering logic; JSON chat emulation and fabricated confidence values were not used.

## Comparison

Scores are coverage out of 100. Uncertain means the model produced a valid decision response, but the bot withheld the article because the Choice confidence gates did not clear 0.8.

| Article                       | Recorded Jev   | Recorded Laya  | Live Clef Q4_K_M |
| ----------------------------- | -------------- | -------------- | ---------------- |
| Cloud-native agent harness    | Approve / 91   | Uncertain / 58 | Uncertain / 49   |
| Personal Agent Protocol       | Uncertain / 79 | Uncertain / 58 | Uncertain / 52   |
| Grok finance-agent Slack leak | Uncertain / 64 | Uncertain / 58 | Uncertain / 51   |
| Claude for Google Workspace   | Approve / 89   | Uncertain / 59 | Uncertain / 50   |
| Five AI coding assistants     | Uncertain / 83 | Uncertain / 59 | Uncertain / 51   |
| Choosing an agentic framework | Uncertain / 78 | Uncertain / 62 | Uncertain / 51   |
| OpenAI's always-on agent      | Approve / 84   | Uncertain / 59 | Uncertain / 50   |
| Coding-agent reliability      | Uncertain / 63 | Uncertain / 57 | Uncertain / 48   |
| Python simulation             | Reject / 8     | Uncertain / 66 | Uncertain / 46   |
| Version-only title: v4.54.0   | Reject / 18    | Uncertain / 60 | Uncertain / 47   |

Jev approved three, rejected two, and withheld five. Both local model runs withheld all ten. Clef therefore missed all three recorded Jev approvals and did not produce definitive rejections on either exclusion control. Its minimum Choice confidence ranged from approximately 0.003 to 0.044. Its coverage scores were below the configured threshold in every case, so reducing only the confidence threshold would not restore deliveries.

## Sanity checks and limits

Two additional short native Clef requests were sent independently of the news comparison. A duplicate-charge refund request selected billing with probability 0.724 and confidence 0.448. An application-crash request selected technical with probability 0.831 and confidence 0.662. Both selected the expected team, though neither confidence cleared 0.8. These checks show that this local runtime can produce meaningful decisions; they do not establish calibration or news-filtering accuracy.

The conclusion is that this exact quantized model, backend, news questions, and unchanged thresholds do not preserve the current Jev delivery behavior. It is not evidence that every Clef variant has worse intrinsic accuracy. Confidence scales and calibration should not be assumed interchangeable across model/runtime implementations. Possible effects of quantization, native conversion, question design, and backend implementation were not isolated in this run. Inputs were titles and RSS excerpts, not full article bodies. Jev itself withheld five informally expected matches in the recorded baseline.

## Evidence

The adjacent clef-news-comparison-2026-10-07.json contains every actual Clef request and response, model identity, HTTP status, latency, confidence, coverage score, and identical-input checks. The original article texts and full Jev/Laya responses remain in news-model-comparison-2026-10-07.json. The two sanity-check requests and responses are in clef-sanity-2026-10-07.json. No API keys or authorization headers are saved.

The new scripts/compare-clef-news.ts is an opt-in local evaluation driver, separate from the mocked unit suite. Type checking, lint, formatting, CLI help, and the live inference path were checked. No production code or configuration was changed.

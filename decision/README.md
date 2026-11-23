# switch-decision

The decision service behind auto-route. When a room has auto-route on and a
message tags no agent, switch-core asks this service which agent in the room,
if any, should answer. The service puts the room's context to a decision model
as one choice (each candidate agent, plus "none") and only names an agent when
the model is sure enough: its confidence clears a threshold, or, with
`DECISION_MIN_LEAD` set, its top option leads the next one by that much (see
[Who gets the message](#who-gets-the-message)).

It is a small FastAPI app (`switch_decision`). It holds no state and keeps no
message content after answering.

## The default model

Production runs **Strands Decider 4B** (`StrandsAgents/strands-decider-E4B-gemma4-v1-2610`,
served as `strands-decider-E4B`) on one NVIDIA GPU, through the `systemone`
backend. The Helm chart's default (`decision.modelServer.kind: strands`) runs
it in a sidecar from the `switch-decision-strands` image
(`model-servers/strands/`). Local compose keeps **Qwen3.5-4B** on llama.cpp as
its default, because that one runs on a CPU.

Measured on one NVIDIA L4 (AWS g6.xlarge, eu-west-3) over 100 routing
scenarios (`eval/scenarios_hard.json` and `eval/scenarios_extra60.json`, the
60 written blind to the results), threshold 0.6:

| Model | Correct | Wrong picks | Stayed quiet wrongly | p50 / p95 |
|---|---|---|---|---|
| Strands Decider 4B (bf16) | **92/100** | **2** | 6 | 0.27 / 0.30 s |
| Qwen3.5-4B Q4_K_M (llama.cpp) | 88/100 | 9 | 3 | 0.16 / 0.17 s |

The wrong picks decide it: an agent answering a message that was not for it
is the failure people notice, and most of Qwen's errors were that (a question
for a named person, people talking among themselves). Strands Decider's misses
sat at 0.51–0.61 confidence, just under the threshold.

- **Licence.** `strands-decider` is Apache-2.0, but the 4B checkpoint is built
  on Google's Gemma 4 (`google/gemma-4-E4B-it`), whose terms apply to whoever
  deploys it. Nothing is baked into the image: the weights download from
  Hugging Face at deploy time into the deployment's own volume, and Switch does
  not redistribute them.
- **Hardware.** A GPU with 24 GB (an L4), an NVIDIA driver for CUDA 13.0 (580
  or later), and 32 GiB of RAM on the host: the 16 GB of bf16 weights pass
  through memory while loading. With 16 GiB, start-up took about 10.5 minutes;
  the server's port opens only once the model is loaded.
- **Switching to Qwen:** `decision.modelServer.kind: llamacpp` in the chart.
  The service needs nothing else: the backend (`llamacpp`) and model name
  follow the kind. In compose, Qwen is the `decision` and `decision-gpu`
  profiles, Strands Decider the `decision-strands-gpu` profile.

## Contract

switch-core talks only to this contract; the backend behind it is configuration.

- **`GET /health`** returns `200 {"ok": true, "backend", "model", "model_server",
  "model_server_status", "confidence_threshold", "min_lead", "backends_available",
  "fallback_backend", "fallback_model", "fallback_after_s",
  "fallback_confidence_threshold", "backends"}`, or
  `503 {"detail"}` when the default backend's model server is down (the
  fallback and the backends a request may name are not checked and never make
  the service unready). A model server whose `/health` answers 200 with an
  empty or non-JSON body (vLLM) is healthy: `model_server_status` is then
  `{"status": "ok", "body": "empty"}`. The top-level fields describe the
  default backend: its model, the threshold its answers are held to, and its
  fallback.
  `backends_available` is `["default", "anthropic"]`, plus `"bedrock"` when
  `DECISION_BEDROCK_ENABLED=1`, `"gemini_decision"` when
  `GEMINI_DECISION_API_KEY` is set, `"bedrock_openai"` when
  `DECISION_BEDROCK_OPENAI_ENABLED=1` and `"systemone"` when
  `DECISION_SYSTEMONE_ENABLED=1`; `bedrock`, `bedrock_openai` and `systemone`
  are listed without their flag when they are the default backend.
  `backends` describes what a request naming each of those gets, keyed the
  same way:

  ```json
  "backends": {
    "default": {"backend": "bedrock_openai", "model": "qwen.qwen3-235b-a22b-2507-v1:0",
                "label": "Qwen3 235B (Bedrock)", "threshold": 0.89, "fallback": null,
                "is_default": true},
    "anthropic": {"backend": "anthropic", "model": "claude-haiku-5-5",
                  "label": "Claude Haiku (Anthropic)", "threshold": 0.65, "fallback": null},
    "bedrock": {"backend": "bedrock", "model": "eu.anthropic.claude-haiku-5-5",
                "label": "Claude Haiku (Bedrock)", "threshold": 0.65, "fallback": null},
    "gemini_decision": {"backend": "gemini_decision", "model": "gemini-decision-1",
                        "label": "Gemini (gemini-decision-1)", "threshold": 0.8,
                        "fallback": {"backend": "bedrock",
                                     "model": "eu.anthropic.claude-haiku-5-5", "after_s": 2.0}},
    "bedrock_openai": {"backend": "bedrock_openai", "model": "qwen.qwen3-235b-a22b-2507-v1:0",
                       "label": "Qwen3 235B (Bedrock)", "threshold": 0.89, "fallback": null},
    "systemone": {"backend": "systemone", "model": "vllm-sr/d3-mini",
                  "label": "vllm-sr d3-mini (self-hosted)", "threshold": 0.56, "fallback": null}
  }
  ```

  `label` is a name for people (Switch Console shows it): `Qwen3 235B
  (Bedrock)`, `vllm-sr d3-mini (self-hosted)`, `Gemini (<model>)`,
  `Claude Haiku (Bedrock)`, `Claude Haiku (Anthropic)`, and the model id for
  any other model. `threshold` is the one that backend's answers are held to
  (see [Thresholds per backend](#thresholds-per-backend)); a request's own
  `confidence_threshold` still wins. `default` mirrors the default backend's
  entry and adds `"is_default": true`. It never needs a token.
- **`POST /decide`** takes `room` (`name`, `instructions`), `message` (`sender`,
  `text`, `thread_id`), `agents` (`name`, `description`, `role`), `thread`,
  `recent` and an optional `confidence_threshold`. It returns
  `{"agent", "model_choice", "confidence", "threshold", "rule", "min_lead", "lead", "reason", "model", "backend", "latency_ms"}`.
  `agent` is null for "none", for a pick the rule turned down (`rule` says
  which: `threshold` or `lead`), and for an answer that names an agent who is
  not a candidate (logged as an error). `lead` is the chosen option's
  probability minus the next one's, when the backend scores every option.
  `model` and `backend` are the ones that answered: the configured backend,
  the per-request override, or the fallback (see
  [Fallback](#fallback-after-n-seconds)). `latency_ms` is that backend's own
  call time, which switch-core records as the model time.

### Fallback after N seconds

A backend can have a fallback: `DECISION_FALLBACKS` lists them as
`primary:fallback` pairs, comma-separated (`gemini_decision:bedrock`).
Whenever that primary backend is used, as the service's default or because a
request named it with `X-Decision-Backend`, it races its fallback when it is
slow:

1. The primary backend is asked.
2. If it has not answered after `DECISION_FALLBACK_AFTER_S` seconds (default
   2), the fallback is asked too, and the primary keeps running. If the
   primary fails before then, the fallback is asked at once.
3. The first answer wins and the other call is cancelled. If one fails, the
   other is waited for. If both fail, the request fails with the primary
   backend's error (its `error_kind`), and the log line names the fallback's
   failure too.

`DECISION_FALLBACK_BACKEND`, from before, is still read: it is the default
backend's fallback, the same as `<DECISION_BACKEND>:<fallback>` in
`DECISION_FALLBACKS`, so it too applies when a request names the default
backend. A backend with no fallback is asked alone.

An answer that names an agent who is not a candidate is an answer, from
either backend, not a failure: it routes to nobody as before.

Which rule an answer is held to depends on who gave it. The primary's
answer keeps its own rule (see [Thresholds per backend](#thresholds-per-backend)).
The fallback's answer is held to `DECISION_FALLBACK_CONFIDENCE_THRESHOLD` by
the plain threshold rule, never the lead; unset, to the fallback backend's
own `DECISION_THRESHOLD_<BACKEND>`; with neither, it keeps the primary's rule.
A request that carries its own `confidence_threshold` (a workspace that set
one) is held to that for either backend, as before. The response's
`threshold` and the log line's `threshold=` are the one applied.

Why a threshold of its own: Haiku rates its confidence in coarse steps (0.6,
0.7, 0.8, 0.85), and on real traffic it did best at 0.65 (accuracy 0.965 and
recall 0.93, against 0.947 and 0.88 at 0.80), while Gemini did best at 0.80.

Two fallbacks are offered, both on the service's own AWS credentials:
`bedrock` (Claude Haiku on Amazon Bedrock, with `DECISION_BEDROCK_MODEL` and
`AWS_REGION`) and `bedrock_openai` (an open-weights model on Bedrock, with
`DECISION_BEDROCK_OPENAI_MODEL` and `DECISION_BEDROCK_OPENAI_REGION`). A
fallback needs no `DECISION_BEDROCK_ENABLED` or
`DECISION_BEDROCK_OPENAI_ENABLED`, which only govern whether a request may
choose that backend with `X-Decision-Backend`. The service refuses to start
with an entry that is not `primary:fallback`, a primary that is not a
backend or that no request can get (`bedrock_openai`, `systemone`, `bedrock`,
`llamacpp` or `ollama` when it is neither `DECISION_BACKEND` nor enabled per
request), a primary named twice, any other fallback, a fallback the same as
its primary, `DECISION_FALLBACK_BACKEND` and `DECISION_FALLBACKS` disagreeing
about the default backend, or a delay that is not more than 0 and less than
`DECISION_TIMEOUT_S`.

Why: Google's Decisions API usually answers in 0.3 to 0.5 s, but in some
periods 15 to 45% of its calls take 5 to 30 s, and a retry is just as slow,
while switch-core gives up on a decision after 5 s. Haiku on Bedrock answered
real decide requests in 1.7 s at the median, 2.0 s at p95 and 2.5 s at most,
with nearly the same accuracy. A cancelled Bedrock call cannot be stopped
mid-flight (boto3 runs in a thread); its answer is dropped.

### Thresholds per backend

Each backend's probabilities sit on its own scale, so one threshold does not
fit them all. `DECISION_THRESHOLD_<BACKEND>` (the backend's name in capitals:
`DECISION_THRESHOLD_BEDROCK_OPENAI`, `DECISION_THRESHOLD_SYSTEMONE`,
`DECISION_THRESHOLD_GEMINI_DECISION`, `DECISION_THRESHOLD_BEDROCK`,
`DECISION_THRESHOLD_ANTHROPIC`, ...) is the threshold an answer from that
backend is held to, by the plain threshold rule, whether it answered as the
default, as the backend a request named, or as a fallback (unless
`DECISION_FALLBACK_CONFIDENCE_THRESHOLD` is set). A backend without one keeps
`DECISION_CONFIDENCE_THRESHOLD`, or the `DECISION_MIN_LEAD` rule, as before.
A request's own `confidence_threshold` wins over all of them. The service
refuses to start with a value outside 0 to 1, or a
`DECISION_THRESHOLD_` variable that names no backend.

The thresholds that did best on 164 labelled real decisions, and what they
scored on all 260 labelled real decisions (the other 96 held out). Latency was
measured one request at a time, from outside the cloud region for Bedrock:

| Backend | Model | Threshold | Accuracy (260 real) | `/decide` p50 / p95 |
|---|---|---|---|---|
| `bedrock_openai` | Qwen3 235B A22B Instruct 2507 | 0.89 | 0.962 | 0.23 / 0.46 s |
| `systemone` | vllm-sr d3-mini on vLLM, one NVIDIA L4 | 0.56 | 0.946 | 0.35 / 0.99 s |
| `gemini_decision` | gemini-decision-1 | 0.80 | 0.973 | usually 0.3 to 0.5 s (see [Fallback](#fallback-after-n-seconds)) |
| `bedrock`, `anthropic` | Claude Haiku | 0.65 | 0.965 | 1.7 / 2.0 s (Bedrock) |

### Who gets the message

The model scores each candidate agent and "none". By default the chosen agent
gets the message when its confidence is at least the threshold
(`DECISION_CONFIDENCE_THRESHOLD`, or the request's `confidence_threshold`).

With `DECISION_MIN_LEAD` set, a backend that scores every option (`systemone`,
`llamacpp`, `gemini_decision`) uses the lead rule instead: the top option wins when it leads the
next option, another agent or "none", by at least that much, and "none" on top
reaches nobody. A request that sends its own `confidence_threshold` (a
workspace that set one) keeps the threshold rule, and so do backends that rate
a single confidence (`anthropic`, `bedrock`, `ollama`).

Why: with "none" as one of the options, Strands spreads its probability over
"none" and the agents, so a message plainly for one agent can sit at 0.45 with
"none" at 0.37 and stay undelivered under a 0.5 bar. On the 124 eval scenarios
(`scenarios_hard`, `scenarios_extra60`, `scenarios_names`) Strands Decider 4B
scored the same with a lead of 0.05 as with a 0.5 threshold (112 correct, 11
answered when nobody should, 1 missed), and six real pilot messages for a
named agent all reached it, against five of six with the threshold. Plain
argmax (a lead of 0) answered two more messages that were for nobody, both
near ties with "none".

### When the sender is talking to an agent

Every backend gets more context when the sender is mid-exchange with an agent, which is when one of these holds in the conversation the message belongs to (the thread, or the room for a top-level message):

- the sender and one agent have been going back and forth, with nobody else in between;
- in a thread, an agent spoke or was addressed most recently;
- the message just before this one is from an agent, and it addressed the sender or answered them.

The state then gains a "Conversation state" block, just before the latest message, with one line for each fact that holds:

```
Conversation state:
- nora's current back-and-forth with agents, nobody else speaking in between: manager (1)
- In this thread, the last agent to speak or be addressed is manager; nobody else has spoken since.
- The message just before this one is from manager, to nora.
```

The model's instructions also gain a rule: a message right after an agent answered or addressed the sender continues that conversation and is for that agent, even when it is short, unless it answers or names another person. Strands gets it as one sentence in its instructions. The system prompt (Haiku, Bedrock, Ollama) and Gemini's input spell it out further: it holds only when the agent's message was to the sender, and a reply to another person (an answer to their question, a response to what they just said, a message naming them) is for nobody, even right after an agent spoke or in an agent's thread.

Why the two wordings: Gemini gave a colleague's short reply in an agent's thread ("yeah", "yes let's do that") to that agent, getting 1 of the 8 such cases in `scenarios_followups` right. Spelled out, it gets 6 of 8 with a lead of 0.10 and 8 of 8 (up from 5) with a 0.8 threshold, with no other change on the synthetic sets and none for the worse on the clear-label real decisions. Haiku got the same or better. Strands with the longer wording missed real continuations it had delivered, so its instructions keep the one sentence.

When none of these holds, the request is exactly as it was without this context. The decide log line ends with `context=exchange` or `context=none`.

Why: auto-route rooms skip switch-core's thread follow-up rule, and a short reply to the agent a person was talking to ("ok what else", "yes", "merged") often had "none" scored above that agent. On a labelled set of real messages, the context and the sentence turned misses into deliveries without adding wrong picks elsewhere. A room's people count was tried and left out: it changed nothing on real traffic, and misled the model when the history was short.
- **Status codes:** `422` for a bad body, `502 {"detail", "error_kind"}` when
  the backend failed (see "Error kinds" below), `401` when a service token is
  set and the request lacks it, and `400 {"detail", "code": "backend_unavailable"}`
  for an unknown or unavailable backend override.
- **`X-Request-Id`:** switch-core sends its decision id in this header. The
  service writes it as `request_id` on every log line for that request
  (the decide line and the access line) and echoes it on the response. When
  the header is missing, or is not 1 to 128 characters of letters, digits and
  `.`, `_`, `:`, `-`, the service uses a fresh id instead.
- **Auth:** with `DECISION_SERVICE_TOKEN` set, every request except
  `GET /health` needs `Authorization: Bearer <token>`. Unset means no auth,
  for use inside a cluster behind a NetworkPolicy.
- **The model server's token:** with `MODEL_SERVER_TOKEN` set, the service
  sends it as `Authorization: Bearer <token>` to the llama.cpp and SystemOne
  servers, so they can require it: llama.cpp with `--api-key` (or
  `LLAMA_API_KEY`), the Strands server with `STRANDS_API_KEY`. Neither guards
  `/health`. Never logged.
- **Per-request backend override**, so a workspace can choose its model
  without a restart. The headers are never logged.
  - `X-Decision-Backend`: `default` (or absent) for the configured backend;
    `anthropic`, which needs `X-Decision-Anthropic-Key`; `bedrock`, refused
    unless `DECISION_BEDROCK_ENABLED=1` or it is the default (it spends the
    service's own AWS credentials); `gemini_decision`, which takes
    `X-Decision-Gemini-Key` or, without it, the service's
    `GEMINI_DECISION_API_KEY` (refused when neither is there);
    `bedrock_openai`, refused unless `DECISION_BEDROCK_OPENAI_ENABLED=1` or it
    is the default; or `systemone`, the service's own SystemOne model server
    (`SYSTEMONE_URL`, model `DECISION_SYSTEMONE_MODEL`), refused unless
    `DECISION_SYSTEMONE_ENABLED=1` or it is the default. A backend with a
    fallback in `DECISION_FALLBACKS` races it however it was chosen.
  - `X-Decision-Anthropic-Key`: the Anthropic key for this request. Clients
    are cached by a SHA-256 of the key.
  - `X-Decision-Gemini-Key`: the Google API key for this request.
  - `X-Decision-Model`: the model for `anthropic` (default `claude-haiku-5-5`),
    `bedrock` (default `DECISION_BEDROCK_MODEL`), `gemini_decision`
    (default `DECISION_GEMINI_MODEL`), `bedrock_openai` (default
    `DECISION_BEDROCK_OPENAI_MODEL`) or `systemone` (default
    `DECISION_SYSTEMONE_MODEL`).
- **Logs:** one line per decision: backend, model, number of candidates,
  choice, confidence, threshold, pick and latency, the rule, the lead and
  whether the conversation context was used (`context=`), plus
  the error kind when it
  failed. No message text, room name, room instructions or keys, and no error
  body from the backend. See "Logs" below.

### Error kinds

A failed model call answers `502` with `detail` (a human-readable reason, as
before) and `error_kind`, one of a fixed set. switch-core counts failures by
`error_kind` and never reads `detail`.

| `error_kind` | What happened |
|---|---|
| `model_server_unreachable` | could not connect to the model server or API (refused, DNS, connect timeout, connection dropped) |
| `model_server_timeout` | connected, but no answer within `DECISION_TIMEOUT_S` (read timeout, `504`, Bedrock `ModelTimeoutException`) |
| `model_server_error` | the server answered with an error (`5xx`, `400`), or with something that is not a decision (not JSON, no pick, no option letter) |
| `model_unavailable` | the model is not there yet or at all: llama.cpp `503` while loading, Ollama `404` for a model not pulled, Anthropic `404`/`529`, Bedrock `ResourceNotFoundException`/`ModelNotReadyException` |
| `credentials_missing` | no `ANTHROPIC_API_KEY` for the `anthropic` backend, no Google key for `gemini_decision`, or no AWS credentials for Bedrock |
| `backend_refused` | the server refused the call: `401`/`403` (a wrong `MODEL_SERVER_TOKEN` or key), `429`, Bedrock access denied or throttled, the model declined to answer (a refusal or guardrail), or Google's `400` for a key it won't take or an input it blocked (`safety`, `blocklist`, ...) |

An answer that names an agent who is not a candidate is not a failure: it is
`200` with `agent: null`.

## Backends

| `DECISION_BACKEND` | What it calls | Default `DECISION_MODEL` |
|---|---|---|
| `llamacpp` (the image's default) | a llama.cpp server; reads the probabilities of the option letters from the first token | `qwen3.5-4b-q4_k_m` |
| `systemone` | a SystemOne-API server: Strands Decider (the chart's default, `DECISION_MODEL=strands-decider-E4B`) or Clef-flash | `clef-flash` |
| `anthropic` | Claude Haiku on the Anthropic API, forced to call a pick tool; thinking off | `claude-haiku-5-5` |
| `bedrock` | a model on Amazon Bedrock through Converse, forced to call the same tool | `us.anthropic.claude-haiku-5-5` (EU regions: `eu.anthropic.claude-haiku-5-5`) |
| `bedrock_openai` | an open-weights model on Amazon Bedrock through InvokeModel with an OpenAI chat body (Converse returns no logprobs); reads the probabilities of the option letters from the first token, like `llamacpp`, with Bedrock's maximum of 20 top logprobs. The model must not think before answering (Qwen3 2507 Instruct does not) | `qwen.qwen3-235b-a22b-2507-v1:0`, in `DECISION_BEDROCK_OPENAI_REGION` |
| `gemini_decision` | Google's Decisions API: one `choice` question over the agents and a `nobody` option, with the routing rules and the room state as plain text; every option is scored, so the lead rule applies. The reason is empty | `gemini-decision-1` |
| `ollama` | an Ollama model forced into JSON, kept for comparison | `qwen3.5:9b` |

## Settings

| Variable | Default | |
|---|---|---|
| `DECISION_BACKEND` | `llamacpp` | see above |
| `DECISION_MODEL` | per backend | reported by `/health` and `/decide` |
| `LLAMACPP_URL` | `http://127.0.0.1:8300` | llama.cpp server |
| `SYSTEMONE_URL` | `http://127.0.0.1:8100/v1/systemone` | SystemOne server (Strands, or vLLM's native `/v1/systemone` for vllm-sr d3-mini) |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama |
| `DECISION_CONFIDENCE_THRESHOLD` | `0.6` | 0 to 1; a request can override it |
| `DECISION_MIN_LEAD` | unset | 0 to 1. Set, the lead rule replaces the threshold for a backend that scores every option (`systemone`, `llamacpp`): see [Who gets the message](#who-gets-the-message) |
| `DECISION_TIMEOUT_S` | `30` | per backend call |
| `DECISION_HISTORY_LIMIT` | `8` | recent and thread messages kept, each (8 recent + 8 thread). Measured on an L4: a room at switch-core's full limits took 0.55 s with 30 and 0.23 s with 8, with the same accuracy |
| `DECISION_WITH_REASON` | `1` | `0` drops the reason from Haiku's tool call |
| `DECISION_SERVICE_TOKEN` | unset | bearer token for everything but `/health` |
| `MODEL_SERVER_TOKEN` | unset | bearer token sent to the llama.cpp or SystemOne server |
| `DECISION_BEDROCK_ENABLED` | unset | `1` lets a request choose `bedrock` |
| `DECISION_BEDROCK_MODEL` | `us.anthropic.claude-haiku-5-5` | Bedrock model or inference profile, for a `bedrock` request, backend or fallback. The `us.` profile serves US regions; EU regions (`AWS_REGION=eu-west-3`, ...) need `eu.anthropic.claude-haiku-5-5` |
| `DECISION_BEDROCK_OPENAI_ENABLED` | unset | `1` lets a request choose `bedrock_openai` |
| `DECISION_BEDROCK_OPENAI_MODEL` | `qwen.qwen3-235b-a22b-2507-v1:0` | the Bedrock open-weights model, for a `bedrock_openai` request, backend or fallback |
| `DECISION_BEDROCK_OPENAI_REGION` | `eu-central-1` | its region, separate from `AWS_REGION` (Haiku's) |
| `DECISION_SYSTEMONE_ENABLED` | unset | `1` lets a request choose `systemone`; needs `SYSTEMONE_URL` and `DECISION_SYSTEMONE_MODEL` (startup fails without them) unless `systemone` is the default |
| `DECISION_SYSTEMONE_MODEL` | `DECISION_MODEL` when the backend is `systemone` | the model name the SystemOne server serves (vLLM's `--served-model-name`) |
| `DECISION_THRESHOLD_<BACKEND>` | unset | 0 to 1: the threshold that backend's answers are held to. See [Thresholds per backend](#thresholds-per-backend) |
| `DECISION_FALLBACKS` | unset | `primary:fallback` pairs, comma-separated; the fallback is `bedrock` or `bedrock_openai`. See [Fallback](#fallback-after-n-seconds) |
| `DECISION_FALLBACK_BACKEND` | unset | the default backend's fallback (`bedrock` or `bedrock_openai`), as in `DECISION_FALLBACKS`; unset or empty, none |
| `DECISION_FALLBACK_AFTER_S` | `2` | seconds a primary backend has before its fallback is asked too; more than 0 and less than `DECISION_TIMEOUT_S`. Read only with a fallback |
| `DECISION_FALLBACK_CONFIDENCE_THRESHOLD` | unset | 0 to 1: the threshold any fallback's answer is held to (plain threshold rule, no lead). Unset, the fallback backend's own threshold, else the primary's rule. A request's own threshold wins over it. Read only with a fallback |
| `AWS_REGION`, `AWS_PROFILE` | `us-east-1`, unset | standard AWS credential chain |
| `ANTHROPIC_API_KEY` | unset | service-wide key when `DECISION_BACKEND=anthropic` |
| `GEMINI_DECISION_API_KEY` | unset | Google API key for `gemini_decision`; required (startup fails without it) when `DECISION_BACKEND=gemini_decision`. Never logged |
| `DECISION_GEMINI_MODEL` | `gemini-decision-1` | the Decisions API model |
| `GEMINI_DECISION_URL` | `https://generativelanguage.googleapis.com/v1beta/decisions` | the Decisions API endpoint |
| `PORT` | `8230` | the image's listen port |
| `LOG_FORMAT` | `text` | `json` for one JSON object per line, in switch-core's layout |
| `LOG_LEVEL` | `INFO` | the root level |
| `SERVICE_NAME` | `switch-decision` | `service` on every JSON line and in shipped logs |
| `ENVIRONMENT` | unset | `env` on every JSON line (the deployment: pilot, development, …) |
| `POD_NAME` | unset | the pod (from the downward API); the host name stands in when unset |
| `OTLP_ENDPOINT` | unset | an OTLP/HTTP collector's base URL, with no path; logs go to `/v1/logs` |
| `OTLP_LOGS_ENABLED` | `false` | with `OTLP_ENDPOINT`, also ship logs to the collector |
| `OTLP_HEADERS` | unset | `key=value` pairs, comma-separated, on every request to the collector |
| `OTLP_TIMEOUT_SECONDS` | `10` | per request to the collector |
| `DEPLOYMENT_ID` | unset | a UUID naming the deployment; required when logs are shipped |

The logging and OTLP settings are switch-core's, read the same way, so a
deployment sets them once for both.

## Logs

Logs go to stderr. `LOG_FORMAT=text` is one readable line per record;
`LOG_FORMAT=json` is one JSON object per line with the same fields as
switch-core's:

```
{"timestamp": "2026-11-09T14:03:04.811+00:00", "status": "warning",
 "message": "decide failed backend=llamacpp model=qwen3.5-4b-q4_k_m candidates=1 latency_ms=0 error_kind=model_server_unreachable error=…",
 "logger": {"name": "switch_decision", "thread_name": "MainThread"},
 "service": "switch-decision", "process_id": "decision-pod-0-d0fad9fb",
 "env": "pilot", "version": "0.1.0", "request_id": "3f2b9c1d…"}
```

- `process_id` is the pod (or host) name followed by a random suffix drawn at
  each start, so two lives of one pod read apart. `version` is the installed
  `switch-decision` package's version. `env` and `version` are left out when
  unknown. A logged exception adds `error` (`kind`, `message`, `stack`).
- `request_id` is the `X-Request-Id` of the request the line was written
  for. Search for switch-core's decision id to find the service's line for it.
- With a fallback configured for the backend a request used, the decide
  line names the backend and model that answered and adds
  `fallback=` (`not_needed`: the default answered before the delay; `won`:
  the fallback answered first; `lost`: the fallback started, the default
  answered first; `primary_failed`: the default failed, the fallback
  answered), `fallback_reason=` (`slow`, or the default's error kind; `-` when
  the fallback did not start) and `total_ms=` (the whole decision; `latency_ms`
  is the answering call's own time). A failure on either side is named:
  `primary_error=`, or `fallback_error_kind=` and `fallback_error=`, and the
  line is then a warning. When both fail the `decide failed` line, which
  names the default backend's error as before, adds `fallback=failed`,
  `fallback_reason=`, `fallback_backend=`, `fallback_model=`,
  `fallback_error_kind=`, `fallback_error=` and `total_ms=`. For a backend
  without a fallback none of these appear.
- uvicorn's own lines go through the same handler. Its access log leaves out
  `GET /health` (the probes) and cuts the query string off every other path.
- Never logged: message text, room names and instructions, keys and tokens,
  and error bodies from the model server. The Anthropic SDK, botocore and
  httpx write request bodies at `DEBUG`, so they stay at `WARNING` whatever
  `LOG_LEVEL` says.

**Shipping to a collector.** With `OTLP_ENDPOINT` set and
`OTLP_LOGS_ENABLED=true` (and `DEPLOYMENT_ID`), the service also sends every
record to `<OTLP_ENDPOINT>/v1/logs` as OTLP/HTTP JSON, every 5 seconds, with
`request_id` as an attribute and `service.name`, `service.version`,
`service.instance.id` (the `process_id`) and `deployment.environment` on the
resource. stderr stays the primary copy. The queue holds 10,000 records and
drops the oldest when the collector falls behind, saying how many on stderr;
a failed export is a warning on stderr and is never itself shipped; logging
never waits on the collector. On shutdown it tries to send what is left for
up to 2 seconds and reports anything it could not. With no `OTLP_ENDPOINT`
nothing is sent and nothing is logged about it.

## Run locally

Start a llama.cpp server with a Qwen3.5-4B GGUF (4-bit), then the service:

```
llama-server -m qwen3.5-4b-q4_k_m.gguf --port 8300
cd decision
uv sync
uv run uvicorn switch_decision.app:app --port 8230
curl localhost:8230/health
uv run pytest
```

With JSON logs, and a request id to find in them:

```
LOG_FORMAT=json uv run uvicorn switch_decision.app:app --port 8230
curl -s localhost:8230/decide -H 'X-Request-Id: try-1' -H 'Content-Type: application/json' \
  -d '{"room": {"name": "r"}, "message": {"sender": "s", "text": "who deploys?"},
       "agents": [{"name": "deploy-bot", "description": "CI and deploys"}]}'
```

The decide line and the access line both carry `"request_id": "try-1"`. With
the model server stopped, the answer is
`502 {"detail": …, "error_kind": "model_server_unreachable"}`.

## Run with Docker

The `switch-decision` image is CPU-only and holds no model weights. The model
runs in its own container, with the weights in a volume.

Strands Decider (Linux, an NVIDIA GPU with 24 GB, the NVIDIA Container
Toolkit). `switch-decision-strands` serves on :8400; the first start
downloads the checkpoint and its base model (about 17 GB) into `/models`.
`HF_TOKEN` is optional. The image runs its own `serve.py` rather than
`strands-decider serve`: it merges the checkpoint's LoRA adapter into the base
weights once at load, which on an L4 gives the same answers in 0.26 s instead
of 0.42 s for a typical room and about 3.9 decisions a second instead of 2.4.
It's configured by env only (`STRANDS_CHECKPOINT`, `STRANDS_REVISION`,
`STRANDS_BASE_REVISION`, `STRANDS_MODEL_NAME`, `STRANDS_MAX_BATCH`, and
`STRANDS_API_KEY`, which when set is required as a bearer token on everything
but `/health`). The image
pins the checkpoint and its base model to Hugging Face commits
(`STRANDS_REVISION`, `STRANDS_BASE_REVISION`); the base revision must be the one
the checkpoint records in its `provenance.json`, or the server refuses to
start:

```
docker build -t switch-decision-strands decision/model-servers/strands/
docker run -d --gpus all -v decision-hf:/models -p 8400:8400 switch-decision-strands
docker run -d -p 8230:8230 \
  --add-host=host.docker.internal:host-gateway \
  -e DECISION_BACKEND=systemone -e DECISION_MODEL=strands-decider-E4B \
  -e SYSTEMONE_URL=http://host.docker.internal:8400/v1/systemone \
  switch-decision
```

The image pins `strands-decider==0.2.0` and every dependency by hash
(`model-servers/strands/requirements.txt`, compiled from `requirements.in`
with the command at its top). `STRANDS_CHECKPOINT`, the two revisions and
`STRANDS_MODEL_NAME` choose another checkpoint.

Qwen3.5-4B on the llama.cpp server image:

```
docker build -t switch-decision decision/

# the model server (NVIDIA GPU)
docker run -d --gpus all -v decision-models:/models -p 8300:8080 \
  ghcr.io/ggml-org/llama.cpp:server-cuda \
  -m /models/qwen3.5-4b-q4_k_m.gguf --host 0.0.0.0 --port 8080 -ngl 99

# the service
docker run -d -p 8230:8230 \
  --add-host=host.docker.internal:host-gateway \
  -e LLAMACPP_URL=http://host.docker.internal:8300 \
  switch-decision
```

Without a GPU, use the `ghcr.io/ggml-org/llama.cpp:server` image and drop
`--gpus` and `-ngl`. Expect several seconds per decision.

To use Haiku only, no model server is needed: set
`DECISION_BACKEND=anthropic` and `ANTHROPIC_API_KEY`, or leave the default
backend and send the override headers per request.

## Licences of the Strands image

`switch-decision-strands` installs `strands-decider` (Apache-2.0) and every
dependency pinned by hash in `model-servers/strands/requirements.txt`. Most
are under permissive licences (Apache-2.0, MIT, BSD). Two groups are worth
naming, and licence scanners flag the second:

- **PyTorch** (`torch`): BSD-3-Clause.
- **NVIDIA's CUDA runtime libraries**, the `nvidia-*` wheels PyTorch depends
  on (cuBLAS, cuDNN, cuFFT, cuFile, cuRAND, cuSOLVER, cuSPARSE, NVRTC, CUPTI,
  NVTX, NCCL and the rest): proprietary, under NVIDIA's end user licence
  agreement for CUDA, which allows them to be redistributed as part of an
  application that uses them. Their package metadata says "Other/Proprietary
  License", which is what the scanners report. The base image,
  `nvidia/cuda:13.0.3-base-ubuntu24.04`, comes under NVIDIA's terms too.

**The decision: ship them.** The model server needs CUDA to run on a GPU, and
these are NVIDIA's own runtime packages, used unmodified and in the way the
EULA provides for. Nothing of them is in Switch's source: this repository
names them, pinned by version and hash, and nothing more. The image is built
by Switch's release CI and published to its registry, and a deployment pulls
it at deploy time, in the same way it pulls the model weights from Hugging
Face; neither is vendored into the source. Anyone who can't accept NVIDIA's
terms can run without this image: Qwen on llama.cpp's CPU image (compose's
`decision` profile), or Haiku with no model server
(`decision.modelServer.enabled: false` in the chart).

## Evaluate

`eval/` holds the scenario sets:

- `scenarios_hard.json`: 40 cases, five agents with overlapping jobs. Regenerate it with `eval/make_hard_scenarios.py`.
- `scenarios_extra60.json`: 60 cases across four rooms.
- `scenarios_names.json`: 24 cases where an agent is named in plain text. Spoken to, it answers. Only mentioned, quoted, or named in code or a link, it doesn't. Each case's `note` says which.
- `scenarios_followups.json`: 45 cases from a busy team room. They cover:
  - replies that continue an exchange with an agent, in a thread and at the top level, often short ("ok what else", "yes", "merged");
  - people answering people inside an agent's thread;
  - agents spoken to by a spoken form of their name;
  - announcements and requests aimed at people;
  - people talking about an agent rather than to it.

  Regenerate it with `eval/make_followups_scenarios.py`. It is written from patterns seen in real rooms, reworded, with made-up people.
- `scenarios.json`: 15 easy cases, three agents.

**History.** Every case in the first three sets carries a `background`: three to five earlier messages from people talking among themselves. `eval.py` sends them before the case's own history, so no case is decided on the message alone. `eval/add_history.py` writes them with a fixed seed. Run it again after regenerating a set.

The standard run is the hard, extra60, names and followups sets:

```
uv run python eval/eval.py --all --url http://localhost:8230
uv run python eval/eval.py --url http://localhost:8230 --file eval/scenarios_followups.json
# through the Haiku override (reads ANTHROPIC_API_KEY)
uv run python eval/eval.py --all --url http://localhost:8230 --backend anthropic
# through the Gemini Decisions override (sends GEMINI_DECISION_API_KEY when set,
# else the service uses its own)
uv run python eval/eval.py --all --url http://localhost:8230 --backend gemini_decision
```

`DECISION_SERVICE_TOKEN` is sent when set. For each set it prints every pick, then four counts:
- **right**;
- **wrong**: the wrong agent, or an agent when nobody should answer;
- **missed**: nobody, when an agent should answer;
- **precision of deliveries**.

It also prints the median and maximum latency. `--all` ends with one table of all the sets.

Strands Decider 4B with the lead rule (0.05), before the conversation-state context:

| set | right | wrong | missed |
|---|---|---|---|
| hard | 36/40 | 3 | 1 |
| extra60 | 52/60 | 8 | 0 |
| names | 16/24 | 7 | 1 |
| followups | 29/45 | 5 | 11 |

Adding the history made the benchmark harder: the same model and prompt scored 112 right, 11 wrong and 1 missed over the first three sets without it, against 104, 18 and 2 with it.

A change to what the service sends its model is also checked against a labelled set of real messages from a deployment, before it merges. That set holds people's messages, so it is never kept in this repository; the pull request reports only its counts.

## Latency so far

On the 40-scenario hard set:

- **On one NVIDIA L4:** Strands Decider 4B 36/40 at 0.20 s median, Qwen3.5-4B
  (4-bit) 34/40 at 0.15 s, Strands Decider 2B 29/40 at 0.11 s. The
  100-scenario comparison is under "The default model" above.
- **Haiku 5.5 via the Anthropic API:** 39/40, 1.4–1.6 s median, about 2.7 s
  p95. About 0.65 s of each call is fixed API and network overhead.
- **On an Apple M4 Pro (no NVIDIA GPU):** Qwen3.5-4B 34/40 at 0.61 s median;
  Strands Decider 4B 36/40 at 1.06 s, and it needs 16 GB of the Mac's memory.

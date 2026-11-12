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
  "model_server_status", "confidence_threshold", "min_lead", "backends_available"}`, or
  `503 {"detail"}` when the default backend's model server is down.
  `backends_available` is `["default", "anthropic"]`, plus `"bedrock"` when
  `DECISION_BEDROCK_ENABLED=1`. It never needs a token.
- **`POST /decide`** takes `room` (`name`, `instructions`), `message` (`sender`,
  `text`, `thread_id`), `agents` (`name`, `description`, `role`), `thread`,
  `recent` and an optional `confidence_threshold`. It returns
  `{"agent", "model_choice", "confidence", "threshold", "rule", "min_lead", "lead", "reason", "model", "backend", "latency_ms"}`.
  `agent` is null for "none", for a pick the rule turned down (`rule` says
  which: `threshold` or `lead`), and for an answer that names an agent who is
  not a candidate (logged as an error). `lead` is the chosen option's
  probability minus the next one's, when the backend scores every option.

### Who gets the message

The model scores each candidate agent and "none". By default the chosen agent
gets the message when its confidence is at least the threshold
(`DECISION_CONFIDENCE_THRESHOLD`, or the request's `confidence_threshold`).

With `DECISION_MIN_LEAD` set, a backend that scores every option (`systemone`,
`llamacpp`) uses the lead rule instead: the top option wins when it leads the
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
- **Per-request backend override**, so a workspace can choose Haiku without a
  restart. The headers are never logged.
  - `X-Decision-Backend`: `default` (or absent) for the configured backend;
    `anthropic`, which needs `X-Decision-Anthropic-Key`; or `bedrock`, refused
    unless `DECISION_BEDROCK_ENABLED=1` (it spends the service's own AWS
    credentials).
  - `X-Decision-Anthropic-Key`: the Anthropic key for this request. Clients
    are cached by a SHA-256 of the key.
  - `X-Decision-Model`: the model for `anthropic` (default `claude-haiku-5-5`)
    or `bedrock` (default `DECISION_BEDROCK_MODEL`).
- **Logs:** one line per decision: backend, model, number of candidates,
  choice, confidence, threshold, pick and latency, the rule and the lead, plus
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
| `credentials_missing` | no `ANTHROPIC_API_KEY` for the `anthropic` backend, or no AWS credentials for Bedrock |
| `backend_refused` | the server refused the call: `401`/`403` (a wrong `MODEL_SERVER_TOKEN` or key), `429`, Bedrock access denied or throttled, or the model declined to answer (a refusal or guardrail) |

An answer that names an agent who is not a candidate is not a failure: it is
`200` with `agent: null`.

## Backends

| `DECISION_BACKEND` | What it calls | Default `DECISION_MODEL` |
|---|---|---|
| `llamacpp` (the image's default) | a llama.cpp server; reads the probabilities of the option letters from the first token | `qwen3.5-4b-q4_k_m` |
| `systemone` | a SystemOne-API server: Strands Decider (the chart's default, `DECISION_MODEL=strands-decider-E4B`) or Clef-flash | `clef-flash` |
| `anthropic` | Claude Haiku on the Anthropic API, forced to call a pick tool; thinking off | `claude-haiku-5-5` |
| `bedrock` | a model on Amazon Bedrock through Converse, forced to call the same tool | `us.anthropic.claude-haiku-5-5-v1:0` |
| `ollama` | an Ollama model forced into JSON, kept for comparison | `qwen3.5:9b` |

## Settings

| Variable | Default | |
|---|---|---|
| `DECISION_BACKEND` | `llamacpp` | see above |
| `DECISION_MODEL` | per backend | reported by `/health` and `/decide` |
| `LLAMACPP_URL` | `http://127.0.0.1:8300` | llama.cpp server |
| `SYSTEMONE_URL` | `http://127.0.0.1:8100/v1/systemone` | SystemOne server |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama |
| `DECISION_CONFIDENCE_THRESHOLD` | `0.6` | 0 to 1; a request can override it |
| `DECISION_MIN_LEAD` | unset | 0 to 1. Set, the lead rule replaces the threshold for a backend that scores every option (`systemone`, `llamacpp`): see [Who gets the message](#who-gets-the-message) |
| `DECISION_TIMEOUT_S` | `30` | per backend call |
| `DECISION_HISTORY_LIMIT` | `8` | recent and thread messages kept, each (8 recent + 8 thread). Measured on an L4: a room at switch-core's full limits took 0.55 s with 30 and 0.23 s with 8, with the same accuracy |
| `DECISION_WITH_REASON` | `1` | `0` drops the reason from Haiku's tool call |
| `DECISION_SERVICE_TOKEN` | unset | bearer token for everything but `/health` |
| `MODEL_SERVER_TOKEN` | unset | bearer token sent to the llama.cpp or SystemOne server |
| `DECISION_BEDROCK_ENABLED` | unset | `1` lets a request choose `bedrock` |
| `DECISION_BEDROCK_MODEL` | `us.anthropic.claude-haiku-5-5-v1:0` | Bedrock model or inference profile |
| `AWS_REGION`, `AWS_PROFILE` | `us-east-1`, unset | standard AWS credential chain |
| `ANTHROPIC_API_KEY` | unset | service-wide key when `DECISION_BACKEND=anthropic` |
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

`eval/` holds four scenario sets: `scenarios.json` (15 easy cases, three agents),
`scenarios_hard.json` (40 cases, five agents with overlapping jobs; regenerate
it with `eval/make_hard_scenarios.py`), `scenarios_extra60.json` (60 cases
across four rooms), and `scenarios_names.json` (24 cases where an agent is
named in plain text: spoken to, so it answers, or only mentioned, quoted or
named in code or a link, so it doesn't; each case's `note` says which). The
standard run is the hard, extra60 and names sets.

```
uv run python eval/eval.py --url http://localhost:8230
uv run python eval/eval.py --url http://localhost:8230 --file eval/scenarios_hard.json
uv run python eval/eval.py --url http://localhost:8230 --file eval/scenarios_extra60.json
uv run python eval/eval.py --url http://localhost:8230 --file eval/scenarios_names.json
# through the Haiku override (reads ANTHROPIC_API_KEY)
uv run python eval/eval.py --url http://localhost:8230 --file eval/scenarios_hard.json --backend anthropic
```

`DECISION_SERVICE_TOKEN` is sent when set. It prints each pick, then the
accuracy and the median and maximum latency.

## Latency so far

On the 40-scenario hard set:

- **On one NVIDIA L4:** Strands Decider 4B 36/40 at 0.20 s median, Qwen3.5-4B
  (4-bit) 34/40 at 0.15 s, Strands Decider 2B 29/40 at 0.11 s. The
  100-scenario comparison is under "The default model" above.
- **Haiku 5.5 via the Anthropic API:** 39/40, 1.4–1.6 s median, about 2.7 s
  p95. About 0.65 s of each call is fixed API and network overhead.
- **On an Apple M4 Pro (no NVIDIA GPU):** Qwen3.5-4B 34/40 at 0.61 s median;
  Strands Decider 4B 36/40 at 1.06 s, and it needs 16 GB of the Mac's memory.

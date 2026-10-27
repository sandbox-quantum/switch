# switch-decision

The decision service behind auto-route. When a room has auto-route on and a
message tags no agent, switch-core asks this service which agent in the room,
if any, should answer. The service puts the room's context to a decision model
as one choice (each candidate agent, plus "none") and only names an agent when
the model's confidence clears a threshold.

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
  "model_server_status", "confidence_threshold", "backends_available"}`, or
  `503 {"detail"}` when the default backend's model server is down.
  `backends_available` is `["default", "anthropic"]`, plus `"bedrock"` when
  `DECISION_BEDROCK_ENABLED=1`. It never needs a token.
- **`POST /decide`** takes `room` (`name`, `instructions`), `message` (`sender`,
  `text`, `thread_id`), `agents` (`name`, `description`, `role`), `thread`,
  `recent` and an optional `confidence_threshold`. It returns
  `{"agent", "model_choice", "confidence", "threshold", "reason", "model", "backend", "latency_ms"}`.
  `agent` is null for "none", for a pick below the threshold, and for an answer
  that names an agent who is not a candidate (logged as an error).
- **Status codes:** `422` for a bad body, `502` when the backend failed (the
  detail says why), `401` when a service token is set and the request lacks
  it, and `400 {"detail", "code": "backend_unavailable"}` for an unknown or
  unavailable backend override.
- **Auth:** with `DECISION_SERVICE_TOKEN` set, every request except
  `GET /health` needs `Authorization: Bearer <token>`. Unset means no auth,
  for use inside a cluster behind a NetworkPolicy.
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
  choice, confidence, threshold, pick and latency. No message text, room name,
  room instructions or keys.

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
| `DECISION_TIMEOUT_S` | `30` | per backend call |
| `DECISION_HISTORY_LIMIT` | `8` | recent and thread messages kept, each (8 recent + 8 thread). Measured on an L4: a room at switch-core's full limits took 0.55 s with 30 and 0.23 s with 8, with the same accuracy |
| `DECISION_WITH_REASON` | `1` | `0` drops the reason from Haiku's tool call |
| `DECISION_SERVICE_TOKEN` | unset | bearer token for everything but `/health` |
| `DECISION_BEDROCK_ENABLED` | unset | `1` lets a request choose `bedrock` |
| `DECISION_BEDROCK_MODEL` | `us.anthropic.claude-haiku-5-5-v1:0` | Bedrock model or inference profile |
| `AWS_REGION`, `AWS_PROFILE` | `us-east-1`, unset | standard AWS credential chain |
| `ANTHROPIC_API_KEY` | unset | service-wide key when `DECISION_BACKEND=anthropic` |
| `PORT` | `8230` | the image's listen port |

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

## Run with Docker

The `switch-decision` image is CPU-only and holds no model weights. The model
runs in its own container, with the weights in a volume.

Strands Decider (Linux, an NVIDIA GPU with 24 GB, the NVIDIA Container
Toolkit). `switch-decision-strands` serves on :8400; the first start
downloads the checkpoint and its base model (about 17 GB) into `/models`.
`HF_TOKEN` is optional; arguments after the image name are appended to
`strands-decider serve`:

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
with the command at its top). `STRANDS_CHECKPOINT` and `STRANDS_MODEL_NAME`
choose another checkpoint.

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

## Evaluate

`eval/` holds two scenario sets: `scenarios.json` (15 easy cases, three agents)
and `scenarios_hard.json` (40 cases, five agents with overlapping jobs;
regenerate it with `eval/make_hard_scenarios.py`).

```
uv run python eval/eval.py --url http://localhost:8230
uv run python eval/eval.py --url http://localhost:8230 --file eval/scenarios_hard.json
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

"""Serve a Strands Decider checkpoint over its SystemOne API, with the LoRA
adapter merged into the base weights.

    python serve.py

Reads STRANDS_CHECKPOINT, STRANDS_REVISION, STRANDS_BASE_REVISION,
STRANDS_MODEL_NAME, STRANDS_PORT (default 8400), STRANDS_HOST (default
0.0.0.0), STRANDS_DEVICE (default cuda), STRANDS_MAX_BATCH (default 32,
requests evaluated together) and STRANDS_API_KEY (optional: when set, every
request but GET /health needs it as a bearer token; see bearer.py).

STRANDS_REVISION is the Hugging Face commit of the checkpoint to download, and
STRANDS_BASE_REVISION the commit of its base model, so a new push to either
repo changes nothing that runs. The loader takes the base model's revision
from the checkpoint itself (its config, else its provenance.json), so the
server checks that the checkpoint names STRANDS_BASE_REVISION and refuses to
start otherwise, then downloads the base at that commit before loading.

`strands-decider serve` keeps the adapter separate and applies it on every
forward pass. Merging it once at load gives the same answers (15/15, 36/40 and
56/60 on the evaluation sets, measured on an L4) in about 0.26 s instead of
0.42 s for a typical room, and about 3.9 decisions a second instead of 2.4.
The API is the same: POST /v1/systemone and GET /health.
"""

import os
import sys
import time

import torch
import uvicorn
from bearer import require_bearer
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from huggingface_hub import snapshot_download
from strands_decider.infer import EngineConfig, SystemOneEngine
from strands_decider.modeling import (
    StrandsDeciderConfig,
    StrandsDeciderModel,
    base_revision,
    checkpoint_dir,
    config_path,
)
from strands_decider.schema import SystemOneRequest

CHECKPOINT = os.environ["STRANDS_CHECKPOINT"]
REVISION = os.environ["STRANDS_REVISION"]
BASE_REVISION = os.environ["STRANDS_BASE_REVISION"]
MODEL_NAME = os.environ["STRANDS_MODEL_NAME"]
PORT = int(os.environ.get("STRANDS_PORT", "8400"))
HOST = os.environ.get("STRANDS_HOST", "0.0.0.0")
DEVICE = os.environ.get("STRANDS_DEVICE", "cuda")
MAX_BATCH = int(os.environ.get("STRANDS_MAX_BATCH", "32"))
API_KEY = os.environ.get("STRANDS_API_KEY") or None


def pinned_checkpoint() -> str:
    """The checkpoint at REVISION, downloaded, with its base model downloaded at
    BASE_REVISION: the local directory to load."""
    path = checkpoint_dir(CHECKPOINT, revision=REVISION)
    config = StrandsDeciderConfig.from_json(config_path(path))
    recorded = base_revision(path, config)
    if recorded != BASE_REVISION:
        raise RuntimeError(
            f"{CHECKPOINT}@{REVISION} loads {config.base_model} at revision "
            f"{recorded or 'main (none recorded)'}, but STRANDS_BASE_REVISION is "
            f"{BASE_REVISION}. Set STRANDS_BASE_REVISION to the revision the "
            "checkpoint records in its provenance.json, or pin a checkpoint "
            "revision that records the base you want."
        )
    snapshot_download(config.base_model, revision=BASE_REVISION)
    return path


def load_engine() -> SystemOneEngine:
    started = time.monotonic()
    model = StrandsDeciderModel.load(pinned_checkpoint())
    if not hasattr(model.torso, "merge_and_unload"):
        raise RuntimeError(
            f"{CHECKPOINT} has no LoRA adapter to merge; this server expects a "
            "Strands Decider checkpoint built on an adapter."
        )
    model.torso = model.torso.merge_and_unload()
    model.torso.to(DEVICE, dtype=torch.bfloat16)
    print(
        f"loaded {CHECKPOINT}@{REVISION} (base at {BASE_REVISION}) as "
        f"{MODEL_NAME} on {DEVICE} with the adapter merged, "
        f"in {time.monotonic() - started:.0f}s",
        flush=True,
    )
    return SystemOneEngine(
        model,
        EngineConfig(
            device=DEVICE,
            use_prefix_cache=True,
            model_name=MODEL_NAME,
            strict_window=False,
            max_batch=MAX_BATCH,
            max_batch_tokens=None,
        ),
    )


engine = load_engine()
app = FastAPI(title="Strands Decider (adapter merged)")
require_bearer(app, API_KEY)


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "model": MODEL_NAME,
        "checkpoint": CHECKPOINT,
        "revision": REVISION,
        "base_revision": BASE_REVISION,
        "adapter": "merged",
    }


@app.post("/v1/systemone")
def systemone(request: SystemOneRequest) -> JSONResponse:
    try:
        response = engine.evaluate(request)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return JSONResponse(content=response.model_dump())


if __name__ == "__main__":
    if len(sys.argv) > 1:
        raise SystemExit(
            "serve.py takes no arguments; configure it with STRANDS_* environment "
            f"variables (got {sys.argv[1:]})."
        )
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")

# syntax=docker/dockerfile:1
# switch-decision-strands: the model server for Strands Decider, the decision
# service's default model in production. It serves POST /v1/systemone and
# GET /health on :8400; the decision service reaches it with
# DECISION_BACKEND=systemone and SYSTEMONE_URL=http://<host>:8400/v1/systemone.
#
# Needs an NVIDIA GPU (24 GB for the E4B checkpoint, an L4 say), x86_64 and a
# driver new enough for CUDA 13.0 (580 or later): PyTorch brings its own CUDA
# libraries as wheels, so the base image is CUDA's smallest, there only for the
# NVIDIA container runtime's settings and its driver-version check.
#
# No weights in the image. The checkpoint and its base model download from
# Hugging Face on the first start into HF_HOME=/models, which is meant to be a
# volume, so later starts only load them. The E4B checkpoint is built on
# google/gemma-4-E4B-it (about 16 GB in bf16), whose Gemma terms apply; the
# weights are fetched by whoever deploys, never redistributed in this image.
# Set HF_TOKEN for a gated checkpoint or higher Hub rate limits.
#
# Loading the E4B weights takes a few minutes with 32 GB of RAM, and about
# 10 minutes with 16 GB; the port opens only once the model is loaded.
#
# Arguments given to the container are appended to the serve command (for
# example `--max-batch 8`).
FROM nvidia/cuda:13.0.3-base-ubuntu24.04

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3.12 \
    && rm -rf /var/lib/apt/lists/*

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

# strands-decider==0.2.0 and every dependency, pinned by hash
# (requirements.in; regenerate requirements.txt with the command at its top).
COPY requirements.txt /tmp/requirements.txt
RUN --mount=from=ghcr.io/astral-sh/uv:0.13.1,source=/uv,target=/usr/local/bin/uv \
    --mount=type=cache,target=/root/.cache/uv \
    uv venv --python /usr/bin/python3.12 /opt/strands \
    && uv pip install --python /opt/strands/bin/python --no-deps --require-hashes \
        -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt \
    && groupadd --gid 10001 decision \
    && useradd --uid 10001 --gid 10001 --create-home decision \
    && mkdir /models \
    && chown 10001:10001 /models

ENV PATH="/opt/strands/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/models \
    HF_HUB_DISABLE_TELEMETRY=1 \
    STRANDS_CHECKPOINT=StrandsAgents/strands-decider-E4B-gemma4-v1-2610 \
    STRANDS_MODEL_NAME=strands-decider-E4B
USER 10001:10001
WORKDIR /home/decision
EXPOSE 8400
HEALTHCHECK --interval=10s --timeout=5s --start-period=30m --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8400/health', timeout=3)"]
COPY --chown=10001:10001 serve.py /opt/strands-serve/serve.py
ENTRYPOINT ["python", "/opt/strands-serve/serve.py"]

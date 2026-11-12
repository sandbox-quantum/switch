# switch-decision: the decision service (POST /decide, GET /health).
# CPU-only. The self-hosted model runs in its own container (for example the
# llama.cpp server image on a GPU node); point LLAMACPP_URL at it. No model
# weights are baked into this image.
FROM python:3.12.11-slim-bookworm

COPY --from=ghcr.io/astral-sh/uv:0.13.1 /uv /usr/local/bin/uv
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY switch_decision ./switch_decision
RUN uv sync --frozen --no-dev --no-editable \
    && groupadd --gid 10001 decision \
    && useradd --uid 10001 --gid 10001 --no-create-home decision

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8230 \
    DECISION_BACKEND=llamacpp
USER 10001:10001
EXPOSE 8230
CMD ["sh", "-c", "exec uvicorn switch_decision.app:app --host 0.0.0.0 --port ${PORT}"]

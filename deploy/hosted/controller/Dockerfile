FROM python:3.12.11-slim-bookworm

COPY --from=ghcr.io/astral-sh/uv:0.12.8 /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY src ./src
RUN uv sync --frozen --no-dev --no-editable \
    && groupadd --gid 10001 controller \
    && useradd --uid 10001 --gid 10001 --no-create-home controller \
    && mkdir -p /var/lib/switch-hosted \
    && chown -R 10001:10001 /var/lib/switch-hosted

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
USER 10001:10001
ENTRYPOINT ["switch-hosted-controller"]

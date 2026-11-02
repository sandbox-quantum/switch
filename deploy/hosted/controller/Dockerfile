FROM python:3.12.11-slim-bookworm@sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7

COPY --from=ghcr.io/astral-sh/uv:0.12.8@sha256:d1cbaeadc234fe19c0d93daabcf5e98738cd93c6d1dd4918ef6aa30735feb23a /uv /usr/local/bin/uv
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

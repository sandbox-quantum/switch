# Switch development commands.
# Install just: brew install just
# Usage: just <recipe>   (run `just` with no args to list all recipes)

set dotenv-load := true

# ── List available recipes ─────────────────────────────────────────────────────
default:
    @just --list

# ── Environment setup ──────────────────────────────────────────────────────────
# Generate a .env from .env.example with freshly generated secrets. The example
# ships every secret field BLANK on purpose so no known default credential (the
# old admin/admin) can reach a running stack; this recipe fills them with random
# values. Refuses to clobber an existing .env so it never rotates live secrets.
init-env:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -e .env ]; then
      echo "✋ .env already exists — refusing to overwrite it." >&2
      echo "   Delete it first if you really want to regenerate every secret." >&2
      exit 1
    fi
    if ! command -v openssl >/dev/null 2>&1; then
      echo "openssl is required to generate secrets but was not found on PATH." >&2
      exit 1
    fi
    cp .env.example .env
    for key in DB_PASSWORD DB_OWNER_PASSWORD \
               AGENT_REGISTRATION_TOKEN GATEWAY_ADMIN_PASSWORD \
               MATTERMOST_ADMIN_PASSWORD MATTERMOST_USER_PASSWORD; do
      secret="$(openssl rand -hex 24)"
      sed -i.bak "s|^${key}=.*|${key}=${secret}|" .env
    done
    sed -i.bak "s|^SECRET_KEYS=.*|SECRET_KEYS=local:$(openssl rand -hex 32)|" .env
    rm -f .env.bak
    echo "✅ Wrote .env with freshly generated secrets."
    echo "   Gateway admin login: $(grep '^GATEWAY_ADMIN_EMAIL=' .env | cut -d= -f2-) / $(grep '^GATEWAY_ADMIN_PASSWORD=' .env | cut -d= -f2-)"
    echo "   The stack binds to 127.0.0.1 only (set SWITCH_BIND_ADDR to expose it)."

# ── Dev infrastructure ─────────────────────────────────────────────────────────
# Refuses an `.env` written before the two-role split, rather than starting a
# stack that cannot work. Without DB_OWNER_USER the postgres container comes up
# with an empty POSTGRES_USER, and the failure surfaces several steps later as
# something that looks unrelated. `just init-env` fills both for a new `.env`
# and deliberately never touches an existing one, so an `.env` from before this
# change is the ordinary case rather than an exotic one — worth one check here
# instead of a puzzle for whoever hits it.
up:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -z "${DB_OWNER_USER:-}" ] || [ -z "${DB_OWNER_PASSWORD:-}" ]; then
      echo "✋ No DB_OWNER_USER / DB_OWNER_PASSWORD in .env." >&2
      echo "   Switch runs as a restricted database role now, and the schema" >&2
      echo "   owner is configured separately. Add both (see .env.example)," >&2
      echo "   set DB_USER=switch_app, and run 'just reset' so the Postgres" >&2
      echo "   volume is rebuilt with the runtime role created — 'init-db'" >&2
      echo "   only creates it on a fresh volume." >&2
      echo "   docs/old/LOCAL_DEVELOPMENT.md, 'Two database roles, not one'." >&2
      exit 1
    fi
    docker compose -f deploy/local/docker-compose.yml --project-directory . up -d --build

down:
    docker compose -f deploy/local/docker-compose.yml --project-directory . down

reset:
    docker compose -f deploy/local/docker-compose.yml --project-directory . down -v

# ── Run switch-core locally ────────────────────────────────────────────────────
# The Python project lives in core/; `--project core` selects that environment
# while keeping the repo root as the working directory. Tool configs are passed explicitly since the repo root no longer
# holds pyproject.toml / alembic.ini.
run:
    GATEWAY_COOKIE_SECURE="${GATEWAY_COOKIE_SECURE:-false}" uv run --project core python -m switch_core.main

# ── Run switch-core as a stand-in for Switch Cloud ────────────────────────────
# For testing Switch Console against this checkout instead of whatever a shared
# deployment runs. Needs `just up` first. Invitation e-mails go to the Mailpit
# catcher, and their links point at :8000 so that pasting one into the Console
# matches the stand-in. docs/old/LOCAL_DEVELOPMENT.md, "A local Switch Cloud".
# Run switch-core as Switch Cloud, with invitation e-mail caught at :8025
local-cloud:
    docker compose -f deploy/local/docker-compose.yml --project-directory . --profile mail up -d mailpit
    GATEWAY_SMTP_HOST=127.0.0.1 GATEWAY_SMTP_PORT=1025 GATEWAY_SMTP_TLS=none \
    GATEWAY_SMTP_USERNAME= GATEWAY_SMTP_PASSWORD= \
    GATEWAY_SMTP_FROM="Switch <invites@switch.local>" \
    FRONTEND_BASE_URL=http://localhost:8000 GATEWAY_COOKIE_SECURE=false \
    uv run --project core python -m switch_core.main

# Run Switch Console with "Switch Cloud" pointing at `just local-cloud`, in
# its own data directory so other dev builds' databases are left alone
local-cloud-console:
    cd console && SWITCH_CLOUD_ENABLED=true SWITCH_CLOUD_URL=http://localhost:8000 SWITCH_CONSOLE_USER_DATA_DIR=switchdash-local-cloud pnpm dev

# Made by the gateway admin from .env, so it joins the admin's workspace, as
# every admin-made account does. Use the admin's domain (switch.local by
# default) for an account that should be able to join by domain.
#   just local-cloud-user ada@switch.local "Ada Lovelace" <password>
# Create an account on `just local-cloud` to sign in with
local-cloud-user email name password:
    #!/usr/bin/env bash
    set -euo pipefail
    jar="$(mktemp)"
    trap 'rm -f "$jar"' EXIT
    curl -fsS -c "$jar" -H 'Content-Type: application/json' \
      -d "$(jq -n --arg e "$GATEWAY_ADMIN_EMAIL" --arg p "$GATEWAY_ADMIN_PASSWORD" '{email: $e, password: $p}')" \
      http://localhost:8000/gateway/auth/login >/dev/null
    curl -fsS -b "$jar" -H 'Content-Type: application/json' \
      -d "$(jq -n --arg e '{{ email }}' --arg n '{{ name }}' --arg p '{{ password }}' '{email: $e, name: $n, password: $p}')" \
      http://localhost:8000/gateway/users | jq .

# ── Format code with ruff ──────────────────────────────────────────────────────
# Run from the repo root so ruff's hierarchical config discovery applies the
# right config per file (core/, the sub-projects that carry their own, and
# the root ruff.toml fallback).
format:
    uv run --project core ruff format .
    uv run --project core ruff check --fix .

# ── Check code with ruff (no changes) ─────────────────────────────────────────
check:
    uv run --project core ruff format --check .
    uv run --project core ruff check .

# ── Run mypy type checks ──────────────────────────────────────────────────────
typecheck:
    uv run --project core mypy --config-file core/pyproject.toml core/switch_core/

# ── Regenerate everything declared in artifacts.yaml ──────────────────────────
# artifacts.yaml is the only authored copy of what each artifact is and what it
# speaks. Each artifact needs it compiled in, so the per-language modules are
# generated rather than kept in step by hand.
artifacts:
    uv run --project core python scripts/gen_artifacts.py

# ── Verify the registry, the generated modules and the declared versions ──────
# Fails when artifacts.yaml changed without regenerating, when a generated
# module was hand-edited, or when a file a packaging ecosystem owns (pyproject,
# package.json) disagrees with the registry.
artifacts-check:
    uv run --project core python scripts/gen_artifacts.py --check

# ── Build the Teams app package an operator uploads ───────────────────────────
# Every route into a tenant wants a .zip — Developer Portal Import app, Upload a
# custom app, the admin centre — and none takes a bare manifest.json. Pass the
# Azure Bot app id and it fills the three places it has to match.
#   just teams-app-package --app-id <guid> --public-host teams.example.com
teams-app-package *args:
    uv run --project core python scripts/build_teams_app_package.py {{ args }}

# ── Run alembic migrations ─────────────────────────────────────────────────────
migrate:
    uv run --project core alembic -c core/alembic.ini upgrade head


# ── Generate a new alembic migration ──────────────────────────────────────────
migration msg:
    uv run --project core alembic -c core/alembic.ini revision --autogenerate -m "{{ msg }}"

# ── Run tests ──────────────────────────────────────────────────────────────────
test *args:
    uv run --project core pytest -c core/pyproject.toml core/tests/ {{ args }}

# ── Run integration tests (real Postgres via testcontainers) ───────────────────
# DOCKER_HOST is auto-resolved from the active docker context in conftest, so this
# works under Docker Desktop / OrbStack / colima without extra setup.
test-integration *args:
    uv run --project core pytest -c core/pyproject.toml core/tests/integration -m integration {{ args }}

# ── Run the connection-model benchmark (real Postgres, real socket) ────────────
# Reports connection/process/CPU/RSS/latency figures for the revision it is run
# on. It measures rather than asserts, so it is excluded from `just test`.
bench *args:
    uv run --project core pytest -c core/pyproject.toml core/tests/benchmarks -m benchmark -s {{ args }}

# ── Gateway UI ─────────────────────────────────────────────────────────────────
gateway-install:
    cd gateway && npm install

gateway-dev:
    cd gateway && npm run dev

gateway-build:
    cd gateway && npm run build

gateway-test:
    cd gateway && npm test

# ── Standalone deployment (all-in-one Docker, no host toolchain) ──────────────
# Repo users build from source: the build override re-adds the `build:` blocks
# so images come from the working tree, not GHCR. All profiles are enabled to
# bring up the full all-in-one stack (Mattermost bridge + gateway).
standalone-up:
    docker compose -f deploy/local/standalone-docker-compose.yml -f deploy/local/standalone-docker-compose.build.yml --profile collab --profile gateway --project-directory . up -d --build

standalone-down:
    docker compose -f deploy/local/standalone-docker-compose.yml --profile collab --profile gateway --project-directory . down

standalone-reset:
    #!/usr/bin/env bash
    set -euo pipefail
    read -r -p "⚠️  This deletes ALL standalone data volumes (rooms, messages, agents, users). Continue? [y/N] " ans
    [[ "$ans" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }
    docker compose -f deploy/local/standalone-docker-compose.yml --profile collab --profile gateway --project-directory . down -v

# ── Documentation ──────────────────────────────────────────────────────────────
# Clones the docs repository unless --source names a checkout of it:
#     just sync-docs --source ../docs
# Everything under docs/official is rewritten, so edit the source pages instead.
# Convert the published Switch pages into docs/official as Markdown
sync-docs *args:
    python3 scripts/sync_docs.py {{ args }}

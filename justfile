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
    for key in DB_PASSWORD MATRIX_ADMIN_PASSWORD MATRIX_REGISTRATION_SHARED_SECRET \
               AGENT_REGISTRATION_TOKEN JWT_SECRET_KEY GATEWAY_ADMIN_PASSWORD \
               MATTERMOST_ADMIN_PASSWORD MATTERMOST_USER_PASSWORD; do
      secret="$(openssl rand -hex 24)"
      sed -i.bak "s|^${key}=.*|${key}=${secret}|" .env
    done
    rm -f .env.bak
    echo "✅ Wrote .env with freshly generated secrets."
    echo "   Gateway admin login: $(grep '^GATEWAY_ADMIN_EMAIL=' .env | cut -d= -f2-) / $(grep '^GATEWAY_ADMIN_PASSWORD=' .env | cut -d= -f2-)"
    echo "   The stack binds to 127.0.0.1 only (set SWITCH_BIND_ADDR to expose it)."

# ── Dev infrastructure ─────────────────────────────────────────────────────────
# Tuwunel self-initializes its signing key + database in its data volume on
# first boot, so no pre-start key generation is needed.
up:
    docker compose -f deploy/local/docker-compose.yml --project-directory . up -d --build

down:
    docker compose -f deploy/local/docker-compose.yml --project-directory . down

reset:
    docker compose -f deploy/local/docker-compose.yml --project-directory . down -v

# ── Run switch-core locally ────────────────────────────────────────────────────
# The Python project lives in core/; `--project core` selects that environment
# while keeping the repo root as the working directory (so paths like connectors/
# stay natural). Tool configs are passed explicitly since the repo root no longer
# holds pyproject.toml / alembic.ini.
run:
    uv run --project core python -m switch_core.main

# ── Format code with ruff ──────────────────────────────────────────────────────
# Run from the repo root so ruff's hierarchical config discovery applies the
# right config per file (core/, the connector sub-projects, and the
# root ruff.toml fallback).
format:
    uv run --project core ruff format .
    uv run --project core ruff check --fix .

# ── Check code with ruff (no changes) ─────────────────────────────────────────
check:
    uv run --project core ruff format --check .
    uv run --project core ruff check .

# ── Run mypy type checks ──────────────────────────────────────────────────────
typecheck:
    uv run --project core mypy --config-file core/pyproject.toml core/switch_core/ connectors/

# ── Regenerate everything declared in artifacts.yaml ──────────────────────────
# artifacts.yaml is the only authored copy of what each artifact is and what it
# speaks. Each artifact needs it compiled in, so the per-language modules are
# generated rather than kept in step by hand.
artifacts:
    uv run --project core python scripts/gen_artifacts.py

# ── Verify the registry, the generated modules and the declared versions ──────
# Fails when artifacts.yaml changed without regenerating, when a generated
# module was hand-edited, or when a file a packaging ecosystem owns (pyproject,
# package.json, plugin.json) disagrees with the registry.
artifacts-check:
    uv run --project core python scripts/gen_artifacts.py --check

# ── Run alembic migrations ─────────────────────────────────────────────────────
migrate:
    uv run --project core alembic -c core/alembic.ini upgrade head


# ── Generate a new alembic migration ──────────────────────────────────────────
migration msg:
    uv run --project core alembic -c core/alembic.ini revision --autogenerate -m "{{ msg }}"

# ── Run tests ──────────────────────────────────────────────────────────────────
test *args:
    uv run --project core pytest -c core/pyproject.toml core/tests/ {{ args }}

# ── Run integration tests (real Postgres + Tuwunel via testcontainers) ──────────
# DOCKER_HOST is auto-resolved from the active docker context in conftest, so this
# works under Docker Desktop / OrbStack / colima without extra setup.
test-integration *args:
    uv run --project core pytest -c core/pyproject.toml core/tests/integration -m integration {{ args }}

# ── Gateway UI ─────────────────────────────────────────────────────────────────
gateway-install:
    cd gateway && npm install

gateway-dev:
    cd gateway && npm run dev

gateway-build:
    cd gateway && npm run build

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

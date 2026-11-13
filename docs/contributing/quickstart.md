# New contributor quickstart

This guide takes you from a clean machine to running the complete Switch local
stack, connecting Switch Console, and getting an agent to answer you in a room,
in about 15 minutes.

For the detailed breakdown of ports, database roles, and mock cloud environments,
see [`docs/old/LOCAL_DEVELOPMENT.md`](../old/LOCAL_DEVELOPMENT.md).

---

## 1. Prerequisites

You will need:

- **Docker:** Docker Desktop or Docker Engine with Compose v2.
- **Python tooling:** [`uv`](https://docs.astral.sh/uv/) (0.5+).
- **Task runner:** [`just`](https://github.com/casey/just) (`brew install just` on macOS, `winget install Casey.Just` on Windows, or cargo/package manager on Linux).
- **Node & pnpm:**
  - **Switch Console (`console/`):** Node >= 24 (see `console/.nvmrc` for pinned `24.14.0`) and pnpm `10.28.2`.
  - **Gateway dashboard (`gateway/`):** Node >= 20 and pnpm >= 9.

### Platform notes

- **macOS / Linux:** Ensure Docker daemon is running and `just` is on `$PATH`.
- **Windows:**
  - `justfile` recipes use bash scripts (`#!/usr/bin/env bash`). Ensure Git Bash (`C:\Program Files\Git\bin`) and OpenSSL are available on your `PATH`.
  - Switch requires LF line endings for skill frontmatter and connection metadata. Configure Git to preserve LF before cloning:
    ```bash
    git config --global core.autocrlf false
    ```
    If you have already cloned with CRLF conversions enabled, disable `autocrlf` and re-checkout on a clean tree without dirtying git index:
    ```bash
    git config core.autocrlf false
    git rm --cached -r .
    git reset --hard HEAD
    ```

---

## 2. Start the local stack

Run these from the repository root:

```bash
# 1. Generate .env with fresh random secrets (will not overwrite an existing .env)
just init-env

# 2. Install Python dependencies for switch-core
uv sync --project core

# 3. Start supporting services (PostgreSQL and Mattermost) in Docker
just up

# 4. Apply database migrations
just migrate

# 5. Start switch-core (:8000)
just run
```

`just up` starts the backing services in Docker Compose. You run `switch-core`
on your host against local PostgreSQL and Mattermost. When you make backend Python changes,
stop the server with `Ctrl+C` and restart `just run`.

In a second terminal, start the Gateway operator dashboard (with Vite HMR enabled):

```bash
just gateway-install   # first run only
just gateway-dev       # runs Vite dev server on :5173
```

---

## 3. Connect Switch Console & talk to an agent

Switch Console connects to `switch-core` at **`http://localhost:8000`**.

### Using the desktop app

1. Download the Switch Console installer for your OS from the
   [latest release](https://github.com/sandbox-quantum/switch/releases).
2. On first launch, select **Connect to an existing server** (or **Add Server** in Settings).
3. Set the server URL to `http://localhost:8000` and sign in using the gateway admin credentials printed during `just init-env` (also found in `.env`).

### Running Console from source (optional)

If your contribution touches Switch Console:

```bash
cd console
pnpm install
pnpm dev
```

### Register your first agent and create a room

The room member picker only lists agents already registered with the server. To test your first agent:

1. **Verify your local agent CLI:** Ensure an agent CLI is installed on your machine and logged in (for example, `claude` with `claude login`, or `codex`).
2. **Register the agent:** In Switch Console, navigate to **Agents** (or **Settings > Agent Providers**), click **New Agent**, and configure:
   - **Name**: e.g. `local-dev`
   - **Provider**: Select your CLI provider (such as `claude-code`, `codex`, or `opencode`).
   - **Working directory**: Set to a project directory or your current workspace.
3. **Create the room:** Click **New Room**, name it `test-room`, and add `@local-dev` to the room members.
4. **Send a test message:** In the newly created room, mention the agent:
   > `@local-dev hello! Are you connected?`
5. The agent receives the message event over the Server-Sent Events stream from `switch-core` and replies in the room.

---

## 4. Where code lives

| Directory | What belongs here |
|---|---|
| `core/switch_core/` | Python backend: room protocol, event streams, bridges, and connections. |
| `core/switch_core/connections/catalog/` | Service connector catalog (GitHub, Datadog, Linear, etc.). |
| `core/tests/` | Pytest suite mirroring `switch_core/`. Store tests run against real PostgreSQL. |
| `console/` | Switch Console desktop application (Electron, React, TypeScript). |
| `gateway/` | Gateway dashboard frontend (Vite, React). |
| `docs/` | Synced published docs (`official/`) and architecture references (`old/`). |
| `justfile` | Canonical development recipes. |

---

## 5. Pre-PR quality gates

Before pushing changes and opening a pull request, verify that all three local checks pass:

```bash
# Lint and format check (Ruff)
just check

# Static type check (Mypy)
just typecheck

# Backend test suite
just test

# For a single test file or pattern:
just test -k test_loader
```

If you made changes in `console/`:

```bash
cd console
pnpm test
pnpm lint
```

---

## 6. Opening your pull request

1. If you have not already configured the upstream remote, add it and fetch latest `main`:
   ```bash
   git remote add upstream https://github.com/sandbox-quantum/switch.git
   git fetch upstream
   ```
2. Create a focused branch off `upstream/main`:
   ```bash
   git checkout -b feat/my-feature upstream/main
   ```
3. Commit with [Conventional Commits](https://www.conventionalcommits.org/):
   `feat(...)`, `fix(...)`, or `docs(...)`.
4. Open the pull request and link your issue with `Closes #<number>`.
5. **Sign the CLA:** The automated CLA bot will comment on your PR. Reply with the exact sentence:
   > I have read the CLA Document and I hereby sign the CLA

---

## Switch changes fast

Switch is under active development. If you pull upstream changes and encounter
unexpected startup errors, re-sync dependencies and apply any new migrations:

```bash
git fetch upstream
git merge upstream/main
uv sync --project core
just migrate
```

To completely reset local database volumes and start from scratch, run `just reset`.
If something in current setup does not match this guide, please ask in your
issue or on [Discord](https://discord.com/invite/E6a2Jnb6G).

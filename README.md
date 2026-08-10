<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/agent-switch-wordmark-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/agent-switch-wordmark.svg">
  <img src="assets/agent-switch-wordmark.svg" alt="Agent Switch" width="350">
</picture>

**Create organizations where AI agents and humans work side by side.**

[![License: Apache 2.0 + Commons Clause](https://img.shields.io/badge/license-Apache%202.0%20%2B%20Commons%20Clause-blue)](LICENSE)
[![Documentation](https://img.shields.io/badge/docs-coming%20soon-FF895E)](#)
[![Website](https://img.shields.io/badge/website-coming%20soon-FF895E)](#)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](CLAUDE.md)

</div>

Agent Switch is the workplace for AI agents: they join rooms with
your team, chat where you chat, take on tasks, and work under rules you set.

- 🤝 **Multi-agent, multi-human** — shared rooms where whole teams of people and agents work together, not 1:1 chatbot sessions.
- 🌍 **Any agent, anywhere** — on a laptop or a server, from any provider or company: Claude Code on your machine, LangChain, OpenCode, OpenAI Codex — anything that speaks MCP or HTTP.
- 💬 **In your team's chat** — agents join your team in Slack and Microsoft Teams.
- 🧩 **Workflows on top** — roles, tasks, delegation, and shared context turn a room of agents into an operation.
- 🛡️ **Governed & observable** — every interaction is protected and visible by design.

<!-- Screenshot of the gateway dashboard goes here once available. -->

## Architecture at a glance

```mermaid
flowchart LR
    subgraph Agents["AI agents (any framework)"]
        A1[Claude Code]
        A2[Your agent]
    end
    subgraph Humans["Humans"]
        H1[Slack]
        H2[Mattermost]
    end

    A1 -->|Agent Bridge| CORE
    A2 -->|Agent Bridge| CORE
    H1 -->|Collaboration Bridge| CORE
    H2 -->|Collaboration Bridge| CORE

    subgraph Switch["Switch Core"]
        CORE[Rooms · Protection · Observability]
        BUS[(Matrix / Tuwunel<br/>message bus)]
        CORE --- BUS
    end

    GW[Operator dashboard] --> CORE
```

Every room participant — agent, human proxy, or internal service — is a Matrix
client connecting to Tuwunel. Switch Core owns room lifecycle, the protection
pipeline, and observability; the bridges translate between rooms and the
outside world.

## Try it locally (standalone)

Want to play with Switch without setting up a development environment? The
**standalone** Docker Compose stack runs the whole platform in containers —
Tuwunel, PostgreSQL, Mattermost, switch-core, and the gateway. No
Python/`uv` needed, and no third-party AI keys required — you bring your own
agent.

**Prerequisites:** [Docker](https://docs.docker.com/get-docker/) and
[just](https://github.com/casey/just) (`brew install just`).

```bash
just init-env            # generate .env with strong random secrets
just standalone-up       # build & start the full stack
```

`just init-env` writes a `.env` with a freshly generated password for every
account and secret (there is no shipped default login) and prints the gateway
admin credentials. The stack binds to `127.0.0.1` only — set `SWITCH_BIND_ADDR`
in `.env` to expose it on the network, and only behind a reverse proxy or
firewall.

Once it's up, open:

| Service | URL | Login |
|---|---|---|
| Gateway (operator dashboard) | <http://localhost:3000> | `admin@switch.local` / generated password (`GATEWAY_ADMIN_PASSWORD` in `.env`, also printed by `just init-env`) |
| Mattermost (chat with agents) | <http://localhost:8065> | `user` / generated password (`MATTERMOST_USER_PASSWORD` in `.env`) |

**First run — connect your own agent.** Switch ships no bundled agents; the
point is to plug in yours. The quickest path is a bundled connector — the
**Claude Code connector** in
[`connectors/claude-code-plugin/`](connectors/claude-code-plugin/), or the
**Codex connector** in [`connectors/codex-plugin/`](connectors/codex-plugin/):

1. In the gateway, create a room (and note its id).
2. Install and configure the connector so your agent registers as a Switch
   agent and joins the room. For Claude Code, the plugin's `configure` skill
   walks you through registering with this Switch instance and writing the
   credentials. The Codex plugin ships the room-workflow skill only — its
   Switch MCP server is registered by the [Switch Console desktop app](console/) when
   it launches the session, so set the agent up there; see
   [`connectors/codex-plugin/README.md`](connectors/codex-plugin/README.md).
3. Talk to the agent from Mattermost, and watch the interaction in the gateway.

Stop the stack with `just standalone-down`, or `just standalone-reset` to also
wipe the data volumes.

> ⚠️ **`just standalone-reset` is destructive.** It deletes the data volumes —
> every room, message, agent, user, and resource you created is gone for good.
> Use `just standalone-down` for an ordinary stop that keeps your data.

## Getting started (local development)

**Prerequisites:** [Docker](https://docs.docker.com/get-docker/),
[uv](https://docs.astral.sh/uv/), and [just](https://github.com/casey/just)
(`brew install just`).

```bash
just init-env            # first-time setup — generate .env with random secrets
uv sync                  # install Python dependencies
just gateway-install     # install gateway frontend deps (first time only)
just up                  # start the supporting stack (Docker Compose)
just run                 # run switch-core locally (:8000)
just gateway-dev         # run the gateway frontend (separate terminal)
```

`just up` starts the **supporting services** in Docker — Tuwunel, PostgreSQL,
and Mattermost. You run **switch-core** and the **gateway**
yourself, locally, so you get hot-reload while developing: `just run`
(switch-core on `:8000`) and `just gateway-dev` (the frontend), each in its own
terminal. Stop the stack with `just down` (or `just reset` to also wipe
volumes).

## Common commands

Run `just` with no arguments to list every recipe. The most-used ones:

| Command | What it does |
|---|---|
| `just init-env` | Generate `.env` with freshly generated secrets (no default login) |
| `just up` / `just down` | Start / stop the local dev stack |
| `just reset` | Stop the stack and wipe volumes (incl. the Tuwunel database) |
| `just standalone-up` / `just standalone-down` | Start / stop the full standalone stack (no dev tooling) |
| `just standalone-reset` | Stop the standalone stack and wipe its volumes |
| `just run` | Run switch-core locally (`python -m switch_core.main`) |
| `just migrate` | Apply migrations (`alembic upgrade head`) |
| `just migration "msg"` | Autogenerate a new Alembic migration |
| `just format` | Format + autofix with ruff |
| `just check` | Lint/format check (CI mode, no changes) |
| `just typecheck` | Type-check with mypy |
| `just test` | Run the test suite (`pytest core/tests/`); `just test -k name` for one test |
| `just gateway-dev` / `just gateway-build` | Run / build the gateway frontend |

## Architecture

The platform service lives in [`core/switch_core/`](core/switch_core/)
(import root `switch_core`, distribution name `switch-core`). It is async
throughout — all I/O (Matrix, DB, external APIs) is async — and every room
participant is a Matrix client (matrix-nio) connecting to Tuwunel. Persistence
is PostgreSQL, managed with Alembic.

Module layout under `core/switch_core/`:

| Module | Responsibility |
|---|---|
| `config.py` | Pydantic `BaseSettings` — all config from environment variables |
| `db/` | SQLAlchemy models, async engine/session, and query stores |
| `migrations/` | Alembic migrations (`env.py`, `versions/`) |
| `rooms/` | Room lifecycle, configuration, provisioning |
| `clients/` | Matrix clients (agent, user, resource manager, observe) |
| `bridges/` | External integrations — `agent/`, `collaboration/`, `observe/`, `resource/` |
| `protect/` | Protection pipeline (checks, protect bridge, API) |
| `gateway/` | Management API for the frontend |

The operator dashboard frontend lives in [`gateway/`](gateway/)
(Node/Vite, served via nginx).

## Repository layout

| Path | Contents |
|---|---|
| `core/` | Backend tree — a self-contained Python project (`pyproject.toml`, `uv.lock`, `alembic.ini`) holding the service package and tests |
| `core/switch_core/` | The main Python service package (import root `switch_core`, dist `switch-core`) |
| `core/tests/` | Test suite, mirroring the `switch_core/` module structure |
| `gateway/` | Operator dashboard frontend (Node/Vite) |
| `console/` | The Switch Console desktop app |
| `connectors/` | Agent connectors (`claude-code-plugin`, `codex-plugin`) |
| `deploy/` | Deployment assets — Docker Compose stacks (`local/`) and shared resources |
| `justfile` | Repo-root task runner (drives all three code trees) |

## Testing

Tests live in `core/tests/switch_core/` and mirror the module structure. The
suite uses pytest with pytest-asyncio; store tests run against a real
PostgreSQL instance (not mocks, not SQLite). Run them with `just test`.

## License

Agent Switch is licensed under the **Apache License 2.0 with the Commons Clause**
condition (Copyright (c) 2026 SB Technology, Inc. dba SandboxAQ) — see
[`LICENSE`](LICENSE) for the full text. The Commons Clause removes the right to
_Sell_ the software (including paid hosting or support offerings whose value
derives substantially from it); all other Apache 2.0 grants are unchanged.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to get a change merged, including
the required [Contributor License Agreement](CLA.md). [CLAUDE.md](CLAUDE.md)
covers code style, the error-handling philosophy, and the conventions to follow
when working in this repository.

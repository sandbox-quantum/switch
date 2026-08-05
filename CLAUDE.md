# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Switch is an AI agent orchestration and governance platform. It onboards, orchestrates, and secures third-party AI agents using Matrix (Tuwunel) as the internal message bus. Agents register via the Agent Bridge API and communicate through Matrix rooms with room-scoped protection, observability, and collaboration bridges to external platforms (Slack, Mattermost).

The target architecture is documented in `docs/`.

## Switchdash

`dash/` is a local-first desktop app (Electron; a fork, upstream
attribution in `dash/NOTICE`) for managing the local AI coding-agent sessions that
participate in Switch. The upstream app is built around coding workflows
(projects → sessions → conversations); switchdash is being reworked
around **Switch agents and their sessions** — which rooms an agent belongs to and
is connected to, its config (working dir, identity), and scheduling: e.g.
auto-starting a Claude Code session when a Slack user addresses an agent that has
no live session, viewing all sessions in one place, and injecting prompts into a
running TUI when the provider can't push events into a live session. It has its
own `dash/CLAUDE.md` (→ `AGENTS.md`); read that before working in the app.

## Common Commands

```bash
# Dependencies
uv sync                          # install/update Python dependencies

# Local dev infrastructure (Docker Compose)
cp .env.example .env             # first-time setup
just up                          # start Switch locally
just down                        # stop Switch

# Database migrations
just migrate                     # alembic upgrade head
just migration "description"     # alembic revision --autogenerate -m "description"

# Linting & type checking
just format                      # ruff format + ruff check --fix
just check                       # ruff format --check + ruff check (CI mode)
just typecheck                   # mypy core/switch_core/

# Tests
just test                        # pytest core/tests/
just test -k "test_name"         # run specific test
```

## Architecture

**Directory:** `core/switch_core/` — the main Python service package (import root `switch_core`, distribution name `switch-core`). The repo top level splits into three code trees: `core/` (backend package + tests), `gateway/` (operator dashboard frontend), and `dash/` (desktop app).

**Module layout:**
- `config.py` — Pydantic `BaseSettings`; all config from environment variables
- `db/` — Database layer
  - `base.py` — SQLAlchemy `DeclarativeBase`
  - `engine.py` — async engine and session factory
  - `models.py` — SQLAlchemy table definitions
  - `stores/` — query methods and domain-specific data access
- `migrations/` — Alembic migrations (`env.py`, `versions/`)
- `rooms/` — Room lifecycle, configuration, provisioning
- `clients/` — Matrix clients (agent, user, resource manager, observe)
- `bridges/` — External integrations
  - `agent/` — Agent Bridge (HTTP API, MCP server, server-side connectors)
  - `collaboration/` — Collaboration Bridge (Slack, Mattermost adapters)
  - `observe/` — Observe Bridge (event sinks)
  - `resource/` — Resource Bridge (platform resource management)
- `protect/` — Protection pipeline (checks, protect bridge, API)
- `gateway/` — Management API for the frontend

**Key patterns:**
- Async throughout: all I/O is async (Matrix, DB, external APIs)
- Dependency injection: stores and services are injected, not global singletons
- Session management: API endpoints use middleware-provided sessions; background work creates sessions explicitly
- All participants in rooms are Matrix clients (matrix-nio) connecting to Tuwunel

## Connector plugins

There are **two** connector plugins under `connectors/`, one per agent host, and
each ships its own copy of the Switch room-workflow skill at
`skills/switch/SKILL.md`:

- `connectors/claude-code-plugin/` — manifest `.claude-plugin/plugin.json`.
  Ships the skill plus an MCP config (`.mcp.json`) and hooks. It contains **no
  runtime code**: the MCP server is `@sandbox-quantum/switch-agent-runtime`,
  fetched with `npx` and built from `dash/packages/switch-agent-runtime/`.
  switchdash imports the same package for its protocol client, so there is one
  implementation of the agent protocol rather than a copy per consumer.
- `connectors/codex-plugin/` — manifest `.codex-plugin/plugin.json`. Ships the
  skill plus its own MCP config, declared as `"mcpServers": "./.mcp.json"`, so a
  Codex session gets the Switch tools from the plugin alone. Codex does not
  expand `${VAR}` in a bundled config, so the server names its variables under
  `env_vars` and Codex forwards them **by name** from its own environment — no
  expansion, and no secret in the file. An unset name is simply not forwarded,
  which is why the list can include the switchdash-only variables without
  breaking a standalone session (the Claude connector cannot do this: `${VAR}`
  expansion makes every declared variable mandatory).

  switchdash still writes a per-agent Codex profile
  (`$CODEX_HOME/<slug>.config.toml`, launched with `--profile <slug>`), but only
  for what is genuinely per-agent — model, reasoning effort, and instructions.

When you change how agents interact with Switch — new/changed MCP tools, in-room
commands, room workflow, or anything an agent-facing client needs to know:

- **Update both skills.** A room-workflow change must land in
  `connectors/claude-code-plugin/skills/switch/SKILL.md` *and*
  `connectors/codex-plugin/skills/switch/SKILL.md` so the documented workflow
  matches actual behavior on both hosts.
- **Bump the versions of whatever you changed, in the same commit.** Not at
  release time — it gets forgotten, and then a version number is a claim nobody
  can trust. `dash/AGENTS.md` has the table (both plugins, runtime package,
  sidecar) and the rules for which digit moves.
- **Diff the two skills after editing.** They are deliberately not identical
  (host-specific wording for tool namespacing, event delivery and task
  notifications, attachments, and MCP registration), so diff them to confirm
  every remaining difference is intentional rather than a fix that only landed
  on one side.
- **Publishing the runtime is a tag**, not a merge:
  `git tag switch-agent-runtime-v<version> && git push origin <tag>`. It works
  from a branch, so a version can be tested before it lands. The tag must match
  the version in `package.json` or the workflow fails.

## Code Style

- All import statements must be at the top of files, not inside functions. Use `TYPE_CHECKING` guards to break circular imports.
- Ruff for formatting and linting (`select = ["E", "F", "I", "UP"]`). Line length is not enforced (`E501` ignored).
- mypy with `ignore_missing_imports = true`.
- **Avoid optional parameters and defaults unless truly needed.** Making a parameter optional (e.g., `config: dict | None = None`) hides the caller's responsibility to provide a value. If every call site will pass the argument, make it required. Use defaults only for genuinely optional behavior, not to paper over incomplete call sites.
- **Don't add comments that narrate the change.** Don't drop in multi-line comments explaining what a fix did or why it changed (that belongs in the commit message/PR, not the code). Comments should explain non-obvious intent that stands on its own over time — not document this edit. When in doubt, leave no comment.

## Error Handling Philosophy: Fail Loud, Never Fake

Prefer a visible failure over a silent fallback.

- Never silently swallow errors to keep things "working."
  Surface the error. Don't substitute placeholder data.
- Fallbacks are acceptable only when disclosed. Show a
  banner, log a warning, annotate the output.
- Design for debuggability, not cosmetic stability.

Priority order:
1. Works correctly with real data
2. Falls back visibly — clearly signals degraded mode
3. Fails with a clear error message
4. Silently degrades to look "fine" — never do this

Concrete rules:
- **Missing required config → raise immediately.** Don't log-and-skip when a value is needed for the system to function. If the admin password or shared secret is absent, that's a startup error, not a "skip this step" situation.
- **Don't return booleans for operations that can fail.** Raise a descriptive exception. Callers should not have to check `if not result:` — they should get an error they can't ignore.
- **`logger.info` is not an error signal.** Use `logger.warning` for degraded-but-functional, `logger.error` for broken-but-continuing, and raise for broken-and-should-stop.
- **Catch-and-log is acceptable in event loops** (e.g., Matrix sync callbacks) where one bad event should not crash the client. Everywhere else, let exceptions propagate.

## Testing

Tests live in `core/tests/switch_core/` mirroring the module structure. Uses pytest with pytest-asyncio. Store tests should run against a real PostgreSQL instance — not mocks, not SQLite.

## Reference Documentation

Everything under `docs/` is listed here; if it is not in this list, it does not
exist:
- `docs/ARCHITECTURE.md` — system overview: components, domain model, key flows,
  entry points, and a code map from area to module
- `docs/api/AGENT_PROTOCOL.md` — the agent↔Switch protocol (connections, the
  event stream, room slots, failure handling). Authoritative where it and
  `ARCHITECTURE.md` overlap
- `docs/bridges/` — collaboration bridge setup: `README.md` plus one page each
  for Slack, Mattermost, Discord, and Teams

There is no separate schema, room-design, HTTP-API or MCP-surface document. Read
those from the code: `core/switch_core/db/models.py` for the schema,
`core/switch_core/room_service.py` for room provisioning and lifecycle,
`core/switch_core/bridges/agent/api/handlers.py` for the HTTP surface, and
`core/switch_core/bridges/agent/operations/definitions.py` for the agent tool
surface — one definition serves both the MCP server
(`bridges/agent/mcp/server.py`) and the HTTP front door
(`bridges/agent/api/operations.py`), so the two cannot drift.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## This repository is public

Everything you write here is world-readable, permanently, including in git
history — a later commit cannot take it back. Keep internal detail out of it:

- **No credentials or tokens**, not even expired or "test" ones, and not in
  fixtures. A secret committed here is a secret to rotate, not to delete.
- **No internal infrastructure**: hostnames, IPs, cluster or account names,
  bucket names, ARNs, internal URLs. Test fixtures use obvious placeholders.
- **No personal data**: individual email addresses, Slack ids, employee names.
  Prefer a role address to a person's.
- **Keep internal tooling in `internal/`**, which is untracked and stays that
  way. Do not reference internal-only systems from tracked files.
- **Ticket keys** (`CHOO-…`) are fine in source comments and design notes as
  traceability, but write so the comment stands on its own without the ticket —
  a reader outside the company cannot open it. Keep them out of user-facing
  docs and the changelog.

## Project Overview

Switch is an AI agent orchestration and governance platform. It onboards, orchestrates, and secures third-party AI agents using a Postgres-backed message store as the internal message bus. Agents register via the Agent Bridge API and communicate through Switch rooms, with collaboration bridges to external platforms (Slack, Mattermost, Discord, Teams, Telegram).

The target architecture is documented in `docs/`.

## Switch Console

`console/` is a local-first desktop app (Electron; a fork, upstream
attribution in `console/NOTICE`) for managing the local AI coding-agent sessions that
participate in Switch. The upstream app is built around coding workflows
(projects → sessions → conversations); Switch Console is being reworked
around **Switch agents and their sessions** — which rooms an agent belongs to and
is connected to, its config (working dir, identity), and scheduling: e.g.
auto-starting a Claude Code session when a Slack user addresses an agent that has
no live session, viewing all sessions in one place, and injecting prompts into a
running TUI when the provider can't push events into a live session. It has its
own `console/CLAUDE.md` (→ `AGENTS.md`); read that before working in the app.

## Common Commands

```bash
# Dependencies
uv sync                          # install/update Python dependencies

# Local dev infrastructure (Docker Compose)
just init-env                    # first-time setup — generate .env with random secrets
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

**Directory:** `core/switch_core/` — the main Python service package (import root `switch_core`, distribution name `switch-core`). The repo top level splits into three code trees: `core/` (backend package + tests), `gateway/` (operator dashboard frontend), and `console/` (desktop app).

**Module layout:**
- `config.py` — Pydantic `BaseSettings`; all config from environment variables
- `db/` — Database layer
  - `base.py` — SQLAlchemy `DeclarativeBase`
  - `engine.py` — async engine and session factory
  - `models.py` — SQLAlchemy table definitions
  - `stores/` — query methods and domain-specific data access
- `migrations/` — Alembic migrations (`env.py`, `versions/`)
- `room_service.py` / `rooms_yaml.py` — Room lifecycle, configuration, provisioning
- `clients/` — room clients (agent, admin, bridge)
- `bridges/` — External integrations
  - `agent/` — Agent Bridge (HTTP API, MCP server, server-side connectors)
  - `collaboration/` — Collaboration Bridge (Slack, Mattermost, Discord, Teams, Telegram adapters)
  - `resource/` — Resource Bridge (platform resource management)
- `gateway/` — Management API for the frontend

**Key patterns:**
- Async throughout: all I/O is async (DB, external APIs)
- Dependency injection: stores and services are injected, not global singletons
- Session management: API endpoints use middleware-provided sessions; background work creates sessions explicitly
- All participants in rooms are clients reading and writing the `messages` table through the transport port

## The Switch skill

Every agent session is started by Switch Console or its sidecar; there are no
connector plugins and no standalone runtime. Each session gets the Switch MCP
tools from its own session host, and the room-workflow skill from Console:
`console/packages/plugins/src/switch-skill/SKILL.md` is the single copy,
exported as `@switch-console/plugins/switch-skill`. Codex and OpenCode load it
as a skill file; Claude Code, Cursor and Antigravity get it (without its
frontmatter) as system context.

When you change how agents interact with Switch — new/changed MCP tools, in-room
commands, room workflow, event delivery, or anything an agent needs to know —
update that file. It covers every host, so host-specific behavior is named in
the text rather than split into copies.
`core/tests/switch_core/bridges/agent/test_mcp_tool_surface.py` checks its
`## Tool index` against the tools the server registers.

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
- **Catch-and-log is acceptable in event loops** (e.g. a transport's delivery loop) where one bad event should not crash the client. Everywhere else, let exceptions propagate.

## Testing

Tests live in `core/tests/switch_core/` mirroring the module structure. Uses pytest with pytest-asyncio. Store tests should run against a real PostgreSQL instance — not mocks, not SQLite.

## Reference Documentation

- `docs/official/` — the published user-facing documentation
  (docs.flintai.dev) synced into the repo. Generated — edit the source in the
  docs repository, never here. Start at `docs/README.md` for how the sync
  works; `docs/official/internals/` covers architecture and the agent
  protocol for readers of this repo.
- `docs/old/ARCHITECTURE.md` — historical system overview: components, domain
  model, key flows, entry points, and a code map. Predates the docs sync and
  may lag the tree.
- `docs/old/api/AGENT_PROTOCOL.md` — the agent↔Switch protocol (connections, the
  event stream, room slots, failure handling). Authoritative where it and
  `ARCHITECTURE.md` overlap
- `docs/old/bridges/` — collaboration bridge setup: `README.md` plus one page each
  for Slack, Mattermost, Discord, Teams, and Telegram
- `docs/old/GATEWAY_OIDC_SETUP.md` — configuring the gateway's bring-your-own
  OIDC browser sign-in (variables, redirect URI, WorkOS Connect setup)
- `docs/old/LOCAL_DEVELOPMENT.md` — running Switch locally for development:
  `just` recipes, which port serves what, connecting Switch Console to a
  local server
- `docs/old/observability.md` — what switch-core reports about itself and how
  to turn it on: the metric catalogue and why attributes are declared, the
  split between the liveness and readiness routes and why only the database
  gates readiness, what the process reports in place of an infrastructure
  agent, and what tracing still needs. Dashboards and alerts live in
  `deploy/observability/`.
- `docs/old/multi-tenancy.md` — why Switch is multi-tenant the way it is: the
  tenant model, sign-in and onboarding, one official messaging app per
  platform, and the phased plan the work follows. Phases 0 and 1 are built,
  and most of Phase 2; read the code, not this, for what exists today.
- `docs/old/multi-tenancy-phase2-tenants.md` — several workspaces per person:
  how a request picks its tenant, the tenant and invitation API, workspace
  roles, and how sign-up works (§9a)
- `docs/old/multi-tenancy-phase1-db.md` — the Phase 1 database schema as built:
  tables, per-tenant uniqueness, and how a request's tenant is bound
- `docs/old/rds-migration.md` — moving a deployment's Postgres to RDS: the
  proposal and the cutover runbook

There is no separate schema, room-design, HTTP-API or MCP-surface document. Read
those from the code: `core/switch_core/db/models.py` for the schema,
`core/switch_core/room_service.py` for room provisioning and lifecycle,
`core/switch_core/bridges/agent/api/handlers.py` for the HTTP surface, and
`core/switch_core/bridges/agent/operations/definitions.py` for the agent tool
surface — one definition serves both the MCP server
(`bridges/agent/mcp/server.py`) and the HTTP front door
(`bridges/agent/api/operations.py`), so the two cannot drift.

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

Switch is an AI agent orchestration and governance platform. It onboards, orchestrates, and secures third-party AI agents using Matrix (Tuwunel) as the internal message bus. Agents register via the Agent Bridge API and communicate through Matrix rooms, with collaboration bridges to external platforms (Slack, Mattermost, Discord, Teams, Telegram).

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
- `clients/` — Matrix clients (agent, user, admin, bridge, resource manager)
- `bridges/` — External integrations
  - `agent/` — Agent Bridge (HTTP API, MCP server, server-side connectors)
  - `collaboration/` — Collaboration Bridge (Slack, Mattermost, Discord, Teams, Telegram adapters)
  - `resource/` — Resource Bridge (platform resource management)
- `gateway/` — Management API for the frontend

**Key patterns:**
- Async throughout: all I/O is async (Matrix, DB, external APIs)
- Dependency injection: stores and services are injected, not global singletons
- Session management: API endpoints use middleware-provided sessions; background work creates sessions explicitly
- All participants in rooms are Matrix clients (matrix-nio) connecting to Tuwunel

## Connector plugins

There are **three** connector plugins under `connectors/`, one per agent host,
and each ships its own copy of the Switch room-workflow skill at
`skills/switch/SKILL.md`:

- `connectors/claude-code-plugin/` — manifest `.claude-plugin/plugin.json`.
  Ships the skill plus an MCP config (`.mcp.json`) and hooks. It contains **no
  runtime code**: the MCP server is `@sandboxaq/switch-agent-runtime`,
  fetched with `npx` and built from `console/packages/switch-agent-runtime/`.
  Switch Console imports the same package for its protocol client, so there is one
  implementation of the agent protocol rather than a copy per consumer.
- `connectors/codex-plugin/` — manifest `.codex-plugin/plugin.json`. Ships the
  room-workflow skill, a **`configure`** skill (the standalone setup path — it
  registers the agent and supplies the bundled server's credentials so Codex
  reaches Switch with no Switch Console involved), and its own MCP config,
  declared as `"mcpServers": "./.mcp.json"`, so a
  Codex session gets the Switch tools from the plugin alone. Codex does not
  expand `${VAR}` in a bundled config, so the server names its variables under
  `env_vars` and Codex forwards them **by name** from its own environment — no
  expansion, and no secret in the file. An unset name is simply not forwarded,
  which is why the list can include the Switch Console-only variables without
  breaking a standalone session.

  The plugin's `.mcp.json` also carries `default_tools_approval_mode =
  "approve"`, so the Switch tools never prompt. It has to live there rather than
  in anything Switch Console writes: **no per-server setting can be layered onto a
  plugin-provided MCP server.** An `mcp_servers.switch.*` entry with no
  transport of its own — from the base config, a profile, or `-c` on argv —
  makes Codex reject the whole config as "invalid transport" and the session
  dies with it.

  Switch Console writes a per-agent Codex profile
  (`$CODEX_HOME/<slug>.config.toml`, launched with `--profile <slug>`) carrying
  **only** model, reasoning effort and instructions. It registers no MCP server.
  An agent that specializes none of those gets no profile and no `--profile`
  argv at all.

  Note a connector plugin is only upgraded when a user clicks Update in
  settings, and Codex caches an install per version, so an install on an older
  plugin has no Switch tools until it is upgraded.

- `connectors/opencode-plugin/` — manifest `package.json` (OpenCode plugins are
  npm modules, so that is its native manifest shape). Ships the skill, an MCP
  config (`opencode.json`) and a reporting plugin (`plugin/`).

  **It is written, not installed, and that is the one real difference between
  it and the other two.** OpenCode has no plugin marketplace — its `plugin`
  subcommand installs a single npm module and has no list, remove or version
  verb — so there is nothing for the marketplace driver to drive. Switch Console
  writes the files itself via `switchSetup: { kind: 'files' }`
  (`console/packages/plugins/src/agents/impl/opencode/switch-connector.ts`), and
  this directory is **not** registered in `.claude-plugin/marketplace.json`. The
  user-facing surface is the same: install, update and uninstall on the agent's
  card and in a remote host's setup.

  Because the app writes the files it also **embeds** them, and the embedded
  copies must not drift from this directory — `connector-assets.test.ts` fails
  if they do. Edit the files here; the test names what to update. Nothing
  fetched the install, so it has no version of its own to report: a status read
  compares the app version that stamped it against the running one.

  The MCP server is registered as a `local` (stdio) server, deliberately.
  OpenCode spawns a local server with the parent environment, so the runtime
  inherits `SWITCH_*` from the session and no credential is written into a
  config file shared by every OpenCode session on the machine. OpenCode *does*
  interpolate `{env:VAR}` and `{file:path}` (unlike Codex's name-forwarding and
  Claude's `${VAR}`), so a remote server carrying a header would also have
  worked; stdio was chosen because it needs no interpolation at all. Its config
  rejects unknown keys on an MCP entry and fails the whole config with them,
  which is why the install bookkeeping sits beside `opencode.json` rather than
  inside it.

When you change how agents interact with Switch — new/changed MCP tools, in-room
commands, room workflow, or anything an agent-facing client needs to know:

- **Update all three skills.** A room-workflow change must land in
  `connectors/claude-code-plugin/skills/switch/SKILL.md`,
  `connectors/codex-plugin/skills/switch/SKILL.md` *and*
  `connectors/opencode-plugin/skills/switch/SKILL.md` so the documented workflow
  matches actual behavior on every host.
  `core/tests/switch_core/bridges/agent/test_mcp_tool_surface.py` asserts the
  count, so it fails rather than letting a host quietly go undocumented.
- **Bump the versions of whatever you changed, in the same commit.** Not at
  release time — it gets forgotten, and then a version number is a claim nobody
  can trust. `console/AGENTS.md` has the table (all three plugins, runtime
  package, sidecar) and the rules for which digit moves.
- **Diff the skills against each other after editing.** They are deliberately not identical
  (host-specific wording for tool namespacing, event delivery, attachments, and
  MCP registration), so diff them to confirm
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

There is no separate schema, room-design, HTTP-API or MCP-surface document. Read
those from the code: `core/switch_core/db/models.py` for the schema,
`core/switch_core/room_service.py` for room provisioning and lifecycle,
`core/switch_core/bridges/agent/api/handlers.py` for the HTTP surface, and
`core/switch_core/bridges/agent/operations/definitions.py` for the agent tool
surface — one definition serves both the MCP server
(`bridges/agent/mcp/server.py`) and the HTTP front door
(`bridges/agent/api/operations.py`), so the two cannot drift.

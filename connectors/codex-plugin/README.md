# switch-connector (Codex)

The Codex build of the Switch connector plugin. It ships the **Switch
room-workflow skill** (`skills/switch/SKILL.md`) — the room workflow,
interaction modes, thread semantics, task protocol, room roles, and
moderation tools an agent needs in order to participate in a Switch room
correctly.

Manifest: `.codex-plugin/plugin.json`. Registered in the repo marketplace
(`.claude-plugin/marketplace.json`) as `switch-connector-codex`.

This is the sibling of `connectors/claude-code-plugin/`, which additionally
ships an MCP config and hooks. Those pieces are Claude Code-specific and are
deliberately **not** part of this plugin.

## The Switch MCP server is not registered by this plugin

Codex does **not** expand `${VAR}` inside a plugin-bundled `.mcp.json`, and
there is no `${CLAUDE_PLUGIN_ROOT}` equivalent for a plugin to reference its
own install path. A bundled MCP config would therefore be shipped with
unresolvable placeholders — it would either fail loudly or, worse, connect
with literal `${SWITCH_API_TOKEN}` text. So this plugin ships no `.mcp.json`
and never references its own path.

Instead, **switchdash registers the Switch MCP server when it launches the
Codex session** — as a per-agent Codex *profile*. It writes
`$CODEX_HOME/<agent-slug>.config.toml` (under `~/.codex`) declaring the local
`@sandbox-quantum/switch-agent-runtime` over stdio and launches Codex with
`--profile <agent-slug>`. The profile is static and holds no secret: it lists
the variables the runtime needs — `SWITCH_API_ENDPOINT` / `SWITCH_API_TOKEN` /
`SWITCH_AGENT_ID` (and `SWITCH_CONNECTION_ID`) — under `env_vars`, and Codex
forwards those by name from its own environment, which switchdash populates
from the agent's `.switch/agents/<slug>.json`. Naming them is not optional:
Codex hands an MCP server a fixed allowlist (`HOME`, `PATH`, `SHELL`, `USER`,
`TMPDIR`, …) rather than a copy of its own environment, so a server that names
nothing starts with no credentials and dies before the MCP handshake — which
the session reports only as `connection closed: initialize response`. The
`env_vars` list also carries the npm settings `npx` needs to fetch the runtime
from its private registry.

A profile does *not* replace a same-named server in the user's base
`~/.codex/config.toml` — the two tables are merged. A base `switch` entry from
the pre-profile design declares a `url`, which merges with this profile's
`command` into a server that is both, and Codex then refuses to load the config
at all. switchdash removes such an entry when it writes the profile. The skill
assumes the Switch tools are present under the `switch` server; if they are
missing, the session was launched without the profile.

A stdio server is used rather than the argument-vector overrides Codex also
accepts (`-c mcp_servers.switch.*`) because the profile is the single unit
that also carries per-agent model, reasoning effort, and instructions.

## What the registered runtime gives a Codex session

The runtime is the same package the Claude Code connector registers, so a
Codex session gets the same tool surface: every Switch operation the agent
bridge advertises, plus the runtime's own `send_attachment` and
`download_attachment`. Neither is gated on which process owns the
connection, so the skill documents the tools rather than `curl` against the
bridge media endpoint — that is now only the fallback for a session with no
Switch MCP server at all.

Events are the part that differs from Claude Code. Codex has no channel of
its own to receive MCP notifications, so switchdash opens the session's
event connection itself, hands the id over as `SWITCH_CONNECTION_ID`, and
delivers what arrives into the session's pane as `[Switch] …` lines. The
runtime borrows that connection rather than opening a second one: the
session's `connect_to_room` therefore claims the room on the connection
switchdash is reading, which is how switchdash learns which room the session
is in — no tool-response scraping, and no per-session room-tracking hook.

One caveat on remote hosts: room tracking depends on that connection, which
switchdash opens only for a session it can keep attached — i.e. a tmux session.
A remote session started with tmux disabled gets the Switch MCP tools (the
profile is still written) but no `SWITCH_CONNECTION_ID`, so it never claims a
room server-side and receives no `[Switch]` events. Run remote Codex agents
with tmux (the default) for room participation.

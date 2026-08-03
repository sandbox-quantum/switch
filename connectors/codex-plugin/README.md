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
`--profile <agent-slug>`. The profile is static and holds no secret: the
runtime reads `SWITCH_API_ENDPOINT` / `SWITCH_API_TOKEN` / `SWITCH_AGENT_ID`
(and `SWITCH_CONNECTION_ID`) from the session environment it inherits, which
switchdash injects from the agent's `.switch/agents/<slug>.json`. Because a
profile layers over — and cleanly overrides — the user's base
`~/.codex/config.toml`, it never clobbers a `switch` server the user defined
themselves. The skill assumes those tools are present under the `switch`
server; if they are missing, the session was launched without the profile.

A stdio server is used rather than the argument-vector overrides Codex also
accepts (`-c mcp_servers.switch.*`) because the profile is the single unit
that will also carry per-agent model, reasoning effort, and instructions.

Attachments are handled the same way — there is no channel process for
Codex, so the skill documents `curl` against the bridge media endpoint
(`/agents/<agent_id>/rooms/<room_id>/media`) using the session's
`SWITCH_API_ENDPOINT` / `SWITCH_AGENT_ID` / `SWITCH_API_TOKEN` environment
variables.

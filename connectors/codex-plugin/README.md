# switch-connector (Codex)

The Codex build of the Switch connector plugin. It ships the **Switch MCP
server** that provides the Switch tools, plus two skills:

- **`skills/switch/SKILL.md`** — the room workflow, interaction modes, thread
  semantics, task protocol, room roles, and moderation tools an agent needs in
  order to participate in a Switch room correctly.
- **`skills/configure/SKILL.md`** — the **standalone setup path**: register
  this Codex instance as a Switch agent and give the bundled server the
  credentials it needs, so `codex` connects to Switch with no switchdash
  involved. See "Standalone setup" below.

Manifest: `.codex-plugin/plugin.json`. Registered in the repo marketplace
(`.claude-plugin/marketplace.json`) as `switch-connector-codex`.

This is the sibling of `connectors/claude-code-plugin/`. Both ship the skill
and an MCP config; the Claude plugin additionally ships hooks, which are
Claude Code-specific and deliberately not part of this one.

## The Switch MCP server

The manifest declares `"mcpServers": "./.mcp.json"`, and that file registers
`@sandbox-quantum/switch-agent-runtime` over stdio under the server name
`switch` — the name the skill assumes. A Codex session with this plugin
installed has the Switch tools, whether or not switchdash launched it.

The config holds **no secret**. It names the variables the runtime needs under
`env_vars`, and Codex forwards those **by name** from its own environment:

```json
{
  "mcpServers": {
    "switch": {
      "command": "npx",
      "args": ["-y", "@sandbox-quantum/switch-agent-runtime@0.1.6"],
      "env_vars": ["SWITCH_API_ENDPOINT", "SWITCH_API_TOKEN", "SWITCH_AGENT_ID", "…"],
      "startup_timeout_sec": 60
    }
  }
}
```

Naming them is not optional. Codex hands an MCP server a fixed allowlist
(`HOME`, `PATH`, `SHELL`, `USER`, `TMPDIR`, …) rather than a copy of its own
environment, so a server that names nothing starts with no credentials and dies
before the MCP handshake — which the session reports only as
`connection closed: initialize response`.

Two properties of `env_vars` are worth stating, because the plugin's shape
depends on them:

- **It forwards by name, so no `${VAR}` expansion is required.** Codex does not
  expand `${VAR}` inside a bundled config — it stores the literal string — but
  that only rules out an `env` map of placeholders, not a bundled config as
  such. (This was previously documented the other way round, as a reason the
  server could not ship here at all.)
- **An unset name is simply not forwarded.** So the list can name
  switchdash-only variables (`SWITCH_CONNECTION_ID`, the npm registry settings)
  without breaking a session that has none of them. The Claude connector cannot
  do this: `${VAR}` expansion makes every declared variable mandatory.

`startup_timeout_sec` is raised from Codex's 10s default because a host that has
never run the runtime can exceed it on the `npx` fetch alone, and a timeout
there is indistinguishable from a broken server.

## What switchdash adds on top

switchdash writes a per-agent Codex *profile*
(`$CODEX_HOME/<agent-slug>.config.toml`, launched with `--profile <agent-slug>`)
carrying what is genuinely per-agent: model, reasoning effort, and
instructions. It registers **no** MCP server — this plugin does that — and an
agent that specializes none of those three gets no profile at all.

switchdash's remaining job for the server is to put the credentials this config
names into the session's environment, read from the agent's
`.switch/agents/<slug>.json`.

Standalone — no switchdash — nothing populates that environment, and since
`switch-agent-runtime` 0.2.0 the runtime reads that same file itself rather than
exiting. Where a working directory names several agents it serves a
`select_agent` tool and refuses the rest until the session picks one; where it
can find no usable agent at all it serves a single `switch_unavailable` tool
that reports why, rather than dying before the MCP handshake and leaving the
session with no explanation.

Because a plugin is only upgraded when a user clicks Update in switchdash's
settings, and Codex caches each version in its own directory, an install on a
plugin older than this one has no Switch tools until it is upgraded.

## Auto-approving the Switch tools

`.mcp.json` sets `default_tools_approval_mode: "approve"`. An agent answering a
room is unattended by definition, so a permission prompt on `post_message`
stops the turn with nobody watching to release it, and the tools reach Switch
over the session's own credentials without touching the host.

Two things are worth knowing before changing it:

- **`approval_policy` does not govern MCP tool calls at all.** Measured against
  codex-cli 0.146.0, a write-annotated MCP tool is denied under `untrusted`,
  `on-request` *and* `never` alike. `default_tools_approval_mode` is the only
  lever that moves them, and `approve` is the only one of its four values
  (`auto`, `prompt`, `writes`, `approve`) that admits a tool annotated as
  writing.
- **A value outside that enum fails silently.** Codex does not reject it — it
  drops the entire server and reports no MCP servers at all, so the session
  simply has no Switch tools.

It lives here rather than in anything switchdash writes because no per-server
setting can be layered onto a plugin-provided server: an `mcp_servers.switch.*`
entry with no transport of its own, whether from the base config, a profile or
`-c` on argv, makes Codex reject the whole config as "invalid transport".

A profile does *not* replace a same-named server in the user's base
`~/.codex/config.toml` — the two tables are merged. A base `switch` entry from
the pre-profile design declares a `url`, which merges with a `command` entry
into a server that is both, and Codex then refuses to load the config at all.
switchdash removes such an entry.

## Standalone setup (no switchdash)

The `configure` skill covers the case switchdash does not: a user who installs
this plugin and wants `codex` to reach Switch from a plain terminal. It
registers the agent against the bridge (`POST /agents/register-known` with
`agent_type: "codex"`) and writes the credentials to
`.switch/agents/<name>.json` in the working directory.

**It writes no MCP config at all.** The plugin's `.mcp.json` is the single
server definition; the skill supplies only the *identity*. Since
`switch-agent-runtime` 0.2.0 the runtime resolves that itself — environment
first (switchdash's path, untouched), otherwise the local agent store read from
the session's working directory.

That division matters, because the obvious alternative is actively harmful.
Supplying credentials through a second `mcp_servers.switch` entry does not work:
measured against codex-cli 0.146.0, a config-file entry **replaces** a
plugin-provided server rather than merging with it per key, dropping
`default_tools_approval_mode: approve` — which leaves the agent unable to post —
along with `startup_timeout_sec`. An entry with no transport of its own is
rejected outright as `invalid transport`, taking every Codex session on the
machine with it. There is no way to layer credentials onto a plugin-provided
server, which is precisely why the runtime learned to find them itself.

### The npm environment is part of the contract

Codex hands the MCP server a fixed env allowlist, and `npm_config_*` is not in
it. The runtime is fetched with `npx` from a **private** registry, so the server
must resolve the `@sandbox-quantum` scope from *its own* environment.

This is worth stating because the failure is silent and the obvious check lies:
`npm config get` in an interactive shell can report a correctly configured
registry the server never sees, since switchdash exports `npm_config_userconfig`
pointing at its own npmrc. The server then queries `registry.npmjs.org`, gets a
404 (private packages are not admitted to exist), and dies before the handshake
— with no symptom beyond the tools being absent. The `configure` skill therefore
verifies with a stripped environment (`env -i HOME=... PATH=...`) rather than
trusting the shell's answer.

### What standalone does and does not get

Works: the full Switch tool surface (including `send_attachment` /
`download_attachment` — neither is gated on which process owns the connection),
room participation, tasks, roles, moderation, and the offline run command.

Does not: **inbound events are not pushed into the session.** switchdash reads
the session's event connection and injects `[Switch] …` lines into its pane;
standalone, nothing does. The runtime opens its own connection (no
`SWITCH_CONNECTION_ID` is set, which is correct — that names a connection a
supervisor has already opened to share), but the session is pull-based: it calls
`read_context` to catch up rather than being notified. Also absent:
`auto_session` spawning, and per-agent model / reasoning-effort / instruction
overrides.

### Identity is per working directory

The store is read from the session's working directory, so a different directory
with its own `.switch/agents/` is a different agent. Two consequences worth
knowing:

- `repo_dir` should be the directory the credentials were written into. The
  offline run command Switch posts is a bare
  `cd "<repo_dir>" && codex "connect to switch room <name>"`, so if the two
  disagree the pasted command starts Codex where the store isn't.
- Several agents in one directory is supported: the runtime leaves the identity
  open and the session binds one with `select_agent`. Agents spanning **several
  Switch servers** is not — startup refuses, because the catalog is fetched
  before the handshake and picking a server arbitrarily would bootstrap a tool
  surface from a deployment the agent may not belong to. `SWITCH_API_ENDPOINT`
  disambiguates.

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
plugin registers them regardless) but no `SWITCH_CONNECTION_ID`, so it never
claims a room server-side and receives no `[Switch]` events. Run remote Codex
agents with tmux (the default) for room participation.

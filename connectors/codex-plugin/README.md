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
      "args": ["-y", "@sandbox-quantum/switch-agent-runtime@0.1.4"],
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
`agent_type: "codex"`) and then registers the MCP server with `codex mcp add`,
storing the credentials as **literal values** in the user's base config.

Literal values, rather than the `env_vars` name-forwarding the profile uses,
because the two paths differ in who launches Codex. `env_vars` forwards names
from the launching process's environment — which works precisely because
switchdash *is* that process and populates it. Standalone there is no
injector, so names would forward nothing and the runtime would die before the
MCP handshake.

Three properties of Codex config, all verified against codex-cli 0.146.0,
constrain how this can be done:

- **An `mcp_servers.<name>` table must declare its own transport.** An
  `env`-only table — the obvious way to add credentials to a server the plugin
  already registers — is rejected with `Error loading config.toml: invalid
  transport`, and that failure takes down **every** Codex session on the
  machine, not just the Switch tools. This is why the skill drives
  `codex mcp add` (which always writes a complete entry) instead of editing
  TOML.
- **Codex has no project-scoped config.** There is no `./.codex/config.toml`
  equivalent of a per-repo settings file; `mcp_servers` is read from
  `$CODEX_HOME` only. So the standalone identity is per-machine, and the
  Claude connector's per-project/global scope choice has no analogue here.
- **The offline run command Switch posts never includes `--profile`** — it is
  a bare `cd "<repo_dir>" && codex "connect to switch room <name>"`. Base
  config is therefore the only placement where that paste-ready command works
  as written, which is why the skill puts it there.

### The npm environment is part of the contract

Codex hands the MCP server a fixed env allowlist, and `npm_config_*` is not in
it. The runtime is fetched with `npx` from a **private** registry, so the
server must be able to resolve the `@sandbox-quantum` scope from *its own*
environment — `~/.npmrc`, or an npmrc named explicitly on the server entry.

This is worth stating because the failure is silent and the obvious check
lies: `npm config get` in an interactive shell can report a correctly
configured registry that the server never sees, since switchdash exports
`npm_config_userconfig` pointing at its own npmrc. The server then queries
`registry.npmjs.org`, gets a 404 (private packages are not admitted to exist),
and dies before the MCP handshake — with no symptom beyond the tools being
absent. The `configure` skill therefore verifies with a stripped environment
and, when the effective npmrc is not `~/.npmrc`, passes `npm_config_userconfig`
and any variable that file interpolates on the server entry.

The entry also sets `startup_timeout_sec = 60`, matching the profile:
`codex mcp add` writes no timeout, and Codex's 10s default can be exceeded by
the `npx` fetch alone.

### What standalone does and does not get

Works: the full Switch tool surface (including `send_attachment` /
`download_attachment` — neither is gated on which process owns the
connection), room participation, tasks, roles, moderation, and the offline run
command.

Does not: **inbound events are not pushed into the session.** switchdash reads
the session's event connection and injects `[Switch] …` lines into its pane;
standalone, nothing does. The runtime opens its own connection (no
`SWITCH_CONNECTION_ID` is set, which is correct — that variable names a
connection a supervisor has already opened to share), but a standalone session
is pull-based: it calls `read_context` to catch up rather than being notified.
Also absent: `auto_session` spawning, per-agent model / reasoning-effort /
instruction overrides, and more than one Codex identity per machine.

### Base config and a profile on the same machine

Codex **merges** a profile's `[mcp_servers.switch]` with the base one, per
key, and the base entry's literal `env` **wins** over the profile's `env_vars`
forwarding. A base entry written by the `configure` skill therefore overrides
the per-agent credentials switchdash injects, and the switchdash session
silently runs as the standalone agent — wrong identity, no error.

The skill checks for `~/.codex/*.config.toml` and warns before writing, but
the sharp edge is real: a user who relies on switchdash for their Codex agents
does not need the `configure` skill and should not run it.

> Note the claim above that switchdash "removes such an entry when it writes
> the profile" is about a *different-transport* entry and is, as of this
> writing, not implemented — `codexMcpAdapter.removeServer` has no call sites.
> A same-transport base entry is not removed either, which is what makes the
> credential override above reachable.

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

# switch-connector (Codex)

The Codex build of the Switch connector plugin. It ships two skills:

- **`skills/switch/SKILL.md`** — the room workflow, interaction modes, thread
  semantics, task protocol, room roles, and moderation tools an agent needs in
  order to participate in a Switch room correctly.
- **`skills/configure/SKILL.md`** — the **standalone setup path**: register
  this Codex instance as a Switch agent and wire the `switch` MCP server into
  `~/.codex/config.toml` with that agent's credentials, so `codex` connects to
  Switch with no switchdash involved. See "Standalone setup" below.

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
profile is still written) but no `SWITCH_CONNECTION_ID`, so it never claims a
room server-side and receives no `[Switch]` events. Run remote Codex agents
with tmux (the default) for room participation.

# switch-connector (OpenCode)

The OpenCode build of the Switch connector. It ships the **Switch
room-workflow skill** (`skills/switch/SKILL.md`) — the room workflow,
interaction modes, thread semantics, task protocol, room roles, and
moderation tools an agent needs in order to participate in a Switch room
correctly — the **Switch MCP server** that provides the tools the skill
describes, and a small **reporting plugin** that tells Switch Console what the
session is doing.

This is the sibling of `connectors/claude-code-plugin/` and
`connectors/codex-plugin/`, and this directory is the source of truth for all
three of those pieces. One thing about it is genuinely different, and it is
worth understanding before changing anything here.

## It is written, not installed

The other two connectors are installed by their host's plugin-marketplace CLI:
`claude plugin install`, `codex plugin add`. **OpenCode has no marketplace.**
Its `plugin` subcommand installs a single npm module and has no list, remove or
version verb, so there is nothing for the marketplace driver to drive.

So Switch Console installs this connector by writing its files itself, through
the `switchSetup: { kind: 'files' }` capability
(`console/packages/plugins/src/agents/impl/opencode/switch-connector.ts`). The
user-facing surface is identical — the agent's card in Settings → Agents, and a
remote host's setup, offer install, update and uninstall exactly as for the
other two — but there is no marketplace entry, and this directory is not
registered in `.claude-plugin/marketplace.json`.

Because the app writes the files, it also carries their content: the plugin
source and the MCP fragment here are embedded in the app at
`console/packages/plugins/src/agents/impl/opencode/`. **They must not drift** —
`connector-assets.test.ts` fails if they do. Edit the files here; the test tells
you what to update.

An install has no version of its own to report, since nothing fetched it. A
status read compares the app version that stamped the install against the
running one, so "update available" means the connector was written by an older
build of Switch Console.

## The Switch MCP server

`opencode.json` registers `@sandboxaq/switch-agent-runtime` under the server
name `switch`, as a **local** (stdio) server.

That transport choice is what keeps the credential off disk. OpenCode spawns a
local MCP server with the full parent environment, so the runtime inherits
`SWITCH_API_ENDPOINT`, `SWITCH_API_TOKEN` and `SWITCH_AGENT_ID` from the session
Switch Console launched — and nothing secret is written into a config file that
every OpenCode session on the machine reads.

OpenCode *does* interpolate `{env:VAR}` and `{file:path}` in config values
(unlike Codex, which forwards variables by name, and Claude Code, which expands
`${VAR}`), so a remote server carrying an `Authorization` header would also have
worked. Stdio was chosen because it needs no interpolation at all.

Two constraints on this file, both of which fail loudly if broken:

- OpenCode rejects **unknown properties** on an MCP entry and fails the whole
  config with them. Only `type`, `command`, `cwd`, `environment`, `enabled` and
  `timeout` may appear.
- The default startup allowance is 5s, which a cold `npx` fetch will miss, so
  `timeout` is raised. The first session after an install is the one that pays
  that cost.

Switch Console's install merges this `mcp` block into the user's global
`~/.config/opencode/opencode.json`, leaving their other MCP servers and settings
alone, and records what it wrote in `switch-connector.json` beside it — outside
`opencode.json`, because of the unknown-key rule above.

## The reporting plugin

`plugin/switch-notifications.js` is dropped into a session's working directory
at `.opencode/plugins/`, where OpenCode auto-discovers it. It reports the
session id, turn boundaries and per-tool activity to Switch Console over the
local hook port, which is what makes an OpenCode session show as working or
completed in its rooms rather than sitting in one state.

Two things about it are load-bearing and are pinned by tests:

- **It never writes to stdout or stderr.** OpenCode renders a plugin's output
  straight into the TUI, where it corrupts the display around the input box. All
  logging goes through `client.app.log`, landing in OpenCode's own log files.
- **A turn starts on a new user message id, not on any user message.** OpenCode
  re-emits the user message about 20ms *after* `session.idle` to attach final
  token and cost stats. Matching on the role alone sends the session straight
  back to working, and it never reports completed again.

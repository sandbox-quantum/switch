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

## It installs itself

The other two connectors are installed by their host's plugin-marketplace CLI:
`claude plugin install`, `codex plugin add`. **OpenCode has no marketplace.**
Its plugin resolver takes exactly two things — a directory on disk, or an npm
package name — and its `plugin` subcommand has no list, remove or version verb,
so there is nothing for a marketplace driver to drive.

Nor does installing the package amount to installing the connector. npm leaves
the module in a cache, and OpenCode discovers a skill only as a file in one of
a few directories it searches; a cached module is not one of them. So the
package carries the install itself:

```
npx -y @sandboxaq/switch-connector-opencode install
```

That merges the `mcp` block below into `~/.config/opencode/opencode.json`,
leaving the user's other MCP servers and settings alone, writes every skill
under `skills/` to where OpenCode looks for it, and records what it wrote in
`switch-connector.json` beside the config — outside `opencode.json`, because of
the unknown-key rule below. `uninstall` reverses exactly that, and `status`
reports the installed version.

Everything it writes comes from the files in this directory, so there is no
second copy of the connector to keep in step: the MCP entry is `opencode.json`'s
own `mcp` block, and the skills are the directories under `skills/`.

Switch Console offers install, update and uninstall on the agent's card in
Settings → Agents, and in a remote host's setup, exactly as for the other two.

Publishing is a tag, `switch-connector-opencode-v<version>`, and the same lag
rule as the agent runtime applies: nothing may pin a version before the tag
that publishes it exists.

## The standalone path

With no Switch Console, an OpenCode session reaches Switch in two steps: the
install command above, then the **`configure` skill** (`skills/configure/`) run
once in the directory you work from. That registers the agent and writes its
credentials to `.switch/agents/<name>.json`, which is where the runtime looks
when the session environment carries no identity.

Note the asymmetry, because it catches people out: the MCP server and the
skills are installed **globally**, so every OpenCode session on the machine has
the Switch tools; the identity is **per working directory**.

## The room-workflow skill

`skills/switch/SKILL.md` is written to `~/.config/opencode/skills/switch/`,
which is one of the locations OpenCode discovers skills from. It is loaded
on demand: OpenCode advertises the name and description through its native
`skill` tool, and the agent pulls the body when Switch work starts.

Global, not per-workspace, to match the MCP server it explains — that is
registered globally, so any OpenCode session on the machine has the Switch
tools whether or not Switch Console launched it. A skill written into one
workspace would leave every other session holding the room tools with nothing
saying how a room works.

The directory name is load-bearing: OpenCode derives the skill name from the
folder and rejects one whose frontmatter `name` disagrees with it.

## The Switch MCP server

`opencode.json` registers `@sandboxaq/switch-agent-runtime` under the server
name `switch`, as a **local** (stdio) server.

That transport choice is what keeps the credential off disk. OpenCode spawns a
local MCP server with the full parent environment, so the runtime inherits
`SWITCH_API_ENDPOINT`, `SWITCH_API_TOKEN` and `SWITCH_AGENT_ID` from the session
that launched it — and nothing secret is written into a config file that every
OpenCode session on the machine reads. Standalone there is no such environment,
which is what the per-directory credential store is for.

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

## The reporting plugin

`plugin/switch-notifications.js` is dropped into a session's working directory
at `.opencode/plugins/`, where OpenCode auto-discovers it, and is also the
package's `./server` entrypoint for anyone loading the connector through
OpenCode's own `plugin` array. It reports the session id, turn boundaries and
per-tool activity to Switch Console over the local hook port, which is what
makes an OpenCode session show as working or completed in its rooms rather than
sitting in one state. Standalone there is nothing listening on that port, and it
reports nothing.

Two things about it are load-bearing and are pinned by tests:

- **It never writes to stdout or stderr.** OpenCode renders a plugin's output
  straight into the TUI, where it corrupts the display around the input box. All
  logging goes through `client.app.log`, landing in OpenCode's own log files.
- **A turn starts on a new user message id, not on any user message.** OpenCode
  re-emits the user message about 20ms *after* `session.idle` to attach final
  token and cost stats. Matching on the role alone sends the session straight
  back to working, and it never reports completed again.

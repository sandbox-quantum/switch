---
name: "configure"
description: "Set up the Switch connector for Codex — register this Codex instance as a Switch agent and register the `switch` MCP server with the credentials it needs. Use when the user asks to configure Switch, set up the plugin, register with a Switch server, or when the Switch tools are missing or failing because credentials are absent."
---

# Configure the Switch connector (Codex)

This skill registers the current Codex instance as a Switch agent and wires
the `switch` MCP server into Codex's configuration with that agent's
credentials, so a session started from a plain terminal has the Switch tools
and acts as the right identity.

**This is the standalone path.** Sessions launched by **switchdash** need none
of it — switchdash registers the MCP server itself, as a per-agent Codex
profile, and injects the credentials. Run this skill when there is no
switchdash: you install the plugin, run this once, and `codex` connects to
Switch on its own. Read "What you get without switchdash" at the bottom before
promising the user a capability, because the standalone path is deliberately
not feature-complete.

## How Codex gets the credentials

The runtime needs three values:

- `SWITCH_API_ENDPOINT` — Switch server URL
- `SWITCH_API_TOKEN` — the agent's API key (returned at registration)
- `SWITCH_AGENT_ID` — the agent's ID (returned at registration)

Codex does **not** hand an MCP server a copy of its own environment. It passes
a fixed allowlist (`HOME`, `PATH`, `SHELL`, `USER`, `TMPDIR`, …) plus whatever
the server's own config entry supplies. A server that is given nothing starts
with no credentials and dies before the MCP handshake — which Codex reports
only as `connection closed: initialize response`.

There are two ways an entry can supply them, and the difference is the whole
reason this skill exists:

- `env_vars = [...]` — names only, **forwarded from the launching process's
  environment**. This is what switchdash writes, because switchdash *is* the
  launching process and populates that environment.
- `env = { ... }` — **literal values stored in the config**. Nothing needs to
  inject anything.

Standalone there is no injector, so this skill writes **literal values**, into
the user's base config, under the server name `switch` — the name the
room-workflow skill assumes.

> **Resolve the Codex home once, and use it everywhere.** Codex reads its
> config from `$CODEX_HOME`, falling back to `~/.codex`. Every path in this
> skill must honour that override, or you will inspect one directory while
> `codex mcp add` writes to another — reporting on a config that is not the
> one in play. Set it first and use it in every command below:
>
> ```bash
> CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
> ```

> **Never write an entry that has `env` but no transport.** A
> `[mcp_servers.switch.env]` table with no `command`/`url` of its own makes
> Codex fail with `Error loading config.toml: invalid transport`, and that
> kills **every** Codex session on the machine, not just the Switch tools.
> Adding credentials to a server the plugin registers is *not* possible that
> way. Always write a complete entry — which is exactly what `codex mcp add`
> does, so use it rather than hand-editing TOML.

## Step 0 — Registry access for the runtime

The MCP server is fetched with `npx @sandbox-quantum/switch-agent-runtime`.
That package is published to **GitHub Packages** and is private, so npm needs
to know which registry serves the `@sandbox-quantum` scope and how to
authenticate. Without both, `npx` fails — and it fails **misleadingly**: a
private package you are not authorised for returns **404**, not 403, because
registries do not admit that private packages exist. "Package not found"
almost always means "not logged in" here.

First check whether it is already set up:

```bash
npm config get @sandbox-quantum:registry
```

If that prints `https://npm.pkg.github.com`, skip to Step 1.

Otherwise it needs the GitHub CLI, authenticated **and holding the
`read:packages` scope**:

```bash
gh auth status
```

If `gh` is missing or logged out, stop and tell the user to install it and run
`gh auth login` — everything below depends on it, and guessing a token is not
something to attempt.

Then look at the `Token scopes:` line. **`gh auth login` does not request
`read:packages`** — the default scopes are `gist`, `read:org`, `repo` and
`workflow`. A perfectly healthy login therefore produces a token the registry
refuses:

```
npm error 403 Permission permission_denied: The token provided does not match expected scopes.
```

If `read:packages` is absent, have the user add it:

```bash
gh auth refresh -h github.com -s read:packages
```

That opens a device-code prompt in a browser. If they cannot complete it (a
headless box, for instance), the alternative is a classic PAT with
`read:packages`, used in place of `gh auth token` below.

Then, with the user's agreement (this writes to their `~/.npmrc`):

```bash
npm config set @sandbox-quantum:registry https://npm.pkg.github.com
npm config set //npm.pkg.github.com/:_authToken "$(gh auth token)"
```

Verify it resolves before moving on, so a failure surfaces here rather than as
a broken MCP server later:

```bash
npm view @sandbox-quantum/switch-agent-runtime version
```

Two things to tell the user plainly rather than leave them to discover:

- This writes a **real token into `~/.npmrc`** (mode 0600). It is how npm
  authenticates to any private registry, but it is a credential at rest.
- It **expires when `gh` rotates its token**, and the symptom is the same
  misleading 404. Re-running the two `npm config set` lines fixes it.

## Step 1 — Check what is already there

Inspect the existing `switch` MCP server entry, if any:

```bash
codex mcp get switch
```

Interpret the result before doing anything:

- **Not found** — nothing configured yet. Continue to Step 2.
- **`transport: stdio`** with a `command` of `npx …switch-agent-runtime` —
  already configured by this skill. Report the endpoint and agent id (from
  `codex mcp list`, which masks env values, or by reading
  `$CODEX_DIR/config.toml`) and ask the user whether to keep it or re-register.
  **Default to keeping it.** Re-registering mints a fresh agent and orphans
  the old one in Switch, along with its rooms, history and task ledger.
- **`transport: streamable_http`** (an entry with a `url`) — a leftover from
  the pre-profile design. It must go: a base entry declaring a different
  transport merges with a profile's `command` into a server that is both, and
  Codex then refuses to load the config at all. Remove it with the user's
  agreement before continuing:

  ```bash
  codex mcp remove switch
  ```

Also check whether switchdash has been used on this machine:

```bash
find "$CODEX_DIR" -maxdepth 1 -name '*.config.toml' 2>/dev/null
```

Any file listed is a switchdash-written per-agent profile. **If there are
any, warn the user before continuing** — see "Coexisting with switchdash"
below. It is their call, but it must be an informed one.

## Step 2 — Switch server URL

Confirm the Switch server URL with the user — this is the agent-bridge
endpoint, stored as `SWITCH_API_ENDPOINT`. If `SWITCH_API_ENDPOINT` is
already set in the environment, offer it as the default; otherwise ask for
their deployment's hostname (e.g. `http://localhost:8000` for local dev, or
the URL of a hosted deployment).

## Step 3 — Registration token

Registration is gated by a token the user mints in the Switch gateway UI
under the **API keys** tab (it is a server-side `api_key` of type
`"registration"`; the bridge resolves it to the owning user when minting the
agent, so the new Codex agent ends up owned by whoever issued the token).

Check the current environment for `SWITCH_REGISTRATION_TOKEN` (run
`printenv SWITCH_REGISTRATION_TOKEN`). If unset, ask the user to paste it,
telling them exactly where to get it: **"Open the Switch gateway UI for your
deployment, go to the API keys tab, and create (or copy an existing)
registration token."** Don't just say "from the admin" — point them at the
concrete UI surface.

**Treat the token as sensitive.** It lets the holder mint agents owned by its
user. Never echo it back, never write it to any file, never include it inline
in a shell command (it would land in shell history). Pass it via the
environment variable only — see Step 6.

## Step 4 — Agent name and description

Switch validates the agent name against `^[a-z0-9][a-z0-9._-]*$` — lowercase
letters, digits, dots (`.`), hyphens (`-`), and underscores (`_`) only. Must
start with a letter or digit. **No spaces, no `@`, no uppercase.** The
constraint exists because the name is used in Matrix room handles and
`@mention` syntax inside rooms.

Suggest a default that **identifies the user**, not just the repo or machine.
Switch agent names are visible to everyone in the rooms this agent joins —
teammates, the moderator, other AI agents. If two developers at the same
company both register a Codex agent from a popular shared repo (e.g.
`my-project`), a repo-only name like `codex.my-project` collides for both of
them and nobody can tell which human is behind which agent. Always include a
per-user identifier:

- `codex.<slug-of-repo-name>.<slug-of-username>` (e.g. for repo `my-project`
  on user `alice` → `codex.my-project.alice`). Get the repo name from
  `basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"` and the
  username from `$USER` or `whoami`.
- If the identity is not tied to any one repo, `codex.<slug-of-username>` is
  fine.

To slugify: lowercase the string, replace any character not in `[a-z0-9._-]`
with `-`, collapse consecutive `-`, strip leading and trailing `-`.

Confirm the suggested name with the user or accept a custom one. If the user
supplies a name that does not match the regex, explain why (so they can fix it
themselves next time) and ask again. If the user proposes a name with no
obvious user identifier, flag the collision risk once and let them decide —
don't override their choice.

Also ask for a one-line description — it shows up in Switch room participant
lists, so it should help other agents and humans recognise this one. Default:
`Codex running in <repo-name-or-hostname>`.

> **Note there is no channels question here.** The Claude Code connector asks
> one, because a Claude session can receive pushed events through a plugin
> channel. Codex has no such channel, and the Switch backend's `CodexOptions`
> has no `channels_enabled` field at all — sending one is silently ignored.
> There is also **no subagent registration step**: Codex has no
> `.claude/agents/*.md` equivalent, and the bulk endpoint would happily mint
> a batch of indistinguishable children. Do not call it.

## Step 5 — Repository directory (`repo_dir`) and notify user

Switch shows room participants a **ready-to-paste terminal command** that
starts this agent and connects it to the room:

```
cd "<repo_dir>" && codex "connect to switch room <name>"
```

That message is posted automatically whenever someone addresses this agent
while no session is active, and on demand via the `!run-cmd @<agent-name>`
room command. For it to be useful Switch needs the directory the operator
runs Codex from — that's `repo_dir`.

Ask whether to record it. Explain in plain terms: *"If you set this, room
participants who try to reach this agent while it's offline will see a
copy-pastable command they can run to start it. If you skip, they get a
generic 'not connected' message instead."* Suggest the current working
directory as the default. Validate that the value is an absolute path
(`startswith("/")`) and that the directory exists (`test -d`). If either
check fails, re-ask or let the user skip.

Then ask whether to record `notify_user`. When someone addresses this agent
with no live session, Switch can prepend an `@username` mention to that
message so the bridged platform fires a push notification. Explain: *"Use the
exact handle they have on the room's bridged platform (Slack / Mattermost),
or their Switch user name for unbridged rooms — this is often NOT the same as
the local username. If the handle doesn't match a real bridge user the mention
silently does nothing."* Ask for the bare handle, no leading `@`. Do not
assume a default — in particular, do not fall back to `$USER`.

Omit either key entirely if the user opts out (do not pass an empty string —
leave the key out so the schema default of `None` applies).

**Do not set `auto_session`.** It means "the operator's connector (switchdash)
watches every room this agent belongs to and auto-spawns a session when it is
addressed". With no switchdash there is nothing to do the spawning, so setting
it would advertise a capability that does not exist. Leave it at its default
of `false`.

## Step 6 — Register

Call the bridge endpoint `POST /agents/register-known`. It takes the
registration token in the `Authorization` header, looks up the `codex`
known-agent spec in Switch (which knows the right tool list and capabilities
for Codex), and returns the new agent's `id` and `api_key`.

Run with the registration token in the environment — do not inline the token
in the command itself, since command lines end up in shell history and process
listings:

```bash
curl -sf -X POST "$ENDPOINT/agents/register-known" \
  -H "Authorization: Bearer $SWITCH_REGISTRATION_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -nc --arg name "$NAME" --arg desc "$DESC" \
       --arg repo_dir "$REPO_DIR" \
       --arg notify_user "$NOTIFY_USER" \
       '{agent_type:"codex", name:$name, description:$desc,
         options:((if $repo_dir == "" then {} else {repo_dir:$repo_dir} end)
                  + (if $notify_user == "" then {} else {notify_user:$notify_user} end)),
         overwrite:false}')"
```

Set `$REPO_DIR` to the absolute path from Step 5 (or empty to omit) and
`$NOTIFY_USER` to the bare handle (or empty to omit).

**Pitfall — env-var expansion order.** Do NOT prefix the curl command with
`SWITCH_REGISTRATION_TOKEN=... curl ...` while also referencing
`$SWITCH_REGISTRATION_TOKEN` in the same command. The shell expands
`$SWITCH_REGISTRATION_TOKEN` against the *parent* shell's environment *before*
the inline assignment takes effect, so if the variable wasn't already exported
you'll send `Authorization: Bearer ` (empty), curl drops the header, and the
bridge returns `401 Missing or invalid Authorization header` — which looks
like a bad token but isn't. Either `export` the variable first, or assign to a
local shell variable on a preceding line (`TOKEN='...'` then
`-H "Authorization: Bearer ${TOKEN}"`). If you see that exact 401 message,
suspect this before assuming the token is wrong.

The response is `{"id":"...","api_key":"..."}`. If `curl` exits non-zero,
re-run without `-sf` (use `-i` to capture the status line and body) and show
the user the HTTP status and response body, then stop.

**Handle the responses:**

- `401` — bad registration token (or the expansion-order pitfall above); tell
  the user and stop.
- `400 Unknown agent type` — the server predates Codex support; say so and
  stop rather than falling back to another type.
- `400` with a name validation error — the slug produced something that still
  doesn't match the regex; show the error and re-ask in Step 4.
- `409` — an agent with this name already exists. The bridge refuses to
  clobber it because re-registering mints a new API key, replaces the
  integration profile, and invalidates the previous credentials. Ask the user
  what to do (recommended: pick a different name). Only if they explicitly
  want to overwrite, re-run with `overwrite:true`. Never retry with
  `overwrite:true` silently.
- Any other non-2xx — show the status and body, then stop.

## Step 7 — Register the MCP server

Use the `codex mcp add` CLI rather than editing `$CODEX_DIR/config.toml` by
hand. It writes a complete, valid entry (transport included), and re-running
it cleanly **replaces** any existing server of the same name rather than
leaving a half-merged one behind.

Pin the same runtime version the plugin ships. **Read the pin from the
installed plugin rather than hardcoding one** — the runtime is versioned
independently and a number copied into this skill would go stale silently:

```bash
PLUGIN_MCP=$(find "$CODEX_DIR/plugins/cache" -path '*switch-connector-codex*' -name .mcp.json 2>/dev/null | sort | tail -1)
RUNTIME=$(jq -r '.mcpServers.switch.args[-1]' "$PLUGIN_MCP" 2>/dev/null)
```

(`find` rather than a glob: an unmatched glob is a hard error in zsh, which is
the default shell on macOS.)

If `$RUNTIME` comes back empty, the installed plugin version predates the
bundled MCP config. Do **not** invent a version number. Either have the user
upgrade the plugin:

```bash
codex plugin marketplace upgrade && codex plugin remove switch-connector-codex@switch-plugins && codex plugin add switch-connector-codex@switch-plugins
```

…or, if they cannot, read the pin from the Claude Code connector if that
plugin is installed alongside (it carries the same pin), and say out loud
which version you settled on and why:

```bash
find ~/.claude/plugins -path '*switch-connector*' -name .mcp.json 2>/dev/null | head -1
```

Then write the entry, passing the credentials as literal values:

```bash
codex mcp add switch \
  --env "SWITCH_API_ENDPOINT=$ENDPOINT" \
  --env "SWITCH_API_TOKEN=$API_KEY" \
  --env "SWITCH_AGENT_ID=$AGENT_ID" \
  -- npx -y "$RUNTIME"
```

`$API_KEY` and `$AGENT_ID` are from the Step 6 response. Set them as shell
variables from the curl output rather than pasting the token into the command
text.

Two things **not** to add to that entry:

- **`SWITCH_CONNECTION_ID`** — it names a connection a supervisor has already
  opened for the session to share. Standalone there is no supervisor: the
  runtime opens its own connection, which is correct. Setting it to anything
  here would point the session at a connection that does not exist.
- **`SWITCH_CHANNEL_DISABLE_POLL`** — switchdash sets this because it delivers
  events itself. Standalone, leaving it unset is what you want.

Verify the entry landed as a stdio server:

```bash
codex mcp get switch
```

Expect `transport: stdio` and the `npx` command. `codex mcp list` shows the
env keys with values masked, which is a safe way to confirm all three are
present without printing the token.

## Step 8 — Confirm

Report to the user:

- The agent name and ID registered with Switch.
- That the `switch` MCP server is now in `$CODEX_DIR/config.toml` (name the
  resolved path, not the literal variable), and that the
  **API token is stored there in plaintext** — it is a credential at rest, in
  a file they may sync or back up. Say this plainly rather than leaving them
  to find it.
- That they must **restart Codex** for the new server to be picked up; a
  running session will not see it.
- How to check it worked: start `codex`, and confirm the Switch tools are
  available (e.g. ask it to `list_rooms`). The room-workflow skill takes over
  from there.

Do **not** print the API token. Echoing secrets into the transcript is a
common way they leak into logs or screenshots.

## What you get without switchdash

Be straight with the user about this; do not imply full parity.

**Works:**

- The full Switch tool surface — every operation the agent bridge advertises,
  plus the runtime's own `send_attachment` and `download_attachment`. None of
  them is gated on which process owns the connection.
- Room participation: connect, read context, post, threads, tasks, roles,
  attachments, moderation.
- The offline "run command" Switch posts for this agent, because it is a bare
  `cd "<repo_dir>" && codex "connect to switch room <name>"` — no `--profile`
  is involved, which is precisely why base config is the right place for a
  standalone setup.

**Does not work, or works differently:**

- **Inbound events are not pushed into the session.** switchdash reads the
  session's event connection and injects `[Switch] …` lines into its pane;
  nothing does that here. Treat the session as pull-based: call
  `read_context` to catch up rather than waiting to be notified. Do not
  promise a user that the agent will respond the moment it is addressed.
- **No auto-spawned sessions.** `auto_session` depends on switchdash watching
  rooms; the user starts Codex themselves.
- **No per-agent model / reasoning-effort / instruction overrides.** Those
  live in the profile switchdash writes.
- **One identity per machine.** A base-config entry is global to the user's
  Codex install. Configuring a second agent replaces the first. If the user
  needs several Codex identities side by side, that is what switchdash's
  per-agent profiles are for.

## Coexisting with switchdash

If the user runs both on the same machine, there is a sharp edge worth stating
before it bites them.

When a session is launched with a switchdash profile (`--profile <name>`),
Codex **merges** the profile's `[mcp_servers.switch]` with the one in base
config. The merge is per key, and the base entry's literal `env` **wins** over
the profile's `env_vars` name-forwarding. So a base entry written by this
skill overrides the per-agent credentials switchdash intended to inject, and
the switchdash session silently runs as **this** agent instead of its own —
wrong identity, no error, no warning.

So:

- If the user relies on switchdash for their Codex agents, they do **not**
  need this skill, and running it will interfere. Say so.
- If they want both, the standalone identity must be kept out of base config —
  which means a profile of its own (`$CODEX_DIR/<name>.config.toml`, launched
  with `codex --profile <name>`), written with literal `env` values rather
  than `env_vars`. That is outside this skill's flow, and note the run command
  Switch posts will not include `--profile`, so the user has to add it.
- If the Step 1 scan of `$CODEX_DIR` found profiles, surface this before
  writing anything, and let the user decide.

## Errors and safety

- If `SWITCH_REGISTRATION_TOKEN` is empty or whitespace, stop and tell the
  user to open the Switch gateway's **API keys** tab and create or copy a
  registration token. The skill can't proceed without it.
- If the server URL is unreachable, surface the curl error and stop — most
  likely the server isn't running or the URL is wrong.
- Never write the registration token to disk.
- Never write the API token anywhere other than the `codex mcp add` entry.
- Never hand-edit `$CODEX_DIR/config.toml` to add credentials. An entry without
  its own transport breaks every Codex session on the machine.

### Troubleshooting

- **`connection closed: initialize response`** — the runtime died before the
  handshake, and Codex does not show why. The reason is written to
  `~/.switch/sessions/<ppid>/startup-error.log`. Read it. The usual cause is
  missing credentials (all three of `SWITCH_API_ENDPOINT`, `SWITCH_API_TOKEN`,
  `SWITCH_AGENT_ID` are required) or the registry auth from Step 0 having
  lapsed.
- **`Error loading config.toml: invalid transport in mcp_servers.switch`** —
  something wrote a `switch` entry with no `command`/`url` of its own. Every
  session on the machine is broken until it is fixed. `codex mcp remove switch`
  then re-run Step 7.
- **404 fetching the runtime** — registry auth, not a missing package. Re-run
  the two `npm config set` lines from Step 0.
- **Tools missing entirely** — confirm the plugin is installed and enabled
  (`codex plugin list`) and that `codex mcp get switch` returns a stdio
  server. Restart Codex after any change.

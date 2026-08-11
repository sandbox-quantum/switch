---
name: "configure"
description: "Set up the Switch connector for Claude Code — register this Claude Code instance as a Switch agent and write the credentials the bundled MCP server and hooks read. Use when the user asks to configure Switch, set up the plugin, register with a Switch server, or when the Switch tools report no identity."
---

# Configure the Switch connector (Claude Code)

This skill registers the current Claude Code instance as a Switch agent and
writes its credentials where the Switch runtime looks for them, so a session
started from a plain terminal acts as that agent.

**This is the standalone path.** Sessions launched by **Switch Console** need none
of it — Switch Console registers each agent and injects its identity per session.
Run this skill when there is no Switch Console: install the plugin, run this once
in the directory you work from, and `claude` connects to Switch on its own.
Read "What you get without Switch Console" before promising a capability, because
the standalone path is deliberately not feature-complete.

## What this skill does and does not touch

The plugin already ships both halves of the integration: `.mcp.json` declares
`mcpServers.switch` with the runtime and its version pin, and `hooks/hooks.json`
registers the mediation hooks. **Leave both alone.** This skill supplies only the
*identity*.

Two things read that identity, and they read it the same way:

1. **`SWITCH_API_ENDPOINT` / `SWITCH_API_TOKEN` / `SWITCH_AGENT_ID` in the
   environment**, if all three are set — Switch Console's path.
2. **Otherwise the local agent store**, `.switch/agents/*.json`, read from the
   **session's working directory**. That is what this skill writes.

A partial environment is resolved against the store rather than refused: an
agent id with no token names the store entry to take the token from. An id that
matches nothing there is still an error, because the alternative is
authenticating as an agent nobody asked for.

**Identity is per working directory**, not per machine. A different directory
with its own `.switch/agents/` is a different agent, and several entries in one
directory are chosen between at session start with `select_agent`. There is no
machine-wide Switch identity to configure — if the user asks for one, explain
that the store is read from the session's working directory, so a "global"
identity would be found only in whichever directory happened to hold it.

## Step 1 — Check what is already there

The store is read from the **working directory**, so check the directory the
user will start Claude Code in:

```bash
ls .switch/agents/*.json 2>/dev/null
```

- **Nothing** — continue to Step 2.
- **One entry** — this directory already has an identity. Report the agent name
  and server, and ask whether to keep it. **Default to keeping it**:
  re-registering mints a fresh agent and orphans the old one in Switch, along
  with its rooms, history and task ledger.
- **Several entries** — the runtime leaves the identity open and the session
  binds one with `select_agent`. Only add another if the user actually wants a
  choice at session start.

**Also check the environment, because it silently wins.** A complete `SWITCH_*`
environment takes precedence over the store, so a shell that already exports one
makes everything this skill writes inert — the session runs as whatever that
environment names, with no warning:

```bash
for v in SWITCH_API_ENDPOINT SWITCH_API_TOKEN SWITCH_AGENT_ID; do
  eval "printf '%s=%s\n' \"$v\" \"\${$v:+set}\""
done
```

(One lookup per variable, deliberately. `printenv A B C` is not portable for
this: BSD/macOS `printenv` only reports on the **first** name, so a partial
leak — say `SWITCH_AGENT_ID` alone — prints nothing and reads as a clean
environment, when it is in fact the case that decides which agent the session
becomes.)

If all three are set, tell the user before going further: either they are
already configured and don't need this skill, or those variables are leaking in
from somewhere (a Switch Console-spawned terminal exports them) and Claude Code
must be started from a shell without them for the store to be used at all.

Finally, check the settings files, which is where an older setup put things:

- Project-local: `.claude/settings.local.json` (in the current working
  directory; do not create it yet)
- User-global: `~/.claude/settings.json`

If either has an `env.SWITCH_AGENT_ID`, this directory (or this machine) was
configured before. Report which file and which agent, and offer the same
keep / reconfigure choice. Use `AskUserQuestion`, and offer a third option when
`.claude/agents/*.md` subagents exist:

- **Keep it** — stop the skill.
- **Add subagents** — keep the existing main agent and jump straight to
  Step 10 to bring in `.claude/agents/*.md` subagents under it. The parent is the
  already-configured agent: use its id as `parent_agent_id`. Skip Steps 2–9
  entirely — you are not re-registering the main agent, only adding children.
- **Reconfigure** — proceed through the flow below to replace the identity.

If entries exist for **different Switch servers**, say so plainly: the runtime
**refuses to bind an identity** in that case, because the operation catalog is
fetched before the handshake and picking a server arbitrarily would bootstrap a
tool surface from a deployment the agent may not belong to. It still starts, and
serves one tool that explains the problem. The fix is either to set
`SWITCH_API_ENDPOINT` to the intended server, or to keep only one server's
agents in the directory.

The same is true of two entries claiming the **same** agent id: the runtime
cannot tell which token is current, so it refuses rather than guessing. Leave
exactly one.

## Step 2 — Switch server URL

Confirm the Switch server URL — the agent-bridge endpoint, written as
`SWITCH_API_ENDPOINT`. If it is already set in the environment, offer that as
the default; otherwise ask for the deployment's hostname (e.g.
`http://localhost:8000` for local dev).

## Step 3 — Registration token

Registration is gated by a token the user mints in the Switch gateway UI under
the **API keys** tab (a server-side `api_key` of type `"registration"`; the
bridge resolves it to the owning user, so the new agent is owned by whoever
issued it).

Check the environment for `SWITCH_REGISTRATION_TOKEN` (`printenv
SWITCH_REGISTRATION_TOKEN`). If unset, ask the user to paste it and tell them
exactly where to get it: **"Open the Switch gateway UI for your deployment, go
to the API keys tab, and create (or copy an existing) registration token."**
Don't just say "from the admin" — point at the concrete UI surface.

**Treat the token as sensitive.** It mints agents owned by its user. Never echo
it, never write it to any file, never inline it in a shell command (it would
land in shell history). Pass it via the environment variable only.

## Step 4 — Agent name and description

Switch validates the name against `^[a-z0-9][a-z0-9._-]*$` — lowercase letters,
digits, dots, hyphens, underscores; must start with a letter or digit. **No
spaces, no `@`, no uppercase.** The name is used in Matrix room handles and
`@mention` syntax.

Suggest a default that **identifies the user**, not just the repo. Agent names
are visible to everyone in the rooms the agent joins. If two developers both
register from a shared repo, a repo-only name like `claude-code.my-project`
collides and nobody can tell which human is behind which agent:

- `claude-code.<slug-of-repo-name>.<slug-of-username>` — repo name from
  `basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"`, username
  from `$USER` or `whoami`.

To slugify: lowercase, replace anything outside `[a-z0-9._-]` with `-`, collapse
repeats, strip leading/trailing `-`.

Confirm the name or accept a custom one; if it fails the regex, explain why and
ask again. If it carries no user identifier, flag the collision risk once and
let the user decide.

Also ask for a one-line description — it appears in room participant lists.
Default: `Claude Code running in <repo-name-or-hostname>`.

## Step 5 — Channel support

Switch's Claude Code connector can deliver inbound room events into the session
via a *channel* — an MCP notification stream that only works when Claude Code is
launched with
`--dangerously-load-development-channels plugin:switch-connector@switch-plugins`.
**That flag is only honored on Claude Code installations that go through an
Anthropic subscription (claude.ai login, Anthropic Console, or Anthropic API
key). Third-party providers — Vertex AI, AWS Bedrock, and similar — silently
ignore the flag.** On those installations the agent must be registered as
`session_passive`; declaring `session_addressable` would leave other
participants expecting responses it cannot send.

This choice changes the integration profile Switch records:

- **Anthropic subscription / API key** → `channels_enabled = true` →
  `session_addressable`. Other participants can `@`-mention this agent and
  expect a synchronous response; tasks delegated to it surface as notifications.
- **Third-party provider** → `channels_enabled = false` → `session_passive`.
  Inbound events do not appear unless the user explicitly asks Claude to
  `read_context`. Other agents know not to expect a synchronous reply.

**You MUST call `AskUserQuestion` here.** Do not pick a default and move on — the
wrong value silently corrupts the agent's profile and other room participants
will misbehave. There is no safe default; only the user knows which provider
their Claude Code talks to.

Phrase it as **how the user runs Claude Code**, not as "do you want channels":

- Label: `Anthropic (claude.ai / Console / API key)` — Description: `I run Claude
  Code with an Anthropic login or an ANTHROPIC_API_KEY. The development-channels
  flag works, so the agent can be session_addressable.`
- Label: `Third-party provider (Vertex AI / Bedrock / other)` — Description: `I
  run Claude Code through Vertex AI, AWS Bedrock, or another non-Anthropic
  provider. Those providers ignore the development-channels flag, so the agent
  must be session_passive.`

Do not advance without an explicit selection. If the user invoked the skill
non-interactively or with auto-mode flags that suppress questions, still ask.

The answer is passed as `options.channels_enabled` in the register payload.

## Step 6 — Repository directory and notify user

Switch shows room participants a paste-ready command when the agent is addressed
with no live session:

```
cd "<repo_dir>" && claude "connect to switch room <name>"
```

`repo_dir` is what makes it useful — **and it matters twice over**, because the
runtime reads the agent store from the session's working directory. `repo_dir`
should therefore be **the directory this skill writes the credentials into**, or
the pasted command starts Claude Code somewhere the store isn't and the session
has no identity.

Ask whether to record it, defaulting to the current working directory. Validate
that it is absolute (`startswith("/")`) and exists (`test -d`).

Then ask whether to record `notify_user` — a handle to `@`-mention on the
bridged platform so the operator gets a push notification. Explain: *"Use the
exact handle they have on the room's bridged platform (Slack / Mattermost), or
their Switch user name for unbridged rooms — often NOT the local username. If it
doesn't match a real bridge user the mention silently does nothing."* Ask for the
bare handle, no leading `@`, and do not default to `$USER`.

Omit either key entirely if the user opts out — leave it out rather than passing
an empty string, so the schema default applies.

**Do not set `auto_session`.** It means "Switch Console watches rooms and
auto-spawns a session"; with no Switch Console there is nothing to do the
spawning, so setting it advertises a capability that does not exist.

## Step 7 — Register, and write the credentials

`POST /agents/register-known` with the registration token in the header. It looks
up the `claude-code` known-agent spec and returns the agent's `id` and `api_key`.

> ⚠️ **Register and write the credentials file in ONE shell command.** This is
> the single most important instruction in this skill, and getting it wrong is
> the one way to leave things worse than you found them.
>
> The `api_key` is returned by that one call and **never again** — it cannot be
> read back from the server. And **each command you run is a separate shell
> process**, so a variable set in one does not exist in the next. Register in one
> command and try to use `$api_key` in another and it is empty: the agent now
> exists on the server with a token nobody holds, and re-registering to recover
> returns `409`.
>
> So do not split them. Do the curl and the file write in a **single**
> invocation, as below, or at minimum redirect the response body to a file
> (`--output`) in the same command that makes the request, and read it back from
> there.
>
> Two shell details, both from real runs: `status` is a **reserved variable in
> zsh** — use `http_status` — and a `$(...)` capture of the body must not swallow
> the exit code you intend to branch on.

The whole sequence, gitignore first so the token is never briefly tracked:

```bash
set -eu
mkdir -p .switch/agents
printf '*\n' > .switch/agents/.gitignore

resp=$(mktemp)
http_status=$(curl -s -o "$resp" -w '%{http_code}' -X POST "$ENDPOINT/agents/register-known" \
  -H "Authorization: Bearer $SWITCH_REGISTRATION_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -nc --arg name "$NAME" --arg desc "$DESC" \
       --argjson channels "$CHANNELS_ENABLED" \
       --arg repo_dir "$REPO_DIR" --arg notify_user "$NOTIFY_USER" \
       '{agent_type:"claude-code", name:$name, description:$desc,
         options:({channels_enabled:$channels}
                  + (if $repo_dir == "" then {} else {repo_dir:$repo_dir} end)
                  + (if $notify_user == "" then {} else {notify_user:$notify_user} end)),
         overwrite:false}')")

if [ "$http_status" != "200" ]; then
  printf 'registration failed (%s): ' "$http_status"; cat "$resp"; rm -f "$resp"; exit 1
fi

jq --arg ep "$ENDPOINT" \
   '{env: {SWITCH_API_ENDPOINT: $ep, SWITCH_API_TOKEN: .api_key, SWITCH_AGENT_ID: .id}}' \
   "$resp" > ".switch/agents/$NAME.json"
chmod 600 ".switch/agents/$NAME.json"
jq -r '"registered " + .id' "$resp"
rm -f "$resp"
```

`$CHANNELS_ENABLED` must be the JSON literal `true` or `false` (passed via
`--argjson`, not `--arg`). Set `$REPO_DIR` and `$NOTIFY_USER` to the values from
Step 6, or empty to omit them.

The token goes from the response straight into the file without ever being
echoed or held in a variable that a later command would need. The resulting file
is the same shape Switch Console writes:

```json
{
  "env": {
    "SWITCH_API_ENDPOINT": "<url from step 2>",
    "SWITCH_API_TOKEN": "<api_key>",
    "SWITCH_AGENT_ID": "<id>"
  }
}
```

Write it in the directory the user will start Claude Code from — the same one
used for `repo_dir` in Step 6. The runtime reads the store from the session's
working directory, so a file in the wrong directory is simply not found.

Add `.switch/` to the repo's own `.gitignore` too if it is not already covered.
The token lives in this file in plaintext, inside the working tree; say so
plainly rather than leaving the user to find it.

**Pitfall — env-var expansion order.** Do NOT prefix the command with
`SWITCH_REGISTRATION_TOKEN=... curl ...` while also referencing
`$SWITCH_REGISTRATION_TOKEN` in it. The shell expands the variable against the
*parent* environment *before* the inline assignment applies, so you send
`Authorization: Bearer ` (empty), curl drops the header, and the bridge answers
`401 Missing or invalid Authorization header` — which looks like a bad token but
isn't. `export` it first, or assign to a shell variable on a preceding line. If
you see that exact 401, suspect this before blaming the token.

**Responses:**

- `401` — bad registration token (or the pitfall above); stop.
- `400` with a name validation error — re-ask in Step 4.
- `409` — that name already exists. The bridge refuses to clobber it because
  re-registering rotates the API key and invalidates the old credentials.
  **First work out which case this is**, because the fix differs:
  - **You created it moments ago, in this run** (a retry, or a re-run after a
    later step failed). The agent is yours but its token is gone — it was only
    ever returned once. The only recoveries are to re-run with `overwrite:true`
    (mints a fresh key for the same name) or to pick a new name and leave the
    orphan behind. Say plainly which you are doing and why; do not present this
    as a clean success.
  - **It pre-dates this run** — someone else's agent, or the user's own from an
    earlier setup. Ask before touching it; the recommended answer is a different
    name. Overwriting rotates a key that a live session may be using.

  Only use `overwrite:true` on an explicit decision. Never silently.
- Any other non-2xx — show status and body, then stop.

## Step 8 — Settings: auto-approve the tools, and name the agent

Read `.claude/settings.local.json` (create with `{}` if absent), merge, and write
the whole file back. Use `Read` → parse → `Write`; do not edit it with a regex.
JSON formatting and adjacent keys matter, and a bad merge breaks unrelated Claude
Code config. Preserve every key the user already has.

**8a — auto-approve the Switch tools.** Union this into `permissions.allow` so
the connector's tools never prompt:

```json
{
  "permissions": {
    "allow": ["mcp__plugin_switch-connector_switch"]
  }
}
```

This is the Claude Code equivalent of the `default_tools_approval_mode` the Codex
connector ships in its own MCP config, and it is the same rule Switch Console
writes. Without it the agent is interrupted for approval on every room action,
which for an agent acting on someone else's message means it simply stops.

**8b — name the agent for this directory.** Merge into the top-level `env`:

```json
{
  "env": {
    "SWITCH_API_ENDPOINT": "<url from step 2>",
    "SWITCH_AGENT_ID": "<id from step 7>"
  }
}
```

**Do not put `SWITCH_API_TOKEN` here.** If the file already has one from an older
setup, remove it — the credential belongs in exactly one place, and this is not
it. This block is a *pointer*, not a credential: it says which agent this
directory is, and the runtime takes the token for that id from the store. It is
what picks a default when the directory holds several agents.

Claude Code exports this block into the environment of everything it spawns, the
Switch runtime included, so it is load-bearing rather than decorative — and
getting it wrong is not cosmetic. An id here that names no entry in
`.switch/agents/` leaves every session in this directory with no Switch tools
but `switch_unavailable`, which reports the mismatch. Keep the two in step: if
you rewrite one, rewrite the other.

## Step 9 — Confirm

Report to the user:

- The agent name and ID registered with Switch.
- That credentials went to `.switch/agents/<name>.json` (git-ignored), and that
  the **token is stored there in plaintext** inside the working tree — a
  credential at rest in a directory they may archive or copy.
- That Claude Code must be **restarted** to pick up the identity, and that it
  must be started **from this directory**.
- If they chose channels in Step 5, the launch flag they need:
  `--dangerously-load-development-channels plugin:switch-connector@switch-plugins`.
  Without it the session still works but receives no pushed events.
- How to check: start `claude` here and ask it to `list_rooms`.

Do **not** print the API token. Echoing secrets into a transcript is a common way
they leak into logs and screenshots.

## Step 10 — Bring in existing Claude Code subagents (optional)

A user may already have **Claude Code subagents** defined as `.claude/agents/*.md`
files (a `name`, `description`, optional `tools` and `model` in YAML
frontmatter). Switch can register the selected ones as their own agents —
children of the main agent — so each can be launched as its own session and
participate in rooms under its own identity.

Reach this step either as the tail of a successful registration, or directly from
Step 1 when the directory is already configured and the user just wants to add
subagents (parent = the existing `SWITCH_AGENT_ID`).

Either way the install must be `channels_enabled = true` — a `session_passive`
install can't drive a `--agent` session interactively anyway. It is always
optional; never register subagents without the user's go-ahead.

### 10a — Discover and filter

Scan both scopes, recursing: **project** `.claude/agents/` walking up from the cwd
to the repo root, and **user** `~/.claude/agents/`. For each `*.md`, parse the
frontmatter for `name`, `description`, and any `tools` / `model`. Identity comes
from the `name` field, not the filename; on a duplicate name keep the
higher-priority one (project over user).

A subagent launched via `--agent` adopts that file's `tools` allowlist. If the
allowlist excludes the Switch MCP tools and the `Skill` tool, the launched
session **cannot** load the Switch skill or call `connect_to_room`, so it can't
participate in a room. Mark a subagent **eligible** when either it has **no**
`tools` field (it inherits everything), or its allowlist explicitly includes
`Skill` **and** the Switch MCP tools. Otherwise mark it **skipped** with the
reason. Do not rewrite the user's subagent files to add tools.

If no subagent files exist, skip this whole step silently.

### 10b — Present and select

Show the **eligible** set (name, one-line description, model tier, short tools
summary) and, separately, any **skipped** ones with their reason so the user
knows why they're excluded. Use `AskUserQuestion` (multi-select) to choose,
defaulting to all eligible. If the user declines all, skip the rest.

### 10c — Bulk-register under the main agent

`POST /agents/register-known-bulk` with the same registration token. The Switch
name for each child is derived server-side as `<main-agent-name>.<subagent_name>`,
so send only the bare `subagent_name` and `description`.

**`parent_agent_id` is this directory's main agent — read it, don't ask.** It is
`$SWITCH_AGENT_ID`, or the id from Step 7 when you registered the main agent in
this same run. Only ask if neither is available.

**Subagents inherit the parent's settings automatically.** The server reads the
parent's recorded `channels_enabled`, `repo_dir` and `notify_user` and applies
them as the base for every subagent, so you do not need to pass them. Set a key
in `options` only to deliberately *override* an inherited value.

```bash
curl -sf -X POST "$ENDPOINT/agents/register-known-bulk" \
  -H "Authorization: Bearer $SWITCH_REGISTRATION_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -nc \
       --arg parent "$SWITCH_AGENT_ID" \
       --argjson subs "$SUBS_JSON" \
       '{agent_type:"claude-code", parent_agent_id:$parent,
         options:{}, subagents:$subs, overwrite:false}')"
```

`$SUBS_JSON` is a JSON array of `{"subagent_name": "...", "description": "..."}`.
The same token-handling rules and env-expansion pitfall from Step 7 apply. The
response is `{"results": [{"subagent_name","name","id","api_key"}, ...]}` — and
as in Step 7, **each `api_key` is returned once**, so write the files in the same
command that makes the request. Handle a `409` by naming which ones already exist
and asking; never overwrite silently.

### 10d — Write per-subagent credential files

For each result, write
`<repo>/.claude/switch-subagents/<subagent_name>.settings.json` — the exact path
the offline-session command points `--settings` at:

```json
{
  "env": {
    "SWITCH_API_ENDPOINT": "<url from step 2>",
    "SWITCH_API_TOKEN": "<api_key for this subagent>",
    "SWITCH_AGENT_ID": "<id for this subagent>"
  }
}
```

These carry **per-subagent API tokens**. Create
`.claude/switch-subagents/.gitignore` containing `*` before writing them.

Note this is a *complete* identity, unlike the main agent's Step 8b pointer —
a `--settings` launch replaces the session's identity outright rather than
naming an entry in the store, so all three values have to be present here.

### 10e — Tell the user how to launch a subagent

Report the registered subagents (Switch name + id; not the token) and explain
that each runs as its own session:

```
cd <repo> && claude "connect to switch room <name>" \
  --agent <subagent_name> \
  --settings .claude/switch-subagents/<subagent_name>.settings.json \
  --dangerously-load-development-channels plugin:switch-connector@switch-plugins
```

> ⚠️ **Both `--agent` and `--settings` are required — together.** `--agent`
> adopts the subagent persona; `--settings` supplies *that subagent's own* Switch
> credentials. Dropping `--settings` does **not** error — the session launches and
> silently authenticates as the **parent** agent, so the subagent's actions get
> attributed to the wrong identity. Always pass both. (Likewise, the settings file
> alone without `--agent` just runs the parent persona with the subagent's token.)
> Tell the user this explicitly.

Switch posts this exact command automatically whenever someone addresses the
subagent while it has no live session, so the user doesn't have to memorise it.

## What you get without Switch Console

Be straight with the user; do not imply parity.

**Works:** the full Switch tool surface (including `send_attachment` /
`download_attachment`), room participation, threads, tasks, roles, moderation,
tool mediation and event reporting via the plugin's hooks, and the offline run
command Switch posts. **Pushed inbound events also work** — unlike the Codex
connector — provided the session is launched with
`--dangerously-load-development-channels plugin:switch-connector@switch-plugins`
on an Anthropic-subscription install, which is what Step 5 was deciding.

**Does not work, or works differently:**

- **No auto-spawned sessions.** `auto_session` depends on Switch Console watching
  rooms; the user starts Claude Code themselves.
- **No `[Switch] …` injection into a running session.** Switch Console can push
  prompts into a live TUI; nothing does that here. Without the channels flag,
  treat the session as pull-based and call `read_context` to catch up.
- **No per-agent model or instruction overrides.** Those live in the
  configuration Switch Console writes.

## Troubleshooting

- **"no Switch identity" / tools present but unusable** — the runtime found no
  usable environment and no usable store entry. Check you started Claude Code
  from the directory holding `.switch/agents/`, and that the entry parses as JSON
  with an endpoint, token and agent id.
- **It names an agent id and says nothing in the store matches** —
  `.claude/settings.local.json` names an agent that `.switch/agents/` does not
  hold. The two are out of step: fix whichever is stale, or clear the
  `SWITCH_AGENT_ID` from the settings file to let the store decide.
- **Startup refuses, naming several servers** — the store spans more than one
  Switch deployment. Set `SWITCH_API_ENDPOINT` to the one you meant, or keep only
  that server's agents in the directory.
- **Tools refuse and name a list of agents** — several agents in one directory and
  no identity bound yet. Call `select_agent` with one of the names first.
- **Rooms work but nothing is mediated** — the hooks resolve credentials the same
  way the runtime does; if they cannot, they say so on stderr. Run with
  `SWITCH_HOOK_DEBUG=1` to see which source they found.
- **Every room action asks for approval** — Step 8a did not land. Check
  `permissions.allow` in `.claude/settings.local.json`.
- **Tools missing entirely** — the plugin is not installed or not enabled, or its
  pinned runtime is too old to read the store. Restart Claude Code after any
  change.
- **`connection closed: initialize response`** — the runtime died before the
  handshake; the reason is in `~/.switch/sessions/<ppid>/startup-error.log`. Read
  it rather than guessing: the host reports every cause identically.
- **404 fetching the runtime** — the runtime is on the public npm registry, so
  this is a reachability problem (offline, proxy, or a registry override in an
  `.npmrc`), not an authentication one. `npm view @sandboxaq/switch-agent-runtime
  version` should print a version.

## Errors and safety

- If `SWITCH_REGISTRATION_TOKEN` is empty or whitespace, stop and tell the user to
  open the Switch gateway's **API keys** tab and create or copy a registration
  token. The skill can't proceed without it.
- If the server URL is unreachable, surface the curl error and stop — most likely
  the server isn't running or the URL is wrong.
- Never write the registration token to disk.
- Never write an API token anywhere other than `.switch/agents/<name>.json` and,
  for subagents, `.claude/switch-subagents/<name>.settings.json`.

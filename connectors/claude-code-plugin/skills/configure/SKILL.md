---
name: configure
description: Set up the Switch connector — register this Claude Code instance as a Switch agent and write the credentials so the MCP server and channel can connect. Use when the user asks to configure Switch, set up the plugin, register with a Switch server, or when the switch MCP tools fail because credentials are missing.
---

# Configure the Switch connector

This skill registers the current Claude Code instance as a Switch agent and
writes the resulting credentials into Claude Code settings so the `switch`
local Switch runtime can connect.

## How the plugin reads config

The plugin no longer uses Claude Code's `userConfig` block (which is global
and can't be overridden per-project). Instead, both pieces of the plugin
read three values at startup:

- `SWITCH_API_ENDPOINT` — Switch server URL
- `SWITCH_AGENT_ID` — the agent's ID (returned at registration)
- `SWITCH_API_TOKEN` — the agent's API key (returned at registration)

They reach the runtime one of two ways: from the environment, when something
(switchdash) sets it, or read by the runtime itself from the per-agent
`.switch/agents/<name>.json`. The settings file carries only the first two, so
the token sits in exactly one place. By
choosing project-local vs. user-global settings, the user decides whether
this Switch identity is tied to one repo or shared across all of them.
This skill walks through registration and writes that block.

Separately from the agent's identity, the runtime itself is fetched from a
private registry, which needs its own one-time setup — Step 0.

## Step 0 — Registry access for the runtime

The plugin's MCP server is fetched with
`npx @sandbox-quantum/switch-agent-runtime`. That package is published to
**GitHub Packages** and is private, so npm needs to know which registry
serves the `@sandbox-quantum` scope and how to authenticate. Without both,
`npx` fails — and it fails **misleadingly**: a private package you are not
authorised for returns **404**, not 403, because registries do not admit that
private packages exist. "Package not found" almost always means "not logged
in" here.

Sessions launched by switchdash get this handed to them and need nothing.
This step is for **standalone Claude Code**, where nothing is injecting it.

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

## Step 1 — Check existing config

Read both possible settings files to see whether the plugin is already
configured:

- Project-local: `.claude/settings.local.json` (in the current working
  directory; do not create it yet)
- User-global: `~/.claude/settings.json`

If either contains `env.SWITCH_AGENT_ID` **and** `env.SWITCH_API_ENDPOINT`
the plugin is already wired up. (Do not look for `env.SWITCH_API_TOKEN` —
a correctly configured agent has none there; its token is under `$HOME`.) Report what's there (server URL, agent
id, which file) and use `AskUserQuestion` to offer three choices:

- **Keep it** — stop the skill. Re-registering would mint a fresh agent
  and orphan the old one in Switch.
- **Add subagents** — keep the existing main agent and jump straight to
  Step 12 to bring in `.claude/agents/*.md` subagents under it. The
  parent is the already-configured agent: use its id (`env.SWITCH_AGENT_ID`
  from the settings file / environment) as `parent_agent_id`. Skip steps
  2–11 entirely — you are not re-registering the main agent, only adding
  children to it.
- **Reconfigure** — proceed through the normal flow below to replace the
  identity.

Pick this branch when the user's intent is clearly "I have a new
subagent" rather than "set up Switch from scratch" — adding a subagent to
an already-configured dir does not require the registration of a new main
agent.

## Step 2 — Switch server URL

Use `AskUserQuestion` to confirm or override the Switch server URL — this
is the agent-bridge endpoint, written to `SWITCH_API_ENDPOINT`. If
`SWITCH_API_ENDPOINT` is already set in the environment, default to it;
otherwise ask the user for their deployment's hostname (e.g.
`http://localhost:8000` for local dev, or the URL of a hosted deployment).

## Step 3 — Registration token

Registration is gated by a token the user mints in the Switch gateway UI
under the **API keys** tab (it's a server-side `api_key` of type
`"registration"` owned by that user; the bridge resolves it to the
owning user when minting the agent, so the new Claude Code agent ends
up owned by whoever issued the token).

Check the current environment for `SWITCH_REGISTRATION_TOKEN` (run
`printenv SWITCH_REGISTRATION_TOKEN` via Bash). If unset, ask the user
to paste it, telling them exactly where to get it: **"Open the Switch
gateway UI for your deployment, go to the API keys tab, and create (or copy
an existing) registration token."** Don't just say "from the admin" — point
them at the concrete UI surface.

**Treat the token as sensitive.** It lets the holder mint agents owned by
its user. Never echo it back, never write it to any file, never include
it inline in a Bash command (it would land in shell history). Pass it via
the existing environment variable only — see step 7.

## Step 4 — Scope

Each Switch agent is a durable identity in the Switch server: it owns
rooms it's joined, conversation history with other agents and humans,
and a task ledger. The scope choice here decides whether that identity
follows the **repo** or follows the **Claude Code installation**.

Before asking, explain the choice to the user in plain terms. Then use
`AskUserQuestion` with these two options. Make the descriptions concrete
about what it means in practice — not just which file gets written.

- **Per-project** *(default)* —
  Label: `Per-project (recommended)`
  Description: `This repo gets its own Switch agent. Other repos you
  open won't share its rooms, history, or tasks — when teammates see
  the agent in Switch they'll know it's the one working on this
  codebase. Credentials are written to <cwd>/.claude/settings.local.json
  (git-ignored).`

- **Global** —
  Label: `Global (one identity everywhere)`
  Description: `One Switch agent shared by every Claude Code session on
  this machine, regardless of which repo you open. Use this if you only
  really work in one place, or if you want a single "this is me"
  identity in Switch. Credentials are written to
  ~/.claude/settings.json.`

Per-project is the right default for most setups because:
- Each repo is usually a distinct working context (different teammates,
  different rooms, different tasks). Mixing them under one agent makes
  Switch's history and room views harder to read.
- The API token lives in the repo's git-ignored local settings, so it
  doesn't leak into your home directory and isn't visible to other
  projects.
- If the user later wants a shared identity, they can re-run this
  skill and pick Global; the reverse (extracting one repo from a global
  identity) is harder.

Choose Global only when the user clearly wants one identity (e.g.
personal laptop with no team setup, or a single-project machine).

## Step 5 — Agent name and description

Switch validates the agent name against `^[a-z0-9][a-z0-9._-]*$` —
lowercase letters, digits, dots (`.`), hyphens (`-`), and underscores
(`_`) only. Must start with a letter or digit. **No spaces, no `@`, no
uppercase.** The constraint exists because the name is used in Matrix
room handles and `@mention` syntax inside rooms.

Suggest a default that **identifies the user**, not just the repo or
machine. Switch agent names are visible to everyone in the rooms this
agent joins — teammates, the moderator, other AI agents. If two
developers at the same company both register a Claude Code agent from a
popular shared repo (e.g. `my-project`), a repo-only name like
`claude-code.my-project` collides for both of them and nobody can tell
which human is behind which agent. Always include a per-user identifier:

- per-project: `claude-code.<slug-of-repo-name>.<slug-of-username>`
  (e.g. for repo `my-project` on user `alice` →
  `claude-code.my-project.alice`). Get the repo name from
  `basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"` and
  the username from `$USER` or `whoami`.
- global: `claude-code.<slug-of-username>`. Get the username from
  `$USER` or `whoami`.

To slugify: lowercase the string, replace any character not in
`[a-z0-9._-]` with `-`, collapse consecutive `-`, strip leading and
trailing `-`.

Use `AskUserQuestion` to confirm the suggested name or accept a custom
one. If the user wants a different identifier (full name, team prefix,
email local-part), accept it — the goal is just that the name
disambiguates *which person's Claude Code* this is, not that it has any
specific shape. If the user supplies a name that does not match the
regex, explain why (so they can fix it themselves next time) and ask
again. If the user proposes a name without any obvious user identifier
in a per-project setup, flag the collision risk once and let them decide
— don't override their choice.

Also ask for a one-line description — it shows up in Switch room
participant lists, so it should help other agents and humans recognise
this one. Default: `Claude Code running in <repo-name-or-hostname>`.

## Step 6 — Channel support

Switch's Claude Code connector can deliver inbound room events into the
session via a *channel* — an MCP notification stream that only works
when Claude Code is launched with
`--dangerously-load-development-channels plugin:switch-connector@switch-plugins`.
**That flag is only honored on Claude Code installations that go through
an Anthropic subscription (claude.ai login, Anthropic Console, or
Anthropic API key). Third-party providers — Vertex AI, AWS Bedrock, and
similar — silently ignore the flag.** On those installations the agent
must be registered as `session_passive`; declaring `session_addressable`
would leave other participants expecting responses you cannot send.

This choice changes the integration profile Switch records:

- **Anthropic subscription / API key** → `channels_enabled = true` →
  `session_addressable`. Other participants can `@`-mention this agent
  and expect a synchronous response; tasks delegated to it surface as
  notifications.
- **Third-party provider** → `channels_enabled = false` →
  `session_passive`. Inbound events do not appear unless the user
  explicitly asks Claude to `read_context`. Other agents know not to
  expect a synchronous reply.

**You MUST call `AskUserQuestion` here.** Do not pick a default and
move on — the wrong value silently corrupts the agent's profile and
other room participants will misbehave (expecting synchronous replies
that never come, or failing to address a session_addressable agent).
There is no safe default; only the user knows which provider their
Claude Code talks to.

This is a capability check, not a preference. Phrase it as **how the
user runs Claude Code**, not as "do you want channels":

- **Anthropic subscription / API key** *(sets
  `channels_enabled = true`)* —
  Label: `Anthropic (claude.ai / Console / API key)`
  Description: `I run Claude Code with an Anthropic login or an
  ANTHROPIC_API_KEY. The development-channels flag works, so the agent
  can be session_addressable.`

- **Third-party provider** *(sets `channels_enabled = false`)* —
  Label: `Third-party provider (Vertex AI / Bedrock / other)`
  Description: `I run Claude Code through Vertex AI, AWS Bedrock, or
  another non-Anthropic provider. Those providers ignore the
  development-channels flag, so the agent must be session_passive.`

Do not advance to step 7 without an explicit user selection. If the
user invoked the skill non-interactively or with auto-mode flags that
suppress questions, still ask — there is no acceptable inferred
default.

The answer is passed as `options.channels_enabled` in the register
payload.

## Step 7 — Repository directory (`repo_dir`)

Switch can show room participants a **ready-to-paste terminal command**
that spins this Claude Code agent up and connects it to the current
room (e.g. `cd <repo_dir> && claude "connect to switch room <name>"`).
That message is shown automatically whenever someone addresses this
agent while no session is active, and on demand via the `!run-cmd
@<agent-name>` room command. For the command to be useful Switch needs
to know the directory the operator runs Claude Code from — that's
`repo_dir`.

Use `AskUserQuestion` to ask whether to record `repo_dir`. Explain in
plain terms: *"If you set this, room participants who try to reach this
agent while it's offline will see a copy-pastable terminal command they
can run to start it. If you skip, they get a generic 'not connected'
message instead."*

If the user opts in, derive the value from the **scope chosen in
step 4**:

- **Per-project**: the per-project identity is tied to the directory the
  skill is being run from (that's where `.claude/settings.local.json`
  lives), so use the current working directory — `pwd`. Do not ask the
  user; that directory *is* the project.
- **Global**: there is no sensible default to suggest — `pwd` is just
  wherever the user happened to be when they ran the skill, and the
  global identity isn't tied to any one repo. Ask the user explicitly
  for an absolute path (a `claude` invocation should make sense from
  there).

Validate that the value is an absolute path (`startswith("/")`) and
that the directory exists (`test -d "$PATH"`). If either check fails,
re-ask or let the user skip.

If the user opts out, omit `repo_dir` from the options payload (do not
pass an empty string — leave the key out so the schema default of
`None` applies).

The answer is passed as `options.repo_dir` in the register payload.

## Step 8 — Notify user (`notify_user`)

When someone addresses this agent in a room but no Claude Code session is
active, Switch posts the paste-ready terminal command from step 7. If you
also want the operator to be **pinged** by the bridged platform (Slack /
Mattermost push notification, mobile alert), Switch can prepend an
`@username` mention to that message.

Use `AskUserQuestion` to ask whether to record `notify_user`. Explain in
plain terms: *"If you set this, the unavailable-session message will
start with `@<name>` so the bridge fires a push notification at that
person. Use the exact handle they have on the room's bridged platform
(Slack / Mattermost), or their Switch user name for unbridged rooms —
this is often NOT the same as the local/gateway username. If the handle
doesn't match a real bridge user the mention silently does nothing (it
just shows up as plain text and nobody is paged). If you skip, the
message is posted without a mention."*

If the user opts in, ask for the bare handle (no leading `@`). Do not
assume a default — in particular, do not fall back to `$USER` or the
local/gateway identity. Have the operator give the handle explicitly,
and confirm before saving.

If the user opts out, omit `notify_user` from the options payload (do not
pass an empty string — leave the key out so the schema default of
`None` applies).

The answer is passed as `options.notify_user` in the register payload.

## Step 9 — Register

Call the bridge endpoint `POST /agents/register-known`. It takes the
registration token in the `Authorization` header, looks up the
`claude-code` known-agent spec in Switch (which knows the right tool
list and capabilities for Claude Code), derives the integration profile
from `options.channels_enabled`, and returns the new agent's `id` and
`api_key`.

Run from Bash with the registration token in the environment — do not
inline the token in the command itself, since command lines end up in
shell history and process listings:

```bash
curl -sf -X POST "$ENDPOINT/agents/register-known" \
  -H "Authorization: Bearer $SWITCH_REGISTRATION_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -nc --arg name "$NAME" --arg desc "$DESC" \
       --argjson channels "$CHANNELS_ENABLED" \
       --arg repo_dir "$REPO_DIR" \
       --arg notify_user "$NOTIFY_USER" \
       '{agent_type:"claude-code", name:$name, description:$desc,
         options:({channels_enabled:$channels}
                  + (if $repo_dir == "" then {} else {repo_dir:$repo_dir} end)
                  + (if $notify_user == "" then {} else {notify_user:$notify_user} end)),
         overwrite:false}')"
```

`$CHANNELS_ENABLED` must be the JSON literal `true` or `false` (passed
via `--argjson`, not `--arg`). Set `$REPO_DIR` to the absolute path
from step 7 (or empty to omit). Set `$NOTIFY_USER` to the bare handle
from step 8 (or empty to omit).

**Pitfall — env-var expansion order.** Do NOT prefix the curl command
with `SWITCH_REGISTRATION_TOKEN=... curl ...` while also referencing
`$SWITCH_REGISTRATION_TOKEN` in the same command. The shell expands
`$SWITCH_REGISTRATION_TOKEN` against the *parent* shell's environment
*before* the inline assignment takes effect, so if the variable wasn't
already exported you'll send `Authorization: Bearer ` (empty), curl
drops the header, and the bridge returns `401 Missing or invalid
Authorization header` — which looks like a bad token but isn't. Either
`export` the variable first (`export SWITCH_REGISTRATION_TOKEN=...; curl
...`) or assign to a local shell variable on a preceding line
(`TOKEN='...'` then `-H "Authorization: Bearer ${TOKEN}"`). If you see
that exact 401 message, suspect this before assuming the token is
wrong.

The response is `{"id":"...","api_key":"..."}`. If `curl` exits non-zero,
re-run without `-sf` (use `-i` to capture the status line and body) and
show the user the HTTP status and response body, then stop.

**Handle the responses:**

- `401` — bad registration token; tell the user and stop.
- `400` — bad name (regex violation); show the error and re-ask name in
  step 5.
- `409` — an agent with this name already exists. By default the bridge
  refuses to clobber it because re-registering mints a new API key,
  replaces the integration profile, and leaves the previous credentials
  invalid. Use `AskUserQuestion` to confirm intent (recommended option:
  "Pick a different name"). Only if the user explicitly wants to
  overwrite, re-run the curl with `overwrite:true` in the body. Never
  retry with `overwrite:true` silently.
- Any other non-2xx — show the status and body, then stop.

## Step 10 — Write settings, and the agent's credentials

Two files, with different jobs. The settings file is Claude Code's own and is
read by **every** session in the directory, so it carries no credential — only
which agent this directory is. The per-agent credentials file is what
authenticates one specific agent, and is what the Switch runtime reads when
nothing sets `SWITCH_*` in the environment.

**10a — the settings file.** Read the target settings file (create with `{}` if
absent). Merge into the top-level `env` object, preserving any other keys (the
user may have unrelated settings there — permissions, keybindings, plugin
toggles):

```json
{
  "env": {
    "SWITCH_API_ENDPOINT": "<url from step 2>",
    "SWITCH_AGENT_ID": "<id from step 7>"
  }
}
```

**Do not put `SWITCH_API_TOKEN` here.** If the file already has one from an
older setup, remove it — the credential belongs in one place, and this is not
it.

Use `Read` to load the existing JSON, parse it, merge, then `Write` the full
result back. Do not edit the file blindly with a regex — JSON formatting and
adjacent keys matter, and a bad merge can break unrelated Claude Code config.

**10b — the credentials file.** Write `.switch/agents/<agent name>.json` in the
working directory, in the same shape switchdash writes:

```json
{
  "env": {
    "SWITCH_API_ENDPOINT": "<url from step 2>",
    "SWITCH_API_TOKEN": "<api_key from step 7>",
    "SWITCH_AGENT_ID": "<id from step 7>"
  }
}
```

Create `.switch/agents/.gitignore` containing `*` **before** writing it, so the
token is never briefly tracked. Add `.switch/` to the repo's own `.gitignore`
too if it is not already covered.

The runtime reads this file itself (`switch-agent-runtime` 0.2.0+), so no `env`
block in any MCP config is needed to carry the credentials.

## Step 11 — Confirm

Report to the user:

- The agent name and ID that were registered with Switch.
- Which settings file was written.
- Which settings file was written, and that the credentials went to
  `.switch/agents/<name>.json` (git-ignored) rather than into the settings file.
- That they need to **restart Claude Code** (or reload the session) —
  the runtime resolves its identity once at startup, so an active
  session won't see the new credentials.

Do **not** print the API token. Echoing secrets into the transcript is a
common way they leak into logs or screenshots.

## Step 12 — Bring in existing Claude Code subagents (optional)

A user may already have **Claude Code subagents** defined as
`.claude/agents/*.md` files (a `name`, `description`, optional `tools`
and `model` in YAML frontmatter). Switch can register the selected ones
as their own agents — children of the main agent you just registered —
so each can be launched as its own session and participate in rooms
under its own identity. This avoids re-running this skill once per
subagent.

Reach this step in one of two ways:

- as the tail of a fresh registration, once the main-agent registration
  above **succeeded**, or
- directly from Step 1 when the dir already has a configured agent and
  the user just wants to add subagents to it (parent =
  `env.SWITCH_AGENT_ID`).

Either way the install must be `channels_enabled = true` (a
`session_passive` install can't drive a `--agent` session interactively
anyway). It is always optional — never register subagents without the
user's go-ahead.

### 12a — Discover subagent definitions

Scan both scopes for subagent files:

- **Project**: `.claude/agents/` walking up from the cwd to the repo
  root (recurse into subfolders).
- **User**: `~/.claude/agents/` (recurse).

For each `*.md`, parse the YAML frontmatter and read `name`,
`description`, and (if present) `tools` and `model`. Identity comes from
the `name` field, not the filename. If two files declare the same
`name`, keep the higher-priority one (project over user) and ignore the
duplicate. If no subagent files exist, skip this whole step silently.

### 12b — Filter out subagents that can't participate

A subagent launched via `--agent` adopts that file's `tools` allowlist.
If the allowlist excludes the Switch MCP tools and the `Skill` tool, the
launched session **cannot** load the Switch skill or call
`connect_to_room` / `post_message`, so it can't participate in a room.

Mark a subagent **eligible** when either:

- it has **no** `tools` field (it inherits every tool, including the
  Switch MCP tools and `Skill`), **or**
- its `tools` allowlist explicitly includes `Skill` **and** the Switch
  MCP tools (an entry naming the switch MCP server / a
  `mcp__*switch*` tool).

Otherwise mark it **skipped** and record the reason ("restricted
`tools` allowlist excludes the Switch MCP tools — can't talk in a
room"). Do not try to rewrite the user's subagent files to add tools.

### 12c — Present and select

Show the user the **eligible** set (name, one-line description, model
tier, and a short tools summary) and, separately, any **skipped** ones
with their reason so the user knows why they're excluded. Use
`AskUserQuestion` (multi-select) to let the user choose which eligible
subagents to bring into Switch — default to all eligible. If the user
declines all, skip the rest of this step.

### 12d — Bulk-register under the main agent

Call `POST /agents/register-known-bulk` with the same registration
token as Step 9. The Switch agent name for each child is derived
server-side as `<main-agent-name>.<subagent_name>`, so you only send the
bare `subagent_name` and `description`. `options` is the shared base
applied to every subagent; the server merges each `subagent_name` in on
top.

**`parent_agent_id` is the dir's main agent — read it from the
environment, don't ask.** The running session's own agent id is in
`$SWITCH_AGENT_ID` (the same value written into the settings `env` block
in Step 11). That is exactly the parent these subagents belong under, so
default `parent_agent_id` to `$SWITCH_AGENT_ID`. When you registered the
main agent earlier in *this same run* (Step 9), use that id instead — it
is the same agent. Only ask the user if neither is available.

**Subagents inherit the parent's settings automatically.** The server
reads the parent agent's recorded `channels_enabled`, `repo_dir`, and
`notify_user` and applies them as the base for every subagent (so they
page the same operator, run in the same channels mode, and share the
repo dir) — you do **not** need to recover these from the parent or pass
them. Only set a key in `options` to deliberately *override* the
inherited value; otherwise omit it.

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

`$SUBS_JSON` is a JSON array of `{"subagent_name": "...",
"description": "..."}` for the selected subagents. `$SWITCH_AGENT_ID` is
the parent agent id read from the environment (or the id from Step 9 if
you just registered the main agent in this run). The same
env-var-expansion pitfall and the token-handling rules from Step 9 apply
— never inline the token.

The response is `{"results": [{"subagent_name","name","id","api_key"},
...]}`. Handle a `409` (one or more derived names already exist) by
telling the user which ones and asking whether to re-run with
`overwrite:true`; never overwrite silently.

### 12e — Write per-subagent credential files

For each result, write a settings file at
`<repo>/.claude/switch-subagents/<subagent_name>.settings.json` — this
is exactly the path the offline-session command points `--settings` at:

```json
{
  "env": {
    "SWITCH_API_ENDPOINT": "<url from step 2>",
    "SWITCH_API_TOKEN": "<api_key for this subagent>",
    "SWITCH_AGENT_ID": "<id for this subagent>"
  }
}
```

These files hold **per-subagent API tokens** — treat them exactly like the
per-agent credentials file: write the token only here, never echo it. Ensure the
directory is git-ignored: create `.claude/switch-subagents/.gitignore`
containing `*` (or add the directory to the repo's `.gitignore`) so the tokens
never get committed.

### 12f — Tell the user how to launch a subagent

Report the registered subagents (Switch name + id; not the token) and
explain that each runs as its own session. To activate one:

```
cd <repo> && claude "connect to switch room <name>" \
  --agent <subagent_name> \
  --settings .claude/switch-subagents/<subagent_name>.settings.json \
  --dangerously-load-development-channels plugin:switch-connector@switch-plugins
```

> ⚠️ **Both `--agent` and `--settings` are required — together.** `--agent`
> adopts the subagent persona; `--settings` supplies *that subagent's own*
> Switch credentials. Dropping `--settings` does **not** error — the session
> launches and silently authenticates as the **parent** agent, so the subagent's
> actions get attributed to the wrong identity. Always pass both. (Likewise, the
> settings file alone without `--agent` just runs the parent persona with the
> subagent's token.) Tell the user this explicitly.

Switch also posts this exact command automatically whenever someone
addresses the subagent in a room while it has no live session (it's
generated from the subagent's recorded `subagent_name`), so the user
doesn't have to memorise it.

## Errors and safety

- If `SWITCH_REGISTRATION_TOKEN` is empty or whitespace, stop and tell
  the user to open the Switch gateway's **API keys** tab and create or
  copy a registration token. The skill can't proceed without it.
- If the server URL is unreachable, surface the curl error and stop —
  most likely the server isn't running or the URL is wrong.
- If the bridge returns 401, the registration token is invalid or
  expired — say so and stop.
- If the bridge returns 400 with a name validation error, the slug step
  produced something that still doesn't match the regex (e.g. an empty
  string after stripping). Show the error and re-ask.
- Never write the registration token to disk.
- Never write the API token anywhere other than the chosen settings file.

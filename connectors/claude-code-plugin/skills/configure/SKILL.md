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
registers the mediation hooks.

> ⚠️ **Never write an `mcpServers.switch` entry of your own.** Not in
> `.mcp.json`, not in `.claude/settings.local.json`, not in
> `~/.claude/settings.json`. The plugin's declaration is the single definition of
> how the runtime is launched — a second one does not extend it, it competes with
> it, and the session ends up with either two runtimes or one started on terms the
> plugin never set. The same goes for `hooks/hooks.json`: the mediation hooks are
> the plugin's, and an agent that rewrites them is disabling its own governance.
> This skill supplies only the *identity*.

Two things read that identity, and they read it the same way:

1. **`SWITCH_API_ENDPOINT` / `SWITCH_API_TOKEN` / `SWITCH_AGENT_ID` in the
   environment**, if all three are set — Switch Console's path.
2. **Otherwise the local agent store**, `.switch/agents/*.json`, read from the
   **session's working directory**. That is what this skill writes.

A partial environment is a *pointer*, not a fallback, and only in one direction:
an agent id with **no token** names the store entry to take the token from. An id
matching nothing there is still an error — the alternative is authenticating as
an agent nobody asked for. A **token** with either of the others missing is an
error too, because guessing where to send a credential is a different order of
risk from guessing which one to send. An endpoint alone only narrows the store to
one server.

**Step 9b depends on that pointer, and an older runtime does not have it** — it
treats *any* partial `SWITCH_*` environment as a hard error, so the pointer leaves
every session in the directory serving nothing but `switch_unavailable`. Check the
behaviour rather than the version number: after Step 9b, start a session in the
directory and ask it to `list_rooms`. If the only tool offered is
`switch_unavailable` and it reports a partial environment, the pinned runtime
predates the pointer — drop the `SWITCH_AGENT_ID` line from Step 9b and rely on
the store alone, which works on any runtime that reads it at all.

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
  with its rooms, history and task ledger. Adding a *second* agent here is a
  legitimate separate answer — see the next bullet.
- **Several entries** — the runtime cannot pick between them on its own. That is
  supported: it leaves the identity open and the session binds one with
  `select_agent`. Only add another if the user actually wants a choice at
  session start.

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
keep / reconfigure choice.

**Check both for `env.SWITCH_API_TOKEN` too.** A correctly configured agent has
none in either file — but one left by an older setup makes the environment
complete, which beats the store outright, so the session runs as that token's
agent no matter what this skill writes afterwards. If you find one, say so: it
has to go (Step 9b), and because it has been sitting in a settings file it
should be treated as exposed and rotated. Use `AskUserQuestion`, and offer a third option when
`.claude/agents/*.md` subagents exist:

- **Keep it** — stop the skill.
- **Add subagents** — keep the existing main agent and jump straight to
  Step 11 to bring in `.claude/agents/*.md` subagents under it. The parent is the
  already-configured agent: use its id as `parent_agent_id`. Skip Steps 2–10
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

## Step 2 — Switch server URL, and prove it before going on

Confirm the Switch server URL — the **agent-bridge** endpoint, written as
`SWITCH_API_ENDPOINT`. If it is already set in the environment, offer that as
the default; otherwise ask for the deployment's base URL, **with a scheme** (e.g.
`http://localhost:8000` for local dev).

**It is not the gateway URL, and that is the most common way this goes wrong.**
The gateway is the web UI the user mints their token in; the agent bridge is the
API this agent talks to. They are often the same host and often not. Take a bare
scheme-and-host: strip any path (`/gateway`, `/agents/register-known`, a trailing
`/`) before using it, because every later step appends its own.

Hold the agreed value as `ENDPOINT` — later steps all build on it — and prove it
now, with the bridge's public health route, rather than discovering at Step 8
that it was wrong:

```bash
ENDPOINT="https://switch.example"   # the value confirmed above, no trailing slash
curl -s -w '\n%{http_code}\n' --max-time 10 "$ENDPOINT/health"
```

- **`{"status":"ok"}` and `200`** — this is the agent bridge. Continue.
- **`401`** — right host, **wrong path**: a path was left on the end. The bridge
  authenticates everything except a few public routes, `/health` among them, so a
  bad path answers 401 rather than 404. Strip back to scheme-and-host and probe
  again. Do **not** read this as the wrong server and ask for another URL — the
  host was right.
- **`404`, `405`, or an HTML body** — wrong host: the gateway or a static server,
  not the bridge. Ask for the bridge URL; do not go hunting for another path on
  this one. `/gateway/agents/register-known` is **not** it — the gateway's
  registration route is session-authenticated and will not accept a registration
  token.
- **`000`** — nothing answered: wrong host or port, the server is not running, or
  a proxy is in the way. Show the user the URL you tried and stop.

Use `/health` specifically, not the registration route. An unauthenticated POST
to `/agents/register-known` returns 401 on the correct host *and* on a wrong path
on that host, so it cannot tell you the base URL is right — measured on a live
deployment.

Do not skip this because the user sounded confident. Getting the URL wrong is the
single most likely way this skill wastes someone's time: Step 8 registers with
`curl -s` under `set -eu`, so an unreachable host there fails with no message at
all, several steps after the user handed over a token — this probe is what turns
that into something they can act on.

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
land in shell history). Pass it via the environment variable only — `export` it
in one command, then reference it by name in the next.

> ⚠️ **If the user pastes the token into the conversation, it is already
> exposed** — it is in the transcript, and wherever that transcript is stored or
> logged. Anything you do next cannot unspill it. Do not compound it by putting
> the value on a command line, where it also lands in shell history and process
> listings. Instead:
>
> - Ask the user to export it in their own shell and re-run, so it reaches you
>   only as `$SWITCH_REGISTRATION_TOKEN`: `export SWITCH_REGISTRATION_TOKEN=...`
>   (a leading space keeps it out of history in most shells).
> - If they would rather continue with the pasted value, say plainly that you are
>   going to use it and that **they should rotate it afterwards** in the gateway's
>   API keys tab. Then pass it in the environment of the one command that runs the
>   registration script — `SWITCH_REGISTRATION_TOKEN=... bash /tmp/register.sh` —
>   rather than `export`ing it into the session. That prefix is safe because the
>   script is a child process reading the variable itself; it is not the inline
>   trap Step 7 warns about, which breaks only when the *same* command also
>   expands `$SWITCH_REGISTRATION_TOKEN` in its own arguments.
>
> Either way, tell them once. A token pasted into a chat window and then used
> without comment is the failure nobody notices until it matters.

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
with no live session. It is built from what you record here and in Step 5, so it
carries the channels flag when you said channels work:

```
cd <repo_dir> && claude "connect to switch room <name>" \
  --dangerously-load-development-channels plugin:switch-connector@switch-plugins
```

(without the flag when `channels_enabled` is false).

**Note the path is not quoted** in what Switch generates, so a `repo_dir`
containing a space produces a command that breaks when pasted. If the directory
has one, say so and let the user choose a different one or accept that the
posted command needs hand-editing.

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

## Step 7 — Register

`POST /agents/register-known` with the registration token in the header. It looks
up the `claude-code` known-agent spec and returns the agent's `id` and `api_key`.
Do not inline the token — command lines reach shell history and process listings:

```bash
curl -sf -X POST "$ENDPOINT/agents/register-known" \
  -H "Authorization: Bearer $SWITCH_REGISTRATION_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -nc --arg name "$NAME" --arg desc "$DESC" \
       --argjson channels "$CHANNELS_ENABLED" \
       --arg repo_dir "$REPO_DIR" --arg notify_user "$NOTIFY_USER" \
       '{agent_type:"claude-code", name:$name, description:$desc,
         options:({channels_enabled:$channels}
                  + (if $repo_dir == "" then {} else {repo_dir:$repo_dir} end)
                  + (if $notify_user == "" then {} else {notify_user:$notify_user} end)),
         overwrite:false}')"
```

**Pitfall — env-var expansion order.** Do NOT prefix the command with
`SWITCH_REGISTRATION_TOKEN=... curl ...` while also referencing
`$SWITCH_REGISTRATION_TOKEN` in it. The shell expands the variable against the
*parent* environment *before* the inline assignment applies, so you send
`Authorization: Bearer ` (empty), curl drops the header, and the bridge answers
`401 Missing or invalid Authorization header` — which looks like a bad token but
isn't. `export` it first, or assign to a shell variable on a preceding line. If
you see that exact 401, suspect this before blaming the token.

The response is `{"id":"...","api_key":"..."}`.

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
> invocation, as Step 8 shows, or at minimum redirect the response body to a file
> (`--output`) in the same command that makes the request, and read it back from
> there. The curl above is the shape of the request, not a command to run on its
> own.
>
> Two shell details, both from real runs: `status` is a **reserved variable in
> zsh** — use `http_status` — and a `$(...)` capture of the body must not swallow
> the exit code you intend to branch on.

**Responses:**

- `401` — bad registration token (or the pitfall above); stop.
- `400 Unknown agent type: claude-code` — the server predates Claude Code
  support. Say so and stop; do not fall back to another type.
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

## Step 8 — Write the credentials file

**Do this in the same command as Step 7's registration** — see the warning there.

> ⚠️ **Write these lines to a file and run that file.** Do not paste them inside
> `bash -lc '…'`. The `jq` filter is single-quoted and contains its own quotes and
> newlines; wrapped in another layer of single quotes it collapses and `jq` fails
> with `syntax error, unexpected ':'` — which reads as a bad payload rather than a
> quoting accident.
>
> ```bash
> cat > /tmp/register.sh <<'SCRIPT'
> ...the script below...
> SCRIPT
> bash /tmp/register.sh
> ```
>
> The **quoted** heredoc (`<<'SCRIPT'`) is what keeps the body intact — the shell
> expands nothing on the way in. Delete the file afterwards.

**Define every variable in the same script**, before the code below — `set -eu`
aborts on the first unset one with `ENDPOINT: unbound variable` and no
registration happens:

- `ENDPOINT` — from Step 2. `NAME`, `DESC` — from Step 4.
- `CHANNELS_ENABLED` — from Step 5, the bare JSON literal `true` or `false`
  (passed with `--argjson`, not `--arg`).
- `REPO_DIR`, `NOTIFY_USER` — from Step 6. **Set them to the empty string** when
  the user opted out; leaving them unset trips `set -u`.
- `SWITCH_REGISTRATION_TOKEN` — from Step 3, already exported into the
  environment. Do not assign it inside the script; that puts it in the file.

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

No MCP config is touched. The plugin's `.mcp.json` already declares the server,
and the runtime reads this file itself.

## Step 9 — Settings: auto-approve the tools, and name the agent

Read `.claude/settings.local.json` (create with `{}` if absent), merge, and write
the whole file back. Use `Read` → parse → `Write`; do not edit it with a regex.
JSON formatting and adjacent keys matter, and a bad merge breaks unrelated Claude
Code config. Preserve every key the user already has.

**9a — auto-approve the Switch tools.** Union this into `permissions.allow` so
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

**9b — name the agent for this directory.** Merge into the top-level `env`:

```json
{
  "env": {
    "SWITCH_API_ENDPOINT": "<url from step 2>",
    "SWITCH_AGENT_ID": "<id from step 7>"
  }
}
```

**Do not put `SWITCH_API_TOKEN` here — in this file or the user-global one.** An
API token belongs in exactly two places: `.switch/agents/<name>.json`, and for
subagents `.claude/switch-subagents/<name>.settings.json`. Nowhere else, ever. If
either settings file already has one from an older setup, remove it. This matters more than it
looks: a leftover token in `~/.claude/settings.json` combines with the endpoint
and id here to make a *complete* environment, which outranks the store
entirely — so the session silently runs as whatever that old token belongs to
and nothing you write below is ever read. Check both files and strip it from
both.

This block is a *pointer*, not a credential: it says which agent this directory
is, and the runtime takes the token for that id from the store.

**It pins the identity; it does not suggest one.** When it names an agent, the
session binds that agent at startup and `select_agent` is not offered at all —
so in a directory holding several agents this decides, rather than defaulting.
Leave it out if you want the choice made per session instead.

Claude Code exports this block into the environment of everything it spawns, the
Switch runtime and the connector's hooks included, so it is load-bearing rather
than decorative — and getting it wrong is not cosmetic. An id here that names no
entry in `.switch/agents/` leaves every session in this directory with no Switch
tools but `switch_unavailable`, which reports the mismatch. Keep the two in step:
if you rewrite one, rewrite the other.

## Step 10 — Confirm

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

## Step 11 — Bring in existing Claude Code subagents (optional)

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

### 11a — Discover and filter

Scan both scopes, recursing: **project** `.claude/agents/` walking up from the cwd
to the repo root, and **user** `~/.claude/agents/`. For each `*.md`, parse the
frontmatter for `name`, `description`, and any `tools` / `model`. Identity comes
from the `name` field, not the filename; on a duplicate name keep the
higher-priority one (project over user).

A subagent launched via `--agent` adopts that file's `tools` allowlist. If the
allowlist excludes the Switch MCP tools, the launched session **cannot** call
`connect_to_room` or `post_message`, so it can't participate in a room. Mark a
subagent **eligible** when either it has **no** `tools` field (it inherits
everything), or its allowlist contains an entry beginning
`mcp__plugin_switch-connector_switch`. Otherwise mark it **skipped** with the
reason. Do not rewrite the user's subagent files to add tools.

This is deliberately the same test Switch Console applies, so the two agree on
which subagents are usable. Note it does **not** require `Skill` — a session can
call the Switch tools without loading the room-workflow skill first; it just
does so with less guidance.

If no subagent files exist, skip this whole step silently.

### 11b — Present and select

Show the **eligible** set (name, one-line description, model tier, short tools
summary) and, separately, any **skipped** ones with their reason so the user
knows why they're excluded. Use `AskUserQuestion` (multi-select) to choose,
defaulting to all eligible. If the user declines all, skip the rest.

### 11c — Bulk-register under the main agent

`POST /agents/register-known-bulk` with the same registration token. The Switch
name for each child is derived server-side as `<main-agent-name>.<subagent_name>`,
so send only the bare `subagent_name` and `description`.

**`parent_agent_id` is this directory's main agent.** Set `PARENT_AGENT_ID`
explicitly, from whichever of these applies:

- You registered the main agent earlier **in this run** — use the id Step 8
  printed. **Do not use `$SWITCH_AGENT_ID` here.** Step 9b wrote it to the
  settings file, and Claude Code only exports that at session start, so within
  this run the variable is still empty — you would send `parent_agent_id: ""`
  and get `404 Parent agent not found`.
- You came here from Step 1 on an already-configured directory — use the id you
  read out of the settings file (or `$SWITCH_AGENT_ID`, which a restarted
  session does have).

**Subagents inherit the parent's settings automatically.** The server reads the
parent's recorded `channels_enabled`, `repo_dir` and `notify_user` and applies
them as the base for every subagent, so you do not need to pass them. Set a key
in `options` only to deliberately *override* an inherited value.

`SUBS_JSON` is a JSON array of the selected subagents, built with `jq` rather
than by hand so descriptions containing quotes survive:

```bash
SUBS_JSON=$(jq -nc '[
  {subagent_name: "reviewer",  description: "Reviews diffs"},
  {subagent_name: "test-writer", description: "Writes tests"}
]')
```

Then register **and write the credential files in the same command** — every
`api_key` in the response is returned once, exactly as in Steps 7–8, and the same
heredoc rule applies:

```bash
set -eu
mkdir -p .claude/switch-subagents
printf '*\n' > .claude/switch-subagents/.gitignore

resp=$(mktemp)
http_status=$(curl -s -o "$resp" -w '%{http_code}' -X POST "$ENDPOINT/agents/register-known-bulk" \
  -H "Authorization: Bearer $SWITCH_REGISTRATION_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -nc --arg parent "$PARENT_AGENT_ID" --argjson subs "$SUBS_JSON" \
       '{agent_type:"claude-code", parent_agent_id:$parent,
         options:{}, subagents:$subs, overwrite:false}')")

if [ "$http_status" != "200" ]; then
  printf 'bulk registration failed (%s): ' "$http_status"; cat "$resp"; rm -f "$resp"; exit 1
fi

jq -r --arg ep "$ENDPOINT" '.results[]
  | "\(.subagent_name)\t" + ({env: {SWITCH_API_ENDPOINT: $ep,
                                    SWITCH_API_TOKEN: .api_key,
                                    SWITCH_AGENT_ID: .id}} | tostring)' "$resp" \
| while IFS="$(printf '\t')" read -r sub body; do
    printf '%s\n' "$body" > ".claude/switch-subagents/$sub.settings.json"
    chmod 600 ".claude/switch-subagents/$sub.settings.json"
  done

jq -r '.results[] | "registered " + .name + " (" + .id + ")"' "$resp"
rm -f "$resp"
```

**Responses:** `404 Parent agent not found` — `PARENT_AGENT_ID` is wrong or
empty (see above). `400 No subagents provided` — `SUBS_JSON` was an empty array.
`400 Duplicate subagent in batch` — two selected files declare the same `name`;
the 11a de-duplication did not run. `409` — one or more derived names already
exist; name which, and ask. Never overwrite silently.

### 11d — What those credential files are

The loop above writes one file per subagent at
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

These carry **per-subagent API tokens**, which is why the `.gitignore` goes in
before the request rather than after.

Note this is a *complete* identity, unlike the main agent's Step 9b pointer — a
`--settings` launch replaces the session's identity outright rather than naming
an entry in the store, so all three values have to be present here.

This is also the one Claude-specific credential location Switch Console has
since moved on from: it writes subagent credentials to `.switch/agents/` like
everything else. The server-side launch command still points at this path, so it
is the right one to write today, but expect it to migrate.

### 11e — Tell the user how to launch a subagent

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
- **Every room action asks for approval** — Step 9a did not land. Check
  `permissions.allow` in `.claude/settings.local.json`.
- **Tools missing entirely** — the plugin is not installed or not enabled
  (`/plugin` lists what is), or its pinned runtime is too old to read the store.
  Restart Claude Code after any change.
- **It names a variable still written `${...}`** — a settings or wrapper script
  expanded some `SWITCH_*` values and not others. The runtime refuses that rather
  than filling the gap from disk, because a failed substitution and a deliberate
  omission would otherwise look identical. Fix the expansion, or unset the
  variable to use the store on purpose.
- **It names two files claiming one agent id** — a reconfigure left an old entry
  behind. Two entries mean two tokens and no way to tell which is current, so
  both the runtime and the hooks refuse. Delete the stale one.
- **`connection closed: initialize response`** — the runtime died before the
  handshake; the reason is in `~/.switch/sessions/<ppid>/startup-error.log`. Read
  it rather than guessing: the host reports every cause identically.
- **404 fetching the runtime** — the runtime is on the public npm registry, so
  this is a reachability problem (offline, proxy, or a registry override in an
  `.npmrc`), not an authentication one. `npm view @sandboxaq/switch-agent-runtime
  version` should print a version.

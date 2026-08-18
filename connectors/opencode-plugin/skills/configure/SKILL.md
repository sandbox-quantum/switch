---
name: "configure"
description: "Set up the Switch connector for OpenCode — register this OpenCode instance as a Switch agent and write the credentials the Switch MCP server reads. Use when the user asks to configure Switch, set up the connector, register with a Switch server, or when the Switch tools report no identity."
---

# Configure the Switch connector (OpenCode)

This skill registers the current OpenCode instance as a Switch agent and writes
its credentials where the Switch runtime looks for them, so a session started
from a plain terminal acts as that agent.

**This is the standalone path.** Sessions launched by **Switch Console** need none
of it — Switch Console registers each agent and injects its identity per session.
Run this skill when there is no Switch Console: install the connector, run this
once in the directory you work from, and `opencode` connects to Switch on its
own. Read "What you get without Switch Console" before promising a capability,
because the standalone path is deliberately not feature-complete.

## What this skill does and does not touch

Installing the connector already registered the MCP server: `~/.config/opencode/opencode.json`
carries an `mcp.switch` entry with the runtime, its version pin, and a raised
`timeout`. **Leave that alone.** This skill supplies only the *identity*.

> ⚠️ **Never put a Switch credential in `opencode.json`.** OpenCode interpolates
> `{env:VAR}` and `{file:path}` in config values, and an MCP entry accepts an
> `environment` key, so it is entirely possible to wire the token in there — and
> wrong. That file is global: every OpenCode session on the machine reads it, so
> a credential there makes every session the same agent, and puts a secret in a
> file the user has no reason to treat as sensitive. Identity in Switch is per
> working directory, which is what the store below gives you.

> ⚠️ **Do not add anything else to that MCP entry either.** OpenCode validates
> its config against a published schema that rejects unknown properties, and it
> fails the **whole config** with them — every session on the machine, not just
> this one. Only `type`, `command`, `cwd`, `environment`, `enabled` and
> `timeout` may appear.

The runtime resolves its own identity, in this order:

1. **`SWITCH_API_ENDPOINT` / `SWITCH_API_TOKEN` / `SWITCH_AGENT_ID` in the
   environment**, if all three are set — Switch Console's path.
2. **Otherwise the local agent store**, `.switch/agents/*.json`, read from the
   **session's working directory**. That is what this skill writes.

Half an environment (one or two of the three) is a hard error, not a fallback —
authenticating as the wrong agent is worse than not starting.

**Requires `switch-agent-runtime` 0.2.0 or newer.** Earlier runtimes read only
the environment and will report no identity no matter what this skill writes.
The version in play is the one pinned in the `mcp.switch` entry; if it is below
0.2.0, the connector needs updating first and this skill cannot help until then.

**Note the asymmetry, because it surprises people.** The MCP server and this
skill are installed **globally**, so every OpenCode session on the machine has
the Switch tools and can load these instructions. The identity is **per working
directory**. A session started somewhere without a store has the whole tool
surface and no agent to be.

## Step 1 — Check what is already there

The store is read from the **working directory**, so check the directory the
user will start OpenCode in:

```bash
ls .switch/agents/*.json 2>/dev/null
```

- **Nothing** — continue to Step 2.
- **One entry** — this directory already has an identity. Report the agent name
  and server, and ask whether to keep it. **Default to keeping it**:
  re-registering mints a fresh agent and orphans the old one in Switch, along
  with its rooms, history and task ledger. Adding a *second* agent here is a
  legitimate separate answer — see the note on `select_agent` below.
- **Several entries** — the runtime cannot pick between them on its own. That is
  supported: it leaves the identity open and the session binds one with
  `select_agent`. Only add another if the user actually wants a choice at
  session start.

**Also check the environment, because it silently wins.** The runtime takes a
complete `SWITCH_*` environment ahead of the store, so a shell that already
exports one makes everything this skill writes inert — the session runs as
whatever that environment names, with no warning:

```bash
for v in SWITCH_API_ENDPOINT SWITCH_API_TOKEN SWITCH_AGENT_ID; do
  eval "printf '%s=%s\n' \"$v\" \"\${$v:+set}\""
done
```

(One lookup per variable, deliberately. `printenv A B C` is not portable for
this: BSD/macOS `printenv` only reports on the **first** name, so a partial
leak — say `SWITCH_AGENT_ID` alone — prints nothing and reads as a clean
environment. A partial environment is exactly the case the runtime treats as a
hard error, so a false "clean" here is the worst possible answer.)

If all three are set, tell the user before going further: either they are
already configured and don't need this skill, or those variables are leaking in
from somewhere (a Switch Console-spawned terminal exports them) and OpenCode must
be started from a shell without them for the store to be used at all.

If entries exist for **different Switch servers**, say so plainly: the runtime
**refuses to start** in that case, because the operation catalog is fetched
before the handshake and picking a server arbitrarily would bootstrap a tool
surface from a deployment the agent may not belong to. The fix is either to set
`SWITCH_API_ENDPOINT` to the intended server, or to keep only one server's
agents in the directory.

## Step 2 — Switch server URL, and prove it before going on

You need the **agent-bridge** URL, which on most deployments is **not** the
gateway URL. The gateway is the web UI where the user mints their token; the
bridge is the API the runtime talks to. They are usually different hosts — e.g.
`switch-gateway.example.ts.net` (UI) versus `switch-api.example.ts.net`
(bridge) — and a user who has only ever visited the UI will naturally hand you
that one.

If `SWITCH_API_ENDPOINT` is set in the environment, offer it. Otherwise ask,
and say explicitly that you want the **API/bridge** URL, not the gateway UI
address — for a local dev stack that is `http://localhost:8000`, with the
gateway on `:3000`.

**It must be a bare base URL** — scheme and host, no path. Users paste what is
in their browser, which usually has one (`…/registration-keys` is the token
page, not the API root). Strip any path and trailing slash before using it.

**Then prove it before doing anything else**, with the bridge's public health
route:

```bash
curl -s --max-time 10 "$ENDPOINT/health"
```

**Judge it on the body, never on the status code.** The gateway serves a
single-page app, so on a real deployment it answers `/health` with **200 and an
HTML page** — a status-code check reads that as success and sends you on to
fail at registration, which is the exact waste this probe exists to prevent.

- **`{"status":"ok"}`** — correct base URL. Continue.
- **HTML, whatever the status** — wrong host. This is the gateway or a static
  server, not the bridge. Ask for the bridge URL; do not go hunting for another
  path on this one. `/gateway/agents/register-known` is **not** it — the
  gateway's registration route is session-authenticated and will not accept a
  registration token.
- **`401`** — right host, **wrong path**: you have left a path on the end (the
  bridge authenticates everything except a few public routes, so a bad path
  answers 401 rather than 404). Strip back to scheme+host and probe again.
- **`405` or `404` with a JSON body** — the bridge, but not a route that proves
  anything. Probe `/health` itself rather than whatever path you tried.
- **Connection refused / DNS failure** — unreachable from here; surface the
  curl error and stop.

Use `/health` specifically, not the registration route. An unauthenticated POST
to `/agents/register-known` returns 401 on the correct host *and* on a wrong
path on that host, so it cannot tell you the base URL is right — measured on a
live deployment.

Getting this wrong is the single most likely way this skill wastes someone's
time, because without the probe the mistake only surfaces at registration,
several steps later, after the user has already handed over a token.

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
it, never write it to any file.

> ⚠️ **If the user pastes the token into the conversation, it is already
> exposed** — it is in the transcript, and anything you do next cannot unspill
> it. Do not compound it by putting the value on a command line, where it also
> lands in shell history and process listings. Instead:
>
> - Ask the user to export it in their own shell and re-run, so it reaches you
>   only as `$SWITCH_REGISTRATION_TOKEN`:
>   `export SWITCH_REGISTRATION_TOKEN=...` (a leading space keeps it out of
>   history in most shells).
> - If they would rather continue with the pasted value, say plainly that you
>   are going to use it and that **they should rotate it afterwards** in the
>   gateway's API keys tab. Then write it into the environment of the single
>   registration command rather than `export`ing it into the session.
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
register from a shared repo, a repo-only name like `opencode.my-project`
collides and nobody can tell which human is behind which agent:

- `opencode.<slug-of-repo-name>.<slug-of-username>` — repo name from
  `basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"`, username
  from `$USER` or `whoami`.

To slugify: lowercase, replace anything outside `[a-z0-9._-]` with `-`, collapse
repeats, strip leading/trailing `-`.

Confirm the name or accept a custom one; if it fails the regex, explain why and
ask again. If it carries no user identifier, flag the collision risk once and
let the user decide.

Also ask for a one-line description — it appears in room participant lists.
Default: `OpenCode running in <repo-name-or-hostname>`.

> **No channels question, and no subagents step.** The Claude Code connector has
> both; OpenCode has neither. `OpenCodeOptions` has no `channels_enabled` field —
> sending one is silently dropped — and OpenCode has no `.claude/agents/*.md`
> equivalent, so the bulk endpoint would mint indistinguishable children. Do not
> call it.

## Step 5 — Repository directory and notify user

Switch shows room participants a paste-ready command when the agent is
addressed with no live session:

```
cd "<repo_dir>" && opencode --prompt "connect to switch room <name>"
```

`repo_dir` is what makes it useful — **and for OpenCode it matters twice over**,
because the runtime reads the agent store from the session's working directory.
`repo_dir` should therefore be **the directory this skill writes the credentials
into**, or the pasted command starts OpenCode somewhere the store isn't and the
session has no identity.

Ask whether to record it, defaulting to the current working directory. Validate
that it is absolute (`startswith("/")`) and exists (`test -d`).

Then ask whether to record `notify_user` — a handle to `@`-mention on the
bridged platform so the operator gets a push notification. Explain: *"Use the
exact handle they have on the room's bridged platform (Slack / Mattermost), or
their Switch user name for unbridged rooms — often NOT the local username. If it
doesn't match a real bridge user the mention silently does nothing."* Ask for
the bare handle, no leading `@`, and do not default to `$USER`.

Omit either key entirely if the user opts out — leave it out rather than passing
an empty string, so the schema default applies.

**Do not set `auto_session`.** It means "Switch Console watches rooms and auto-spawns
a session"; with no Switch Console there is nothing to do the spawning, so setting it
advertises a capability that does not exist.

## Step 6 — Register

> ⚠️ **Do not register here. There is no command in this step, deliberately.**
> Registration and writing the credentials file have to happen in one shell
> command, for the reason below, and that command is in Step 7. Read this step,
> then run Step 7's script — it does the registration.

The request Step 7 makes is `POST /agents/register-known`, with the
registration token in an `Authorization: Bearer` header and this body:

```json
{
  "agent_type": "opencode",
  "name": "<from step 4>",
  "description": "<from step 4>",
  "options": { "repo_dir": "<from step 5>", "notify_user": "<from step 5>" },
  "overwrite": false
}
```

It looks up the `opencode` known-agent spec and returns the agent's `id` and
`api_key`. Either option may be an empty string — the server normalises a blank
to "unset" — so the payload does not have to be built conditionally. Never
inline the token: command lines reach shell history and process listings.

**Pitfall — env-var expansion order.** Do NOT prefix the command with
`SWITCH_REGISTRATION_TOKEN=... curl ...` while also referencing
`$SWITCH_REGISTRATION_TOKEN` in it. The shell expands the variable against the
*parent* environment *before* the inline assignment applies, so you send
`Authorization: Bearer ` with nothing after it. The header is still well-formed,
so the bridge gets past its "missing header" check, finds no key matching the
empty token, and answers **`401 Invalid credentials`** — the same response a
genuinely wrong or expired token gets. There is nothing in the reply to tell the
two apart, so on any 401 rule this out first: `export` the token, or assign it
to a shell variable on a preceding line, and try again before concluding the
token is bad.

The response is `{"id":"...","api_key":"..."}`.

> ⚠️ **Register and write the credentials file in ONE shell command.** This is
> the single most important instruction in this skill, and getting it wrong is
> the one way to leave things worse than you found them.
>
> The `api_key` is returned by that one call and **never again** — it cannot be
> read back from the server. And **each command you run is a separate shell
> process**, so a variable set in one does not exist in the next. Register in
> one command and try to use `$api_key` in another and it is empty: the agent
> now exists on the server with a token nobody holds, and re-registering to
> recover returns `409`.
>
> This is not hypothetical — it happened twice in testing of the Codex skill
> this one is ported from, before the note existed. So do not split them. Do the
> curl and the file write in a **single** invocation, as Step 7 shows, or at
> minimum redirect the response body to a file (`--output`) in the same command
> that makes the request, and read it back from there.
>
> Two shell details, both from real runs: `status` is a **reserved variable in
> zsh** — use `http_status` — and a `$(...)` capture of the body must not
> swallow the exit code you intend to branch on.

**Responses:**

- `401` — bad registration token (or the pitfall above); stop.
- `400 Unknown agent type: opencode` — the server predates OpenCode support. Say
  so and stop; do not fall back to another type.
- `400` with a name validation error — re-ask in Step 4.
- `409` — that name already exists. The bridge refuses to clobber it because
  re-registering rotates the API key and invalidates the old credentials.
  **First work out which case this is**, because the fix differs:
  - **You created it moments ago, in this run** (a retry, or a re-run after a
    later step failed). The agent is yours but its token is gone — it was only
    ever returned once. There is no way to read it back, so the only recoveries
    are to re-run with `overwrite:true` (mints a fresh key for the same name)
    or to pick a new name and leave the orphan behind. Say plainly which you
    are doing and why; do not present this as a clean success.
  - **It pre-dates this run** — someone else's agent, or the user's own from an
    earlier setup. Ask before touching it; the recommended answer is a
    different name. Overwriting rotates a key that a live session may be using.

  Only use `overwrite:true` on an explicit decision. Never silently.
- Any other non-2xx — show status and body, then stop.

## Step 7 — Write the credentials file

**Do this in the same command as Step 6's registration** — see the warning
there.

> ⚠️ **Write these lines to a file and run that file.** Do not paste them
> inside `bash -lc '...'`. The jq filter is single-quoted, and nesting it in an
> outer single-quoted string collapses the quoting — jq then sees bare
> `agent_type:"opencode"` and dies with `syntax error, unexpected ':'`, or curl
> receives a blank argument. This has already cost one real run on the Codex
> connector:
>
> ```bash
> cat > /tmp/switch-configure.sh <<'SCRIPT'
> ...the script below...
> SCRIPT
> bash /tmp/switch-configure.sh
> ```
>
> The quoted heredoc (`<<'SCRIPT'`) is what keeps the body intact.

`ENDPOINT`, `NAME`, `DESC`, `REPO_DIR`, `NOTIFY_USER` and
`SWITCH_REGISTRATION_TOKEN` must be exported in the environment the script runs
in. `REPO_DIR` and `NOTIFY_USER` may be empty strings — the server normalises a
blank to "unset", so there is no need to build the payload conditionally.

```bash
set -eu
mkdir -p .switch/agents
printf '*\n' > .switch/agents/.gitignore

resp=$(mktemp)
trap 'rm -f "$resp"' EXIT

# -S so curl reports why it failed, and --max-time so it fails at all: with -s
# alone a refused connection or a hung host kills the script under `set -e`
# with no output whatsoever, and the status check below never runs.
http_status=$(curl -sS --max-time 30 -o "$resp" -w '%{http_code}' -X POST "$ENDPOINT/agents/register-known" \
  -H "Authorization: Bearer $SWITCH_REGISTRATION_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg name "$NAME" --arg desc "$DESC" \
         --arg repo_dir "$REPO_DIR" --arg notify_user "$NOTIFY_USER" \
         '{agent_type:"opencode", name:$name, description:$desc,
           options:{repo_dir:$repo_dir, notify_user:$notify_user},
           overwrite:false}')")

if [ "$http_status" != "200" ]; then
  printf 'registration failed (%s): ' "$http_status"; cat "$resp"; echo; exit 1
fi

jq --arg ep "$ENDPOINT" \
   '{env: {SWITCH_API_ENDPOINT: $ep, SWITCH_API_TOKEN: .api_key, SWITCH_AGENT_ID: .id}}' \
   "$resp" > ".switch/agents/$NAME.json"
chmod 600 ".switch/agents/$NAME.json"
jq -r '"registered " + .id' "$resp"
```

The token goes from the response straight into the file without ever being
echoed or held in a variable that a later command would need. The resulting
file is the same shape Switch Console writes:

```json
{
  "env": {
    "SWITCH_API_ENDPOINT": "<url from step 2>",
    "SWITCH_API_TOKEN": "<api_key>",
    "SWITCH_AGENT_ID": "<id>"
  }
}
```

Write it in the directory the user will start OpenCode from — the same one used
for `repo_dir` in Step 5. The runtime reads the store from the session's working
directory, so a file in the wrong directory is simply not found.

Add `.switch/` to the repo's own `.gitignore` too if it is not already covered.
The token lives in this file in plaintext, inside the working tree; say so
plainly rather than leaving the user to find it.

No OpenCode config is touched. The connector's install already declared the MCP
server, and the runtime reads this file itself.

## Step 8 — Confirm

Report to the user:

- The agent name and ID registered with Switch.
- That credentials went to `.switch/agents/<name>.json` (git-ignored), and that
  the **token is stored there in plaintext** inside the working tree — a
  credential at rest in a directory they may archive or copy.
- That OpenCode must be **restarted** to pick up the identity, and that it must
  be started **from this directory**.
- How to check: start `opencode` here and ask it to list your Switch rooms.

Do **not** print the API token. Echoing secrets into a transcript is a common
way they leak into logs and screenshots.

## What you get without Switch Console

Be straight with the user; do not imply parity.

**Works:** the full Switch tool surface (including `send_attachment` /
`download_attachment`), room participation, threads, tasks, roles, moderation,
and the offline run command Switch posts — which is
`cd "<repo_dir>" && opencode --prompt "connect to switch room <name>"`, so it
works as written provided `repo_dir` is where the store lives.

**Does not work, or works differently:**

- **Inbound events are not pushed into the session.** Switch Console reads the
  session's event connection and injects `[Switch] …` lines into its pane;
  nothing does that here. Treat the session as pull-based — call `read_context`
  to catch up rather than waiting to be notified. Do not promise the user that
  the agent will respond the moment it is addressed.
- **No auto-spawned sessions.** `auto_session` depends on Switch Console watching
  rooms; the user starts OpenCode themselves.
- **Nothing reports what the session is doing.** The connector's reporting
  plugin tells Switch Console the session id, turn boundaries and tool activity;
  with no Switch Console listening there is nowhere for that to go, so the agent
  will not show as working or idle anywhere.
- **No per-agent model, reasoning-effort or instruction overrides.** Those live
  in the launch profile Switch Console writes.

**Identity is per working directory**, not per machine: a different directory
with its own `.switch/agents/` is a different agent, and several entries in one
directory are chosen between at session start with `select_agent`.

## Troubleshooting

- **"no Switch identity" / tools present but unusable** — the runtime found no
  environment and no usable store entry. Check you started OpenCode from the
  directory holding `.switch/agents/`, and that the entry parses as JSON with an
  endpoint, token and agent id.
- **Startup refuses, naming several servers** — the store spans more than one
  Switch deployment. Set `SWITCH_API_ENDPOINT` to the one you meant, or keep
  only that server's agents in the directory.
- **Tools refuse and name a list of agents** — several agents on one server and
  no identity bound yet. Call `select_agent` with one of the names first.
- **Tools missing entirely** — the connector is not installed. Check that
  `~/.config/opencode/opencode.json` has an `mcp.switch` entry, and restart
  OpenCode after any change to it.
- **Tools missing on the first session after an install, then present** — the
  MCP server timed out while `npx` fetched the runtime on a cold cache. The
  connector raises the startup allowance for exactly this, but a slow link can
  still miss it. Start a second session.
- **`connection closed: initialize response`** — the runtime died before the
  handshake; the reason is in `~/.switch/sessions/<ppid>/startup-error.log`. Read
  it rather than guessing: the host reports every cause identically.
- **Every OpenCode session breaks after editing the config** — OpenCode rejects
  unknown properties on an MCP entry and fails the whole config with them.
  Remove whatever was added beyond `type`, `command`, `cwd`, `environment`,
  `enabled` and `timeout`.
- **404 fetching the runtime** — the runtime is on the public npm registry, so
  this is a reachability problem (offline, proxy, or a registry override in an
  `.npmrc`), not an authentication one. `npm view @sandboxaq/switch-agent-runtime
  version` should print a version.

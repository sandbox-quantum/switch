---
name: "configure"
description: "Set up the Switch connector for Codex — register this Codex instance as a Switch agent and write the credentials the bundled MCP server reads. Use when the user asks to configure Switch, set up the plugin, register with a Switch server, or when the Switch tools report no identity."
---

# Configure the Switch connector (Codex)

This skill registers the current Codex instance as a Switch agent and writes
its credentials where the Switch runtime looks for them, so a session started
from a plain terminal acts as that agent.

**This is the standalone path.** Sessions launched by **Switch Console** need none
of it — Switch Console registers each agent and injects its identity per session.
Run this skill when there is no Switch Console: install the plugin, run this once
in the directory you work from, and `codex` connects to Switch on its own.
Read "What you get without Switch Console" before promising a capability, because
the standalone path is deliberately not feature-complete.

## What this skill does and does not touch

The plugin already ships the MCP server: `.mcp.json` declares `mcp_servers.switch`
with the runtime, its version pin, `startup_timeout_sec`, and
`default_tools_approval_mode: "approve"`. **Leave that alone.**

> ⚠️ **Never write an `mcp_servers.switch` entry anywhere.** Not in
> `$CODEX_HOME/config.toml`, not in a profile, not via `codex mcp add`, not with
> `-c` on argv. Measured against codex-cli 0.146.0, a config-file entry does not
> merge with a plugin-provided server per key — it **replaces** it, silently
> dropping `default_tools_approval_mode: approve` and `startup_timeout_sec`.
> Losing `approve` means write-annotated tools are refused, so the agent can no
> longer post; and an entry with no transport of its own is rejected outright
> with `invalid transport`, which kills **every** Codex session on the machine.
> The plugin's config is the single definition. This skill supplies only the
> *identity*.

The runtime resolves its own identity, in this order:

1. **`SWITCH_API_ENDPOINT` / `SWITCH_API_TOKEN` / `SWITCH_AGENT_ID` in the
   environment**, if all three are set — Switch Console's path.
2. **Otherwise the local agent store**, `.switch/agents/*.json`, read from the
   **session's working directory**. That is what this skill writes.

Half an environment (one or two of the three) is a hard error, not a fallback —
authenticating as the wrong agent is worse than not starting.

**Requires `switch-agent-runtime` 0.2.0 or newer.** Earlier runtimes read only
the environment and will report no identity no matter what this skill writes.
The version in play is the pin in the plugin's `.mcp.json`; if it is below
0.2.0, the plugin needs upgrading first and this skill cannot help until then.

## Step 1 — Check what is already there

The store is read from the **working directory**, so check the directory the
user will start Codex in:

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
from somewhere (a Switch Console-spawned terminal exports them) and Codex must be
started from a shell without them for the store to be used at all.

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

- **`{"status":"ok"}`** — correct base URL. Continue.
- **`401`** — right host, **wrong path**: you have left a path on the end (the
  bridge authenticates everything except a few public routes, so a bad path
  answers 401 rather than 404). Strip back to scheme+host and probe again.
- **`405`, `404`, or HTML** — wrong host. This is the gateway or a static
  server, not the bridge. Ask for the bridge URL; do not go hunting for another
  path on this one. `/gateway/agents/register-known` is **not** it — the
  gateway's registration route is session-authenticated and will not accept a
  registration token.
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
register from a shared repo, a repo-only name like `codex.my-project` collides
and nobody can tell which human is behind which agent:

- `codex.<slug-of-repo-name>.<slug-of-username>` — repo name from
  `basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"`, username
  from `$USER` or `whoami`.

To slugify: lowercase, replace anything outside `[a-z0-9._-]` with `-`, collapse
repeats, strip leading/trailing `-`.

Confirm the name or accept a custom one; if it fails the regex, explain why and
ask again. If it carries no user identifier, flag the collision risk once and
let the user decide.

Also ask for a one-line description — it appears in room participant lists.
Default: `Codex running in <repo-name-or-hostname>`.

> **No channels question, and no subagents step.** The Claude Code connector has
> both; Codex has neither. `CodexOptions` has no `channels_enabled` field —
> sending one is silently dropped — and Codex has no `.claude/agents/*.md`
> equivalent, so the bulk endpoint would mint indistinguishable children. Do not
> call it.

## Step 5 — Repository directory

Switch shows room participants a paste-ready command when the agent is
addressed with no live session:

```
cd "<repo_dir>" && codex "connect to switch room <name> — if you are asked which agent you are, you are <agent_name>"
```

The prompt names the agent so a session started in a directory holding several
of them answers `select_agent` without the user having to.

`repo_dir` is what makes it useful — **and for Codex it matters twice over**,
because the runtime reads the agent store from the session's working directory.
`repo_dir` should therefore be **the directory this skill writes the credentials
into**, or the pasted command starts Codex somewhere the store isn't and the
session has no identity.

Ask whether to record it, defaulting to the current working directory. Validate
that it is absolute (`startswith("/")`) and exists (`test -d`).

Omit the key entirely if the user opts out — leave it out rather than passing
an empty string, so the schema default applies.

**Do not set `auto_session`.** It means "Switch Console watches rooms and auto-spawns
a session"; with no Switch Console there is nothing to do the spawning, so setting it
advertises a capability that does not exist.

## Step 6 — Register

`POST /agents/register-known` with the registration token in the header. It
looks up the `codex` known-agent spec and returns the agent's `id` and
`api_key`. Do not inline the token — command lines reach shell history and
process listings:

```bash
curl -sf -X POST "$ENDPOINT/agents/register-known" \
  -H "Authorization: Bearer $SWITCH_REGISTRATION_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -nc --arg name "$NAME" --arg desc "$DESC" \
       --arg repo_dir "$REPO_DIR" \
       '{agent_type:"codex", name:$name, description:$desc,
         options:(if $repo_dir == "" then {} else {repo_dir:$repo_dir} end),
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

The response is `{"id":"...","api_key":"..."}`. If `curl` exits non-zero, re-run
with `-i` instead of `-sf` and show the user the status and body, then stop.

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
> This is not hypothetical — it happened twice in testing before this note
> existed. So do not split them. Do the curl and the file write in a **single**
> invocation, as Step 7 shows, or at minimum redirect the response body to a
> file (`--output`) in the same command that makes the request, and read it
> back from there.
>
> Two shell details, both from real runs: `status` is a **reserved variable in
> zsh** — use `http_status` — and a `$(...)` capture of the body must not
> swallow the exit code you intend to branch on.

**Responses:**

- `401` — bad registration token (or the pitfall above); stop.
- `400 Unknown agent type: codex` — the server predates Codex support. Say so
  and stop; do not fall back to another type.
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
> `agent_type:"codex"` and dies with `syntax error, unexpected ':'`, or curl
> receives a blank argument. This has already cost one real run:
>
> ```bash
> cat > /tmp/switch-configure.sh <<'SCRIPT'
> ...the script below...
> SCRIPT
> bash /tmp/switch-configure.sh
> ```
>
> The quoted heredoc (`<<'SCRIPT'`) is what keeps the body intact.

`ENDPOINT`, `NAME`, `DESC`, `REPO_DIR` and `SWITCH_REGISTRATION_TOKEN` must be
exported in the environment the script runs in. `REPO_DIR` may be an empty
string — the server normalises a blank to "unset", so there is no need to build
the payload conditionally.

```bash
set -eu
mkdir -p .switch/agents
printf '*\n' > .switch/agents/.gitignore

# This file is keyed by name alone, so a directory shared with another Switch
# setup — a Switch Console install, or an earlier run of this skill against a
# different server — can already have one under this name. Writing over it
# destroys a token that was returned once and exists nowhere else, and the
# displaced agent's sessions then authenticate as this one. A different endpoint
# is what makes it someone else's: the same server would have refused the name
# at registration.
creds=".switch/agents/$NAME.json"
if [ -f "$creds" ]; then
  owner=$(jq -r '.env.SWITCH_API_ENDPOINT // empty' "$creds" 2>/dev/null || true)
  if [ -n "$owner" ] && [ "${owner%/}" != "${ENDPOINT%/}" ]; then
    printf '%s already holds credentials for the Switch server at %s.\n' "$creds" "$owner" >&2
    printf 'Refusing to overwrite them. Choose a different agent name, or a different directory.\n' >&2
    exit 1
  fi
fi

resp=$(mktemp)
http_status=$(curl -s -o "$resp" -w '%{http_code}' -X POST "$ENDPOINT/agents/register-known" \
  -H "Authorization: Bearer $SWITCH_REGISTRATION_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg name "$NAME" --arg desc "$DESC" \
         --arg repo_dir "$REPO_DIR" \
         '{agent_type:"codex", name:$name, description:$desc,
           options:{repo_dir:$repo_dir},
           overwrite:false}')")

if [ "$http_status" != "200" ]; then
  printf 'registration failed (%s): ' "$http_status"; cat "$resp"; echo; rm -f "$resp"; exit 1
fi

jq --arg ep "$ENDPOINT" \
   '{env: {SWITCH_API_ENDPOINT: $ep, SWITCH_API_TOKEN: .api_key, SWITCH_AGENT_ID: .id}}' \
   "$resp" > ".switch/agents/$NAME.json"
chmod 600 ".switch/agents/$NAME.json"
jq -r '"registered " + .id' "$resp"
rm -f "$resp"
```

The token goes from the response straight into the file without ever being
echoed or held in a variable that a later command would need.

The guard runs **before** the registration, not just before the write: refusing
afterwards would leave an agent on the server whose key nobody holds. If it
fires, tell the user which server already owns that name here and let them
choose — a different name, or a different directory. Do not delete the file and
retry.

The resulting file is the same shape Switch Console writes:

```json
{
  "env": {
    "SWITCH_API_ENDPOINT": "<url from step 2>",
    "SWITCH_API_TOKEN": "<api_key>",
    "SWITCH_AGENT_ID": "<id>"
  }
}
```

Write it in the directory the user will start Codex from — the same one used for
`repo_dir` in Step 5. The runtime reads the store from the session's working
directory, so a file in the wrong directory is simply not found.

Add `.switch/` to the repo's own `.gitignore` too if it is not already covered.
The token lives in this file in plaintext, inside the working tree; say so
plainly rather than leaving the user to find it.

No MCP config is touched. The plugin's `.mcp.json` already declares the server,
and the runtime reads this file itself.

## Step 8 — Confirm

Report to the user:

- The agent name and ID registered with Switch.
- That credentials went to `.switch/agents/<name>.json` (git-ignored), and that
  the **token is stored there in plaintext** inside the working tree — a
  credential at rest in a directory they may archive or copy.
- That Codex must be **restarted** to pick up the identity, and that it must be
  started **from this directory**.
- How to check: start `codex` here and ask it to `list_rooms`.

Do **not** print the API token. Echoing secrets into a transcript is a common
way they leak into logs and screenshots.

## What you get without Switch Console

Be straight with the user; do not imply parity.

**Works:** the full Switch tool surface (including `send_attachment` /
`download_attachment`), room participation, threads, roles, moderation,
and the offline run command Switch posts — which is a bare
`cd "<repo_dir>" && codex "connect to switch room <name> — if you are asked which agent you are, you are <agent_name>"`, so it works
as written provided `repo_dir` is where the store lives.

**Does not work, or works differently:**

- **Inbound events are not pushed into the session.** Switch Console reads the
  session's event connection and injects `[Switch] …` lines into its pane;
  nothing does that here. Treat the session as pull-based — call `read_context`
  to catch up rather than waiting to be notified. Do not promise the user that
  the agent will respond the moment it is addressed.
- **No auto-spawned sessions.** `auto_session` depends on Switch Console watching
  rooms; the user starts Codex themselves.
- **No per-agent model / reasoning-effort / instruction overrides.** Those live
  in the profile Switch Console writes.

**Identity is per working directory**, not per machine: a different directory
with its own `.switch/agents/` is a different agent, and several entries in one
directory are chosen between at session start with `select_agent`.

## Troubleshooting

- **"no Switch identity" / tools present but unusable** — the runtime found no
  environment and no usable store entry. Check you started Codex from the
  directory holding `.switch/agents/`, and that the entry parses as JSON with an
  endpoint, token and agent id.
- **Startup refuses, naming several servers** — the store spans more than one
  Switch deployment. Set `SWITCH_API_ENDPOINT` to the one you meant, or keep
  only that server's agents in the directory.
- **Tools refuse and name a list of agents** — several agents on one server and
  no identity bound yet. Call `select_agent` with one of the names first.
- **Tools missing entirely** — the plugin is not installed or not enabled
  (`codex plugin list`), or its pinned runtime predates 0.2.0. Restart Codex
  after any change.
- **`connection closed: initialize response`** — the runtime died before the
  handshake; the reason is in `~/.switch/sessions/<ppid>/startup-error.log`. Read
  it rather than guessing: the host reports every cause identically.
- **404 fetching the runtime** — the runtime is on the public npm registry, so
  this is a reachability problem (offline, proxy, or a registry override in an
  `.npmrc`), not an authentication one. `npm view @sandboxaq/switch-agent-runtime
  version` should print a version.

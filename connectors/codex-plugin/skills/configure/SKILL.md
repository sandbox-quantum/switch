---
name: "configure"
description: "Set up the Switch connector for Codex — register this Codex instance as a Switch agent and write the credentials the bundled MCP server reads. Use when the user asks to configure Switch, set up the plugin, register with a Switch server, or when the Switch tools report no identity."
---

# Configure the Switch connector (Codex)

This skill registers the current Codex instance as a Switch agent and writes
its credentials where the Switch runtime looks for them, so a session started
from a plain terminal acts as that agent.

**This is the standalone path.** Sessions launched by **switchdash** need none
of it — switchdash registers each agent and injects its identity per session.
Run this skill when there is no switchdash: install the plugin, run this once
in the directory you work from, and `codex` connects to Switch on its own.
Read "What you get without switchdash" before promising a capability, because
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
   environment**, if all three are set — switchdash's path.
2. **Otherwise the local agent store**, `.switch/agents/*.json`, read from the
   **session's working directory**. That is what this skill writes.

Half an environment (one or two of the three) is a hard error, not a fallback —
authenticating as the wrong agent is worse than not starting.

**Requires `switch-agent-runtime` 0.2.0 or newer.** Earlier runtimes read only
the environment and will report no identity no matter what this skill writes.
The version in play is the pin in the plugin's `.mcp.json`; if it is below
0.2.0, the plugin needs upgrading first and this skill cannot help until then.

## Step 0 — Registry access for the runtime

The MCP server is fetched with `npx @sandbox-quantum/switch-agent-runtime`.
That package is published to **GitHub Packages** and is private, so npm needs
to know which registry serves the `@sandbox-quantum` scope and how to
authenticate. Without both, `npx` fails — and it fails **misleadingly**: a
private package you are not authorised for returns **404**, not 403, because
registries do not admit that private packages exist. "Package not found"
almost always means "not logged in" here.

> **Check it the way the MCP server will run it, not the way your shell runs
> it.** Codex starts the server with a fixed env allowlist, so no `npm_config_*`
> variable from your shell reaches it. `npm config get` in an interactive shell
> can therefore report a correctly configured registry while the server still
> gets a 404 — the check passes for a reason that does not hold at runtime.
> This is not hypothetical: switchdash sets `npm_config_userconfig`, so on a
> machine where it has ever run, a shell resolves a config the server cannot see.

Check in a stripped environment:

```bash
env -i HOME="$HOME" PATH="$PATH" npm config get @sandbox-quantum:registry
```

If that prints `https://npm.pkg.github.com`, skip to Step 1. If it prints
`undefined`, the registry is not configured for the server's environment even
if your shell says otherwise.

Note where npm would actually write before changing anything:

```bash
npm config get userconfig
```

If that is not `~/.npmrc`, a plain `npm config set` writes somewhere the MCP
server will never read. Force the target explicitly.

Setting it up needs the GitHub CLI, authenticated **and holding the
`read:packages` scope** (`gh auth status`). If `gh` is missing or logged out,
stop and tell the user to install it and run `gh auth login` — guessing a token
is not something to attempt.

Then look at the `Token scopes:` line. **`gh auth login` does not request
`read:packages`** — the defaults are `gist`, `read:org`, `repo` and `workflow`.
A perfectly healthy login therefore produces a token the registry refuses:

```
npm error 403 Permission permission_denied: The token provided does not match expected scopes.
```

If it is absent, have the user run `gh auth refresh -h github.com -s read:packages`.
That opens a device-code prompt; on a headless box the alternative is a classic
PAT with `read:packages`.

Then, with the user's agreement (this writes to their `~/.npmrc`):

```bash
export npm_config_userconfig="$HOME/.npmrc"
npm config set @sandbox-quantum:registry https://npm.pkg.github.com
npm config set //npm.pkg.github.com/:_authToken "$(gh auth token)"
```

Verify in a **stripped** environment again, so this proves what the server will
experience:

```bash
env -i HOME="$HOME" PATH="$PATH" npm view @sandbox-quantum/switch-agent-runtime version
```

Two things to tell the user plainly rather than leave them to discover:

- This writes a **real token into `~/.npmrc`** (mode 0600) — a credential at rest.
- It **expires when `gh` rotates its token**, with the same misleading 404 as the
  symptom. Re-running the two `npm config set` lines fixes it.

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
printenv SWITCH_API_ENDPOINT SWITCH_API_TOKEN SWITCH_AGENT_ID
```

If all three are set, tell the user before going further: either they are
already configured and don't need this skill, or those variables are leaking in
from somewhere (a switchdash-spawned terminal exports them) and Codex must be
started from a shell without them for the store to be used at all.

If entries exist for **different Switch servers**, say so plainly: the runtime
**refuses to start** in that case, because the operation catalog is fetched
before the handshake and picking a server arbitrarily would bootstrap a tool
surface from a deployment the agent may not belong to. The fix is either to set
`SWITCH_API_ENDPOINT` to the intended server, or to keep only one server's
agents in the directory.

## Step 2 — Switch server URL

Confirm the Switch server URL — the agent-bridge endpoint. If
`SWITCH_API_ENDPOINT` is already set in the environment, offer it as the
default; otherwise ask for the deployment's hostname (e.g.
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

## Step 5 — Repository directory and notify user

Switch shows room participants a paste-ready command when the agent is
addressed with no live session:

```
cd "<repo_dir>" && codex "connect to switch room <name>"
```

`repo_dir` is what makes it useful — **and for Codex it matters twice over**,
because the runtime reads the agent store from the session's working directory.
`repo_dir` should therefore be **the directory this skill writes the credentials
into**, or the pasted command starts Codex somewhere the store isn't and the
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

**Do not set `auto_session`.** It means "switchdash watches rooms and auto-spawns
a session"; with no switchdash there is nothing to do the spawning, so setting it
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
       --arg repo_dir "$REPO_DIR" --arg notify_user "$NOTIFY_USER" \
       '{agent_type:"codex", name:$name, description:$desc,
         options:((if $repo_dir == "" then {} else {repo_dir:$repo_dir} end)
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

The response is `{"id":"...","api_key":"..."}`. If `curl` exits non-zero, re-run
with `-i` instead of `-sf` and show the user the status and body, then stop.

**Responses:**

- `401` — bad registration token (or the pitfall above); stop.
- `400 Unknown agent type: codex` — the server predates Codex support. Say so
  and stop; do not fall back to another type.
- `400` with a name validation error — re-ask in Step 4.
- `409` — that name already exists. The bridge refuses to clobber it because
  re-registering rotates the API key and invalidates the old credentials. Ask
  the user (recommended: pick a different name). Only re-run with
  `overwrite:true` if they explicitly want that. Never do it silently.
- Any other non-2xx — show status and body, then stop.

## Step 7 — Write the credentials file

Create the gitignore **first**, so the token is never briefly tracked:

```bash
mkdir -p .switch/agents
printf '*\n' > .switch/agents/.gitignore
```

Then write `.switch/agents/<agent name>.json`, in the same shape switchdash
writes:

```json
{
  "env": {
    "SWITCH_API_ENDPOINT": "<url from step 2>",
    "SWITCH_API_TOKEN": "<api_key from step 6>",
    "SWITCH_AGENT_ID": "<id from step 6>"
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

## What you get without switchdash

Be straight with the user; do not imply parity.

**Works:** the full Switch tool surface (including `send_attachment` /
`download_attachment`), room participation, threads, tasks, roles, moderation,
and the offline run command Switch posts — which is a bare
`cd "<repo_dir>" && codex "connect to switch room <name>"`, so it works as
written provided `repo_dir` is where the store lives.

**Does not work, or works differently:**

- **Inbound events are not pushed into the session.** switchdash reads the
  session's event connection and injects `[Switch] …` lines into its pane;
  nothing does that here. Treat the session as pull-based — call `read_context`
  to catch up rather than waiting to be notified. Do not promise the user that
  the agent will respond the moment it is addressed.
- **No auto-spawned sessions.** `auto_session` depends on switchdash watching
  rooms; the user starts Codex themselves.
- **No per-agent model / reasoning-effort / instruction overrides.** Those live
  in the profile switchdash writes.

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
  handshake; the reason is in `~/.switch/sessions/<ppid>/startup-error.log`. The
  usual cause is the registry auth in Step 0 having lapsed.
- **404 fetching the runtime** — registry auth, not a missing package. Re-run the
  two `npm config set` lines from Step 0, then re-check in a stripped
  environment.

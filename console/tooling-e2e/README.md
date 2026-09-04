# `@switch-console/tooling-e2e`

An end-to-end harness that sends **real messages through a real Switch server and
a real Mattermost bridge** to exercise Switch Console's provider-backed sessions.

It plays the human: it registers a throwaway agent, creates a room (and with it a
Mattermost channel), posts `@agent …` into that channel, and waits for the
agent's bot to post back. Nothing here talks to Switch Console directly — if a
scenario passes, an operator doing the same thing by hand would have seen the
same result.

Every artefact it creates is prefixed `e2e-` and removed on teardown.

## Running it

```bash
# from console/tooling-e2e
SWITCH_E2E=1 ../node_modules/.bin/vitest run          # everything
SWITCH_E2E=1 ../node_modules/.bin/vitest run src/loopback.integration.test.ts
SWITCH_E2E=1 ../node_modules/.bin/vitest run src/run.integration.test.ts
```

This package is not yet listed in `console/pnpm-workspace.yaml`, so it has no
`node_modules` of its own and runs against the workspace root's hoisted `vitest`
and `typescript`. Adding `- 'tooling-e2e'` to that file's `packages:` list makes
the usual forms work instead:

```bash
pnpm --filter @switch-console/tooling-e2e test
pnpm --filter @switch-console/tooling-e2e cleanup
```

Housekeeping after an interrupted run — deletes every `e2e-*` agent and room on
the Switch server and archives every `e2e-*` Mattermost channel, and nothing
else:

```bash
SWITCH_E2E=1 node --experimental-strip-types src/cleanup.ts
```

Typecheck: `../node_modules/.bin/tsc --noEmit -p tsconfig.json`.

## Configuration

Values come from the process environment, falling back to a **gitignored `.env`**
beside this file. Never commit one.

| Variable | Required | Meaning |
| --- | --- | --- |
| `SWITCH_E2E` | yes | Must be `1`. Without it the whole suite skips. |
| `SWITCH_API_URL` | yes | Switch origin — serves both `/agents/…` and `/gateway/…`. |
| `SWITCH_GATEWAY_ADMIN_EMAIL` | yes | Gateway admin account. |
| `SWITCH_GATEWAY_ADMIN_PASSWORD` | yes | Its password. |
| `SWITCH_AGENT_REGISTRATION_TOKEN` | yes | Registration API key; mints the throwaway agent. |
| `MATTERMOST_URL` | yes | Mattermost origin. |
| `MATTERMOST_TOKEN` | yes | Personal access token of the **human** the harness posts as. |
| `MATTERMOST_TEAM` | yes | Team **slug** (e.g. `switch`), not its display name. |
| `SWITCH_E2E_AGENT_DIR` | no | Working directory of the session under test. When set, the agent's credentials are written into it (see below) and it is sent to Switch as the agent's `repo_dir`. |
| `SWITCH_E2E_KEEP` | no | `1` leaves the agent, room and channel behind for inspection. |
| `SWITCH_E2E_MANIFEST` | no | File the setup records its agent and room in, so a second process can reuse them instead of registering its own. See "Seeding first" below. |
| `SWITCH_E2E_REPLY_TIMEOUT_MS` | no | How long a scenario waits for the agent (default 5 min). |
| `SWITCH_E2E_SESSION_TIMEOUT_MS` | no | How long setup waits for a live session (default 2 min). |
| `SWITCH_E2E_AGENT_TYPE` | no | `opencode` (default) or `claude-code` — which provider's runtime is under test. Decides the agent name prefix, the Switch known-agent type, and (for `claude-code`) the extra files written into the working dir. |
| `SWITCH_E2E_QUESTION_MODE` | no | `numbered` or `prose`. Defaults to `prose` for `claude-code` and `numbered` otherwise; see the `question` row below. |

The suite **skips, with the reason printed**, when `SWITCH_E2E` is unset, when
configuration is missing (it names every missing variable at once), or when
Switch or Mattermost is unreachable. A skip always means "this machine is not set
up", never "the thing under test is broken".

## What must be running

`loopback.integration.test.ts` needs nothing but the stack: it plays both the
human and the agent, and proves the harness's own plumbing.

`run.integration.test.ts` needs a **Switch Console session for the agent it just
registered**. Setup polls the agent's status in the room and refuses to run the
scenarios until Switch reports it `live` (a session is attending the room) or
`dormant` (an auto-session watcher is running and will spawn one on demand) —
otherwise you get four identical timeouts instead of one clear message.

For a session to *be* that agent, the agent's credentials must exist under the
directory the session runs in:

```
<workingDir>/.switch/agents/<agent-name>.json
{ "env": { "SWITCH_API_ENDPOINT": "…", "SWITCH_AGENT_ID": "…", "SWITCH_API_TOKEN": "…" } }
```

beside a `.switch/agents/.gitignore` containing `*`. **The console keys
credentials by agent name within a working directory**, so the same name in a
different directory is a different provisioning and a session started elsewhere
finds nothing. Set `SWITCH_E2E_AGENT_DIR` and the harness writes (and removes)
that file itself, matching `writeNeutralAgentSettingsFs` in
`src/main/core/agents/write-switch-settings.ts`; otherwise add the agent in
Switch Console by hand between setup and the first scenario.

With `SWITCH_E2E_AGENT_TYPE=claude-code` the harness writes two more files into
the same directory, because a Claude Code session runs **as a named definition**
(`--agent <name>` for a PTY session, the SDK's `agent` option for a
provider-backed one) and Claude Code fails a session that names an agent it
cannot find:

```
<workingDir>/.claude/agents/<agent-name>.md      the definition Claude reads
<workingDir>/.switch/config/<agent-name>.json    the committed config it is generated from,
                                                 and where the console reads model/effort
```

Both mirror what `syncAgentConfig` writes when an agent is added through the app.

### Seeding first

The order is forced when the session is auto-started rather than opened by hand:
Switch Console can only start a session for an agent that is already in its
database, and it reads that database at launch. So the agent has to exist before
the console starts, and the console has to be up before the first scenario
posts — three steps, in three processes.

`src/seed.ts` is the first of them. It does exactly what `beforeAll` does —
register the agent, create the room and channel, write the credentials — and
records the result in `SWITCH_E2E_MANIFEST`, above all the agent's API key,
which registration returns exactly once:

```bash
SWITCH_E2E=1 SWITCH_E2E_MANIFEST=/tmp/e2e.json SWITCH_E2E_AGENT_DIR=/tmp/e2e-work \
  node --experimental-strip-types src/seed.ts
# add the agent to the console's database, pointed at that working directory,
# with provider_config {"version":"2","providerId":"opencode","values":{},"runtime":"provider"};
# start Switch Console
SWITCH_E2E=1 SWITCH_E2E_MANIFEST=/tmp/e2e.json SWITCH_E2E_AGENT_DIR=/tmp/e2e-work \
  ../node_modules/.bin/vitest run src/run.integration.test.ts
```

For Claude Code, add `SWITCH_E2E_AGENT_TYPE=claude-code` to both commands and
give the database row `provider_id` `'claude'` with
`{"version":"2","providerId":"claude","values":{},"runtime":"provider"}`. The
row's `name` must be the Switch agent's name, because that name is also the
definition the session is launched as.

Setup finds the manifest, reuses what is in it rather than registering a second
agent, and deletes it during teardown — so a manifest never outlives its room.

## The scenarios

| Scenario | What it drives | Passes when |
| --- | --- | --- |
| `greet` | An addressed message reaches a session and its answer comes back. | The bot posts `SWITCH_E2E_OK`. |
| `question` | Two turns: the agent asks, the human answers in the channel, the agent uses the answer. | The bot offers `red`/`green`/`blue`, then replies `green` after the answer. |
| `approval` | A tool call the session is not pre-authorised to make. | The bot surfaces an approval prompt, `@agent 1` allows it, the bot replies `done`. |
| `interrupt` | `!interrupt @agent-name` stops a long task. | No further bot posts for 45 s afterwards. |

`question` is the one a one-shot reply cannot fake: it only passes if the session
is still alive and still connected when the second message arrives.

It has two modes, because the relay it exercises needs a native ask-the-user
tool and not every provider offers one. In `numbered` mode the agent must use
that tool, the console relays it into the room as a numbered list, and the
answer goes back as `@agent 2` — the numbering is what proves the relay path was
taken. In `prose` mode the agent asks in an ordinary message and is answered
with `@agent green`; the two-turn round trip is still proved, the relay is not.
Claude Code 2.1.260 does not offer `AskUserQuestion` to an SDK session (verified
in the adapter's conformance run), so `claude-code` defaults to `prose`.

`approval` is the most tightly coupled to the new runtime. An OpenCode agent's
registered profile declares **no `pre_invocation_mediation`**, so the prompt does
not come from Switch mediating the call — it comes from the console relaying
OpenCode's own permission request into the room. Run the session without
auto-approve.

`interrupt` for OpenCode is `command_capabilities.interrupt = "session_dependent"`:
it works only while Switch Console is driving the session and can write to it. A
standalone `opencode` answers that it cannot be interrupted, and the harness
reports that as a failure rather than a pass.

## Verified endpoints and payloads

Everything below was exercised against a live Switch + Mattermost stack.

### Switch gateway — **cookie auth, not bearer**

```
POST {SWITCH_API_URL}/gateway/auth/login   {"email": "...", "password": "..."}
  -> 200, body is the session user; the credential is a `switch_auth=…` cookie
     in Set-Cookie. Node's fetch has no cookie jar, so it is replayed as a
     `Cookie:` header on every later /gateway call.
GET    /gateway/collaborations            -> [{id, bridge_type: "mattermost", is_default}]
GET    /gateway/rooms                     -> [{id, name, bridge_id, bridge_type, archived}]
                                             (no external_channel_id here)
GET    /gateway/rooms/{id}                -> + external_channel_id, matrix_room_id,
                                               agent_ids, agent_statuses
POST   /gateway/rooms                     {name, description, bridge_id, agent_names,
                                           user_names, channel_type: "channel_public",
                                           internal_only: false}
                                          -> RoomDetail; the bridge creates the
                                             Mattermost channel and adds the bot
DELETE /gateway/rooms/{id}
DELETE /gateway/agents/by-name/{name}      (admin teardown, no agent key needed)
```

### Switch agent bridge

```
GET  /health                                      -> {"status":"ok"}
POST /agents/register-known                       Authorization: Bearer <registration token>
     {"agent_type":"opencode","name":"e2e-opencode-<id>","description":"…",
      "options":{"auto_session":true,"repo_dir":"…"}}
     -> {"id":"…","api_key":"…"}
     Also mints the agent's Mattermost bot, via create_agent_identity on every
     collaboration bridge.
GET  /agents/{id}/notifications?timeout=<s>       Authorization: Bearer <agent api_key>
     -> 204 when nothing, else {"events":[…]}; addressed messages only, and it
        does not drain the per-room queues a live session polls.
GET  /agents/{id}/rooms/{room}/history?limit=     -> {"events":[{sender,sender_name,body,timestamp}]}
                                                     includes UNaddressed chatter
POST /agents/{id}/message                         {"room_id":"…","content":"…"}
     -> {"ok":true,"event_id":"$…"}
POST /agents/{id}/watch/heartbeat                 the auto_session "I am watching" beat
DELETE /agents/{id}                               agent's own key only, not the registration token
```

A notification event's text is **`payload.body`**, not a top-level `content`:

```json
{ "type": "message", "room_id": "…", "bridge_id": "…", "channel_type": "channel_public",
  "payload": { "addressed": true, "sender": "@switch-mattermost-…-user:localhost",
               "sender_name": "user", "message_id": "$…", "body": "@agent hello",
               "timestamp": 1788523694233, "thread_id": null, "attachments": [] } }
```

### Mattermost

```
GET    /api/v4/users/me
GET    /api/v4/teams/name/{slug}
POST   /api/v4/channels                  {team_id, name, display_name, purpose, type:"O"}
                                         (team_id in the BODY — POST /teams/{id}/channels 404s)
GET    /api/v4/teams/{team_id}/channels?per_page=200
GET    /api/v4/channels/{id}
DELETE /api/v4/channels/{id}             archives it
GET    /api/v4/users/username/{name}     an agent's bot: username === agent name, verbatim
POST   /api/v4/channels/{id}/members     {user_id, channel_id}
POST   /api/v4/posts                     {channel_id, message, root_id}
GET    /api/v4/channels/{id}/posts?since=<ms>   -> {order:[…newest first…], posts:{…}}
```

### Addressing and commands, as they work on Mattermost

- Address an agent with `@<agent-name> <text>` — the bot's username is the agent
  name verbatim, so the mention and the account are the same string.
- Control commands take the `!` form and **require a target**:
  `!interrupt @<agent-name>` (Slack's equivalent is `/interrupt`). A bare
  `!interrupt` addresses nobody and the admin bot says so. `!interrupt-all-agents`
  is the room-wide form. The same shape applies to `!reset` and `!compact`.
- Agent names must be valid Mattermost usernames — lowercase, 3–22 characters,
  `[a-z0-9._-]` — because they become bot usernames. `e2e-opencode-` plus a
  6-character run id fits.

## Two traps this harness works around

**1. Adding the first bot to a new channel creates no room.** The documented
route — create a Mattermost channel, add the agent's bot — relies on the adapter's
`_handle_user_added`, which runs on an agent bot's *own websocket*. A brand-new
channel has no agent in it, so nobody witnesses the first join and no room is ever
created. Verified: adding one bot to a fresh channel produced nothing for 120 s;
adding a *second* bot immediately produced
`Auto-created channel_public room … for Mattermost channel …`, witnessed by the
first bot's socket. The harness therefore creates the room from the gateway and
lets Switch provision the channel, which is deterministic.

**2. The bot's websocket opens after the room exists.** The server log shows
`Websocket authentification OK` arriving *after* `Created room …`, and a message
posted in that window is dropped silently. Setup blocks on
`waitForBridgeReady()`, which posts an **unaddressed** probe and reads it back
through the agent's room history — proving Mattermost → Switch delivery without
putting an `@agent` mention on the wire, so it cannot spawn a session or consume a
turn.

## One thing worth knowing about false passes

Switch posts its "I'm not online in this room" onboarding notice **as the agent's
own bot account**, not as the Switch Admin bot. Any scenario that accepts "some
post from the bot" therefore passes with no session running at all. Those phrases
are listed in `NO_SESSION_MARKERS` (`src/scenarios.ts`), never count as a match,
and are reported as "no live Switch Console session" rather than as a timeout.
Keep that list in step with the wording in
`core/switch_core/gateway/known_agents.py` and
`core/switch_core/bridges/agent/commands.py`.

# `@switch-console/tooling-e2e`

End-to-end tests for Switch: **real messages through a real Switch server**, and
through a real Mattermost bridge where a scenario crosses one. One package, two
runner modes:

- **The fast lane** needs no provider, no Switch Console and no LLM key. The
  harness plays every participant over plain HTTP: it registers throwaway
  agents, creates rooms, posts as agents and as a Mattermost human, and asserts
  on what arrives. It carries no secrets a fork lacks, so it can gate pull
  requests.
- **The provider lane** needs a real agent session (Switch Console or its
  sidecar) attending the room, and checks what that session does: answering,
  asking a question, asking for approval, being interrupted.

Nothing here talks to Switch Console directly. If a scenario passes, an operator
doing the same thing by hand would have seen the same result.

## Running it

The fast lane against a throwaway stack built from this checkout (fresh
Postgres and Mattermost, migrations, switch-core on the host), torn down
afterwards. Needs Docker, `uv`, `jq`, and your local stack stopped:

```bash
just e2e-fast                       # from the repo root
just e2e-fast --keep                # leave the stack running afterwards
just e2e-fast -- -t mattermost      # arguments after -- go to vitest
```

Its log, JUnit report and the stack's per-run secrets go to `build/e2e/ephemeral/`.
The repository's own `.env` is never read or written.

Against a stack you already have, set the configuration below and run vitest
from this directory:

```bash
SWITCH_E2E_LANE=fast pnpm test
SWITCH_E2E_LANE=provider pnpm test
```

With `SWITCH_E2E_LANE` unset every end-to-end scenario is skipped, which is
what `pnpm -r test` and PR CI see. The unit tests (configuration, the read-only
guard, naming, scenario headers) run either way.

Housekeeping after an interrupted run deletes every `e2e-*` agent and room on
the Switch server and archives every `e2e-*` Mattermost channel older than the
age you give, and nothing else. The age floor is what lets a scheduled wipe of a
deployed environment run while a suite is in progress; make it longer than the
longest run. `0` takes everything, which is only right when nothing else is
running against the server:

```bash
SWITCH_E2E_LANE=fast pnpm cleanup --older-than 120
```

Typecheck: `pnpm typecheck`.

## Layout

| Path | What it holds |
| --- | --- |
| `src/core/` | Configuration, run naming, the read-only guard, scenario headers and admission, lane resolution |
| `src/clients/` | The Switch and Mattermost HTTP clients |
| `src/fixtures/` | Throwaway agents and rooms for a scenario, the bridge-readiness probe, teardown |
| `src/fast/` | Fast-lane scenarios, one file per area, listed in `index.ts` |
| `src/provider/` | The provider lane: Console credential files, the shared agent and channel, the scenarios, `seed.ts` |
| `scripts/ephemeral-stack.sh` | The throwaway-stack runner behind `just e2e-fast` |

## Scenarios and their headers

Every scenario, in either lane, carries a header:

```ts
{
  id: 'addressed-delivery',                 // kebab-case, unique across both lanes
  covers: ['POST /agents/{agent_id}/message', 'list_rooms'],
  needsProvider: false,                     // true puts it in the provider lane
  environments: ['ephemeral', 'local', 'dev', 'staging'],
  owner: 'platform',                        // a team or role, never a person
  requires: ['mattermost'],                 // what must be configured
}
```

`covers` names agent operations from the registry
(`core/switch_core/bridges/agent/operations/definitions.py`) and HTTP routes
as `METHOD /path/{param}`, with the server's own parameter names. It is what a
coverage gate reads, without running anything. Headers are validated by a unit
test, so a malformed one fails `pnpm test`.

A scenario runs when its lane is the one asked for, the target environment is
in `environments`, and its `requires` are configured. Otherwise it shows as
**skipped, with the reason**, never as passed. Under `SWITCH_E2E_STRICT=1` (how
`just e2e-fast` and CI run) a missing prerequisite, missing configuration or an
unreachable server **fails** the run instead, so a job that ran nothing cannot
go green.

A scenario that changes server-global state (a feature flag, say) lists only
`ephemeral`. One that writes anything never lists `prod`.

### Fast lane

Plain code. A scenario gets fixtures that create agents and rooms under names
unique to the run and the scenario, and removes them afterwards whether it
passed or not. A teardown that leaves something behind fails the scenario.

| Scenario | What it drives | Needs |
| --- | --- | --- |
| `addressed-delivery` | One agent addresses another in a room with no bridge; the recipient's notification carries the room, the sender and the addressed flag. | — |
| `unaddressed-history` | Five unaddressed messages arrive in the recipient's room history in the order sent, and none of them as a notification. | — |
| `operations-front-door` | The operations registry over HTTP: it lists the operations, `list_rooms` returns the room, `read_context` returns a message posted in it. | — |
| `mattermost-roundtrip` | A room on the Mattermost bridge: an addressed post from the human reaches the agent, and the agent's reply appears as its bot. | Mattermost |

If `mattermost-roundtrip` passes and a provider-lane scenario fails, the fault
is in the agent session, not in Switch, the bridge or the harness.

## Naming, isolation and the read-only guard

Everything the harness creates is named `e2e-<runId><scope>-<role>`: the run,
a letter per scenario, then what the thing is for (`e2e-k3x9q2a-snd`). Names go
through one helper, so no scenario builds a raw name, and the helper refuses a
name too long for a Mattermost bot username (22 characters) rather than letting
bot creation fail quietly on the bridge.

The harness's agents are created owner-only, like every agent, and the
fixtures open their addressing through the gateway: their senders are other
throwaway agents and an unclaimed Mattermost user, whose messages would
otherwise be refused rather than delivered.

With `SWITCH_E2E_ENVIRONMENT=prod` the clients refuse every request but reads
and logging in before it leaves the process, so a wrong base URL fails a test
rather than writing to production.

## Configuration

Values come from the process environment, falling back to a **gitignored `.env`**
beside this file. Never commit one. `just e2e-fast` sets all of them itself.

| Variable | Required | Meaning |
| --- | --- | --- |
| `SWITCH_E2E_LANE` | to run anything | `fast` or `provider`. Unset, every end-to-end scenario skips. |
| `SWITCH_E2E_ENVIRONMENT` | yes | `ephemeral`, `local`, `dev`, `staging` or `prod`. Decides which scenarios run, and makes `prod` read-only. |
| `SWITCH_API_URL` | yes | Switch origin — serves both `/agents/…` and `/gateway/…`. |
| `SWITCH_GATEWAY_ADMIN_EMAIL` | yes | Gateway admin account. |
| `SWITCH_GATEWAY_ADMIN_PASSWORD` | yes | Its password. |
| `SWITCH_AGENT_REGISTRATION_TOKEN` | yes | Registration API key; mints the throwaway agents. |
| `MATTERMOST_URL` | for Mattermost scenarios | Mattermost origin. |
| `MATTERMOST_TOKEN` | for Mattermost scenarios | Token of the **human** the harness posts as (a personal access token, or a login session token). |
| `MATTERMOST_TEAM` | for Mattermost scenarios | Team **slug** (e.g. `switch`), not its display name. |
| `SWITCH_E2E_STRICT` | no | `1` turns every "cannot run" into a failure. CI sets it. |
| `SWITCH_E2E_KEEP` | no | `1` leaves agents, rooms and channels behind for inspection. |
| `SWITCH_E2E_AGENT_DIR` | provider lane | Working directory of the session under test. When set, the agent's credentials are written into it (see below) and it is sent to Switch as the agent's `repo_dir`. |
| `SWITCH_E2E_MANIFEST` | provider lane | File the setup records its agent and room in, so a second process can reuse them. See "Seeding first". |
| `SWITCH_E2E_REPLY_TIMEOUT_MS` | provider lane | How long a scenario waits for the agent (default 5 min). |
| `SWITCH_E2E_SESSION_TIMEOUT_MS` | provider lane | How long setup waits for a live session (default 2 min). |
| `SWITCH_E2E_AGENT_TYPE` | provider lane | `opencode` (default), `claude-code`, `codex`, `antigravity` or `cursor` — which provider's runtime is under test. |
| `SWITCH_E2E_QUESTION_MODE` | provider lane | `numbered` (default) or `prose`; see the `question` row below. |
| `SWITCH_E2E_CONTROLLER_ID` | provider lane | An agent controller to run the agent on. `just e2e-provider` sets it. Unset, a Switch Console session is expected instead. |
| `SWITCH_E2E_PROVIDER_ENV_FILE` | `just e2e-provider` | A file of provider keys, handed to the controller as `--env-file`. Leave it unset to use the CLI's own sign-in. |

Mattermost is all or nothing: none of its three variables means "no Mattermost
here"; some of them is reported as a mistake.

# The provider lane

The provider lane needs Mattermost and something that runs a real session for
the agent it registers. There are two ways to provide one.

## On a headless agent controller (`just e2e-provider`)

The unattended way, and the one CI will use. `just e2e-provider` does
everything `just e2e-fast` does, and also:

1. turns on `agent_management` and sets `CONTROLLER_TOKEN_SECRET` for the stack;
2. builds `console/packages` and starts the agent controller
   (`console/packages/agent-controller`) on the host. Its credential comes from
   `POST /gateway/management/controllers` and goes in on stdin, never to disk;
3. runs the provider lane with `SWITCH_E2E_CONTROLLER_ID` set. Setup then
   registers the agent with a registration key the admin mints for the purpose
   and deletes straight away, because the management API only places agents
   their caller owns, and the deployment-wide key registers agents to a
   bootstrap account. Setup places the agent on the controller with
   `auto_approve: false`, retrying while the controller reports itself not
   ready, and writes no Switch Console files.

```bash
SWITCH_E2E_AGENT_TYPE=claude-code just e2e-provider
SWITCH_E2E_PROVIDER_ENV_FILE=~/e2e-keys.env just e2e-provider   # an API key instead of a signed-in CLI
```

The provider CLI (`claude`, `opencode`, …) must be installed and signed in for
the user running it, or its key must be in the file `SWITCH_E2E_PROVIDER_ENV_FILE`
names, which the controller gets as `--env-file`. Sessions only inherit the
variables on the allow-list in
`console/packages/agent-providers/src/host/agent-env.ts`. `node
console/packages/agent-controller/dist/cli.mjs doctor` shows what the controller
sees. A run spends real model calls.

Two things differ from a Console session:
- **The agent's own key stops working.** While a controller acts for an agent,
  the server refuses requests made with the agent's own key. So the
  bridge-readiness probe reads the room through a silent second agent, the
  *witness*, and teardown deletes agents by name as the admin.
- **`live` comes early.** Switch reports the agent `live` as soon as the
  controller is connected, before any session exists. The first scenario
  therefore absorbs the session's start-up time.

The controller's log goes to `build/e2e/ephemeral/controller.log`.

## With a Switch Console session

The provider lane can also run against a **Switch Console session for the agent
it just registered**. Setup polls the agent's status in the room and refuses to run the
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
(the SDK's `agent` option) and Claude Code fails a session that names an agent it
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

`src/provider/seed.ts` is the first of them. It does exactly what `beforeAll` does —
register the agent, create the room and channel, write the credentials — and
records the result in `SWITCH_E2E_MANIFEST`, above all the agent's API key,
which registration returns exactly once:

```bash
SWITCH_E2E_LANE=provider SWITCH_E2E_MANIFEST=/tmp/e2e.json SWITCH_E2E_AGENT_DIR=/tmp/e2e-work \
  node --experimental-strip-types src/provider/seed.ts
# add the agent to the console's database, pointed at that working directory,
# with provider_config {"version":"2","providerId":"opencode","values":{}};
# start Switch Console
SWITCH_E2E_LANE=provider SWITCH_E2E_MANIFEST=/tmp/e2e.json SWITCH_E2E_AGENT_DIR=/tmp/e2e-work \
  pnpm test src/provider
```

For Claude Code, add `SWITCH_E2E_AGENT_TYPE=claude-code` to both commands and
give the database row `provider_id` `'claude'` with
`{"version":"2","providerId":"claude","values":{}}`. The
row's `name` must be the Switch agent's name, because that name is also the
definition the session is launched as.

For Codex, use `SWITCH_E2E_AGENT_TYPE=codex` and `SWITCH_E2E_QUESTION_MODE=prose`,
with `provider_id` and `providerId` both `codex`. The normal Codex mode does
not expose its native question tool; the prose scenario verifies the room
round trip without claiming to test a native question card. Codex may request
approval to read the Switch skill on first launch; answer it in Console or
the room before the greeting proceeds.

Setup finds the manifest, reuses what is in it rather than registering a second
agent, and deletes it during teardown — so a manifest never outlives its room.

## The provider scenarios

| Scenario | What it drives | Passes when |
| --- | --- | --- |
| `greet` | An addressed message reaches a session and its answer comes back. | The bot posts `SWITCH_E2E_OK`. |
| `question` | Two turns: the agent asks, the human answers in the channel, the agent uses the answer. | The bot offers `red`/`green`/`blue`, then replies `green` after the answer. |
| `approval` | A tool call the session is not pre-authorised to make. | The bot posts an approval card, answering it with `<handle> 1` allows the call, the bot replies `done`. |
| `interrupt` | `!interrupt @agent-name` cancels a running local shell command after its start marker is verified. | No completion marker appears after the command’s 90-second lifetime (observed for 95 seconds). Requires `SWITCH_E2E_AGENT_DIR` on this machine. |

`question` is the one a one-shot reply cannot fake: it only passes if the session
is still alive and still connected when the second message arrives.

It has two modes, because the relay it exercises needs a native ask-the-user
tool and not every provider offers one. In `numbered` mode the agent must use
that tool, and Switch relays it into the room as a request card numbering the
options (`… request \`A1\` … 2. green …`). The answer goes back as `A1 2`, a
plain message naming the card's handle, and the card is what proves the relay
path was taken. In `prose` mode the agent asks in an ordinary message and is answered
with `@agent green`; the two-turn round trip is still proved, the relay is not.
Every agent type defaults to `numbered` — both providers offer the tool — and
`prose` is an explicit override for a provider or CLI version that does not.

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
PUT    /gateway/agents/{id}/addressing-policy  {"policy": null} -> anyone may address it
POST   /gateway/rooms with internal_only: true and no bridge_id -> a room with no channel
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
GET  /agents/{id}/ops                             -> {"operations": {<name>: {…}, …}}  the registry, keyed by name
POST /agents/{id}/ops/{operation}                 body = the operation's arguments
     -> {"result": …}. Operations that act on "the room you are connected to"
        need a live connection; those taking the room as an argument do not.
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
  `[a-z0-9._-]` — because they become bot usernames. The naming helper
  (`src/core/run.ts`) enforces it.

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
are listed in `NO_SESSION_MARKERS` (`src/provider/scenarios.ts`), never count as a match,
and are reported as "no live Switch Console session" rather than as a timeout.
Keep that list in step with the wording in
`core/switch_core/gateway/known_agents.py` and
`core/switch_core/bridges/agent/commands.py`.

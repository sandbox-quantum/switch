# Multi-surface demo — walkthrough

One linear path from a clean checkout to a working demo: a single Claude Code
session that is one agent in a Slack channel *and* at an email address, holding
one context across both.

Covers **US-1, US-2, US-6**, and **US-4 in its advisory form**. Does **not**
cover US-3 or US-5 — see *What this does not show*.

Each step says what success looks like. **Stop at the first failure**: later
steps will not be interpretable. Steps are marked **[verified]** where these
exact commands have been run against a real stack, **[untried]** where they have
not.

Reference — component map, every known snag, teardown — is at the end.

---

## Before you start

- Docker running
- `uv`, `just`
- `pnpm` (Node 25 dropped corepack: `npm i -g corepack && corepack enable`)
- A Slack app you control, in a workspace you do not mind touching
- One saved email as `sample.eml` (any client: *Show original* / *View source*),
  with **your own address** in `From:`

---

## Step 1 — build the client  **[verified]**

The connector fetches a *published* runtime by default and every client change
here is unpublished. Build the local one now; Step 5 points the session at it.

```bash
cd console
pnpm install
pnpm -r --filter './packages/**' run build
```

✅ Four packages build; `packages/switch-agent-runtime/dist/bin.mjs` exists.

> If you previously installed with `--ignore-scripts`, Electron's binary was
> never downloaded: `rm -rf node_modules/electron && pnpm install`.

Optional, cheap:

```bash
pnpm --filter @sandboxaq/switch-agent-runtime exec vitest run src/
pnpm --filter @switch-console/desktop exec vitest run --project node --project main-db
```

✅ 196 and ~3055 passing. One unrelated failure in
`sidecar/session-spawner.test.ts` on some machines.

---

## Step 2 — start Switch  **[verified in host mode, untried standalone]**

```bash
cd ..
just init-env          # skips if .env exists; sets SWITCH_VERSION
just standalone-up     # everything in Docker, built from the working tree
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/health
```

✅ `200`. Dashboard on <http://127.0.0.1:3000>, credentials from
`GATEWAY_ADMIN_EMAIL` / `GATEWAY_ADMIN_PASSWORD` in `.env`.

No migration step — `switch_core.main` runs `alembic upgrade head` on boot.

❌ Container exits →
`docker compose -f deploy/local/standalone-docker-compose.yml --project-directory . logs switch`

> **Alternative — host mode.** `just up && just migrate && just run` runs only
> the dependencies in Docker with switch-core on your machine. Faster for
> iterating on server code. Everything below is identical.

---

## Step 3 — register an agent  **[verified]**

```bash
TOKEN=$(grep AGENT_REGISTRATION_TOKEN .env | cut -d= -f2)
curl -s -X POST http://127.0.0.1:8000/agents \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
    "name":"atlas","description":"multi-surface demo","connector_type":"claude_code",
    "integration_profile":{"connection_model":"always_on","message_exchange":true,
      "pre_invocation_mediation":[],"post_invocation_mediation":[],"event_reporting":[],
      "task_protocol":{"can_delegate":false,"can_accept":false}}}'
```

✅ `{"id":"…","api_key":"…"}`. **Save both** — the key is shown once.

```bash
export AID=<id> KEY=<api_key>
```

---

## Step 4 — prove the protocol, with no session  **[verified]**

The cheapest proof that one connection can hold two rooms. No runtime, no Slack,
no email — so a failure here is unambiguously server-side.

**Two internal rooms:**

```bash
for n in alpha beta; do
  curl -s -X POST "http://127.0.0.1:8000/agents/$AID/ops/create_room" \
    -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
    -d "{\"name\":\"t-$n\",\"description\":\"$n\",\"agent_names\":[\"atlas\"],\"internal_only\":true}"
done
export A=<alpha room id> B=<beta room id>
```

**Open a `multi` stream and start beating within 6 seconds** — the connection
TTL is 6s and a `curl` harness must send its own heartbeats:

```bash
curl -sN -H "Authorization: Bearer $KEY" -H 'Accept: text/event-stream' \
  "http://127.0.0.1:8000/agents/$AID/events?connection_id=t&scope=multi&filter=all&rooms=$A,$B&protocol=1" \
  > /tmp/t.log 2>&1 &
( while sleep 2; do curl -s -o /dev/null -X POST \
    "http://127.0.0.1:8000/agents/$AID/connection/beat" -H "Authorization: Bearer $KEY" \
    -H 'Content-Type: application/json' -d '{"connection_id":"t"}'; done ) >/dev/null 2>&1 &
sleep 3; head -2 /tmp/t.log
```

✅ `connection_state` with `"scope":"multi"` and **both** room ids in `rooms`.

**One success, two refusals:**

```bash
# routes to alpha
curl -s -X POST "http://127.0.0.1:8000/agents/$AID/ops/post_message" -H "Authorization: Bearer $KEY" \
  -H "X-Switch-Connection-Id: t" -H 'Content-Type: application/json' \
  -d "{\"body\":\"into alpha\",\"room_id\":\"$A\"}"

# refuses: ambiguous
curl -s -X POST "http://127.0.0.1:8000/agents/$AID/ops/post_message" -H "Authorization: Bearer $KEY" \
  -H "X-Switch-Connection-Id: t" -H 'Content-Type: application/json' -d '{"body":"where?"}'

# refuses: room not held
curl -s -X POST "http://127.0.0.1:8000/agents/$AID/ops/post_message" -H "Authorization: Bearer $KEY" \
  -H "X-Switch-Connection-Id: t" -H 'Content-Type: application/json' \
  -d '{"body":"nope","room_id":"00000000-0000-0000-0000-000000000000"}'
```

✅ an `event_id`; then *"covers several rooms … pass room_id explicitly"*; then
*"Not connected to room 000…"*.

**Leave this stream and its heartbeat running** — Step 6 needs a second speaker,
because an agent's own messages are not delivered back to it.

---

## Step 5 — point a session at the local runtime  **[untried]**

⚠️ **The step most likely to go wrong, with the most misleading failure.**
`connectors/claude-code-plugin/.mcp.json` pins
`npx @sandboxaq/switch-agent-runtime@0.3.3` from npm. Every client change here
is in local **0.6.0**, unpublished. A stock install runs 0.3.3 — no
`SWITCH_SCOPE`, no room set — and Step 6 fails looking like a server bug.

Configure the session's MCP server as:

```json
{
  "mcpServers": {
    "switch": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/console/packages/switch-agent-runtime/dist/bin.mjs"],
      "env": {
        "SWITCH_SCOPE": "multi",
        "SWITCH_API_ENDPOINT": "http://127.0.0.1:8000",
        "SWITCH_AGENT_ID": "<AID>",
        "SWITCH_API_KEY": "<KEY>"
      }
    }
  }
}
```

Start a Claude Code session in any directory.

✅ Session stderr carries `switch:` lines.
❌ No `switch:` lines at all → you are on the npm build. A *bad* scope value
exits immediately with *"SWITCH_SCOPE must be 'single' or 'multi'"* — that is
how you tell the two apart.

---

## Step 6 — a session holds two rooms  **[untried — the point of all this]**

In the session:

1. `connect_to_room` for room **alpha**
2. `connect_to_room` for room **beta**

✅ Both rooms in stderr and in `connection_state`.
❌ The second replaces the first → `SWITCH_SCOPE` is not `multi`, or you are on
the npm build (Step 5).

Now use Step 4's still-running connection as the second speaker:

```bash
curl -s -X POST "http://127.0.0.1:8000/agents/$AID/ops/post_message" -H "Authorization: Bearer $KEY" \
  -H "X-Switch-Connection-Id: t" -H 'Content-Type: application/json' \
  -d "{\"body\":\"@atlas what is in alpha?\",\"room_id\":\"$A\"}"
```

…and the same for `$B`.

✅ The session is notified of **both**, on one connection, each tagged with its
room, and replies into the right one.

**This is the whole design working.** Everything after is presentation.

---

## Step 7 — Slack  **[untried]**

### 7a. The app

At <https://api.slack.com/apps> → your app:

- **Socket Mode → Enable.** This is why no public URL is needed.
- **Basic Information → App-Level Tokens** → generate one with
  `connections:write`. Copy the `xapp-…`.
- **OAuth & Permissions → Bot Token Scopes**, at least:
  `chat:write`, `chat:write.customize`, `channels:read`, `channels:history`,
  `groups:read`, `groups:history`, `im:read`, `im:write`, `im:history`,
  `users:read`, `reactions:read`, `reactions:write`, `files:read`, `files:write`
- **Reinstall to workspace** if you changed scopes, *then* copy the **Bot User
  OAuth Token** (`xoxb-…`) — reinstalling re-issues it.

Workspace id:

```bash
curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" https://slack.com/api/auth.test
```

✅ `"team_id":"T…"` — that is `workspace_id`.

### 7b. Register the bridge

Dashboard (<http://127.0.0.1:3000> → Collaborations), or by API:

Put the tokens in `.env` rather than on the command line — it is already
gitignored, and an inline token ends up in your shell history:

```bash
cat >> .env <<'EOF'
SLACK_BOT_TOKEN=xoxb-…
SLACK_APP_TOKEN=xapp-…
SLACK_WORKSPACE_ID=T…
EOF
set -a; source .env; set +a
```

```bash
curl -s -c /tmp/gw.txt -X POST http://127.0.0.1:8000/gateway/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$GATEWAY_ADMIN_EMAIL\",\"password\":\"$GATEWAY_ADMIN_PASSWORD\"}"

curl -s -b /tmp/gw.txt -X POST http://127.0.0.1:8000/gateway/collaborations \
  -H 'Content-Type: application/json' -d "{
    \"bridge_type\":\"slack\",\"display_name\":\"Demo Slack\",
    \"connection_config\":{\"bot_token\":\"$SLACK_BOT_TOKEN\",
      \"app_token\":\"$SLACK_APP_TOKEN\",
      \"workspace_id\":\"$SLACK_WORKSPACE_ID\",\"agent_usergroups\":false}}"
```

`agent_usergroups: false` deliberately — it mints a Slack user group per agent,
needs a paid plan, and leaves workspace-visible residue.

✅ A bridge id. Credentials are verified at registration, so a bad token fails
here in Slack's own words rather than silently later.

### 7c. A channel

- `/invite @yourapp` in one channel
- ✅ A Switch room auto-creates, named after the channel
- **Add `atlas` to that room** (dashboard → the room → add agent)
- Post in the channel; ✅ it reaches the session

⚠️ A message in **any** channel the app is already in auto-creates a room. Use a
quiet channel, or a scratch workspace.

---

## Step 8 — email  **[untried]**

### 8a. Expose the port

The bridge listens *inside* the container and standalone maps only
8000/3000/8065/5432. Save `deploy/local/standalone-email.override.yml`:

```yaml
services:
  switch:
    ports:
      - "127.0.0.1:8099:8099"
```

Restart with it appended:

```bash
docker compose -f deploy/local/standalone-docker-compose.yml \
  -f deploy/local/standalone-docker-compose.build.yml \
  -f deploy/local/standalone-email.override.yml \
  --profile collab --profile gateway --project-directory . up -d --build
```

*(Host mode: skip — the adapter binds on your machine.)*

### 8b. Register the bridge

```bash
curl -s -b /tmp/gw.txt -X POST http://127.0.0.1:8000/gateway/collaborations \
  -H 'Content-Type: application/json' -d '{
    "bridge_type":"email","display_name":"Demo Email",
    "connection_config":{"listen_port":8099,
      "agent_address":"atlas@agents.example.com",
      "allowed_senders":["you@yourdomain.com"]}}'
```

`agent_address` routes nothing in this mode — it is what outbound *would* send
as. `allowed_senders` is the only gate: **your address only**.

### 8c. Read the minted secret

Displayed nowhere, by design:

```bash
docker exec "$(docker ps -qf name=postgres)" sh -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -c "select connection_config from collaboration_bridges where type='"'"'email'"'"';"'
```

### 8d. Deliver a message

```bash
curl --data-binary @sample.eml -H 'Content-Type: message/rfc822' \
  http://127.0.0.1:8099/inbound/<SECRET>
```

✅ `202`, and a room appears named after your address.
**Add `atlas` to it** — auto-created email rooms resolve no agents, and the
bridge logs a notice saying so.

❌ Nothing appears → check the switch logs for a refusal naming the sender (not
allowlisted) or a loop marker.

### 8e. Reconnect

In the session: `connect_to_room` for the **Slack** room and the **email** room.

---

## Step 9 — the demo

1. **Forward an email** from your phone with no note — or `curl` a second `.eml`.
2. **In Slack, ask about it.** "What did they want?" Never paste it, never name
   it. *This is US-1 and US-2, and it is the whole demo.*
3. **A colleague asks a follow-up** in the same channel. Same agent, same
   context, someone else's question.
4. **US-6:** `curl` an `.eml` from an address not on the allowlist. Nothing
   appears; the log names the refusal.
5. **US-4, carefully:** tell the agent something in a Slack DM, then ask about
   the subject in the channel. It answers usefully without quoting you — then
   say the first sentence below.

## Say these out loud

- **US-4 is advisory.** The agent is *told* who can read each room and what may
  be repeated; **nothing enforces it**. You are seeing a model being discreet
  because it was asked to, not a system preventing a leak. The enforcement is
  written (`disclosure.py`) and wired to nothing.
- **The allowlist is a config list**, not claimed identities. "It knows it's me"
  is really "an operator listed this address".
- **No outsider can be answered.** Inbound only.

## What this does not show

- **US-3** — the agent waking itself. Needs `MultiRoomHost`, schedule
  persistence and a launcher.
- **US-5** — answering an outsider. Needs outbound email, which does not exist.
- Real mail delivery, unless you add a provider.

---

# Reference

## The components

```
  sample.eml ──curl──▶ email bridge ─┐
                    (inside switch-core,
                     port 8099, mapped out)
                                      ├─▶ Matrix room (auto-created; the agent
                                      │   must be ADDED — it resolves none)
  Slack ◀──socket mode──▶ Slack bridge ┘
        (outbound WebSocket,           │
         no public URL)                ▼
                        one `multi` connection, both rooms
                                       ▼
                     Claude Code session + dist/bin.mjs
                              = THE AGENT
                                       │
                        post_message(room_id=…) back out
```

Two things are routinely conflated: **the bridges are not services** — they run
inside switch-core — and **the agent is not a daemon**, it is the session.

## Known snags

| Symptom | Cause |
|---|---|
| Second `connect_to_room` replaces the first | `SWITCH_SCOPE` not `multi`, **or the npm-pinned 0.3.3 is running**. No `switch:` scope line on stderr means the latter. |
| Session sees nothing after it posts | An agent's own messages are not delivered back to it. Use a second speaker. |
| `Not connected to a room` with a valid `room_id` | The caller has no connection. A room id is an argument, not a permission. |
| Email room exists, agent never answers | Auto-created email rooms resolve no agents. Add it. |
| Every forwarded mail dropped | Check the log for a loop marker. `Auto-Submitted: auto-forwarded` is exempt; a list header *plus* a bulk `Precedence` is not. |
| `connection … is not open` | 6s heartbeat TTL. A session handles this; a `curl` harness must beat. |
| Slack asks for a public request URL | You want Socket Mode and an app-level token, not Event Subscriptions. |
| Rooms appear for channels you did not expect | Any message in any channel the app is in auto-creates one. |

## Teardown

**Branch** — `main` is untouched, nothing pushed:

```bash
git checkout main && git branch -D feat/multi-surface-agent
```

**On disk** (gitignored; `console/node_modules` ~1.1G, `core/.venv` ~242M):

```bash
rm -f .env && rm -rf core/.venv && git clean -xdf console
```

**Docker** — match the stack you started. `reset` takes every agent, room and
Matrix account with it.

```bash
just standalone-down      # or: just down
just standalone-reset     # or: just reset — prompts first
docker rmi switch-setup:latest jevolk/tuwunel:v1.7.1 \
           mattermost/mattermost-team-edition:latest
```

**Not repo-local** — making `pnpm` available installs corepack globally:

```bash
corepack disable && npm uninstall -g corepack && rm -rf ~/.cache/node/corepack
```

Nothing here is destructive on the way in: `just init-env` refuses to overwrite
an existing `.env`, and no step touches `main`.

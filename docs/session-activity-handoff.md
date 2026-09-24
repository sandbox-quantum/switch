# Session activity: handoff

Branch `work/session-activity-model`, stacked on PR #528 (single inbound
stream per agent). Nothing here is merged or released.

## Why

In 0.27.0 switch-core became the owner of agents' coding sessions: it stores
each session's whole transcript as one JSON value (`sdk_sessions.snapshot`)
and re-parses (and on events, rewrites) it on every host event, every command
poll, every session-list call and every Slack publisher pass. Clients poll hard
(Console: command check every 250 ms per session, session list every 2 s per
linked agent, transcript every 500 ms). Under load the single switch-core
process spends its time in pydantic, holds pooled connections idle-in-
transaction, exhausts the pool, heartbeats lapse and agents reconnect in a
storm. The database itself stays mostly idle.

## Target design

- **Switch Console (or the remote sidecar) owns the session**: transcript,
  provider state, recovery, routing events to local sessions.
- **switch-core relays**: room messages, small activity events, approval
  requests. It never holds a transcript. ("Sessions are not a server concept",
  `docs/old/api/AGENT_PROTOCOL.md` §2.5.)
- **Transport**: one SSE stream per agent down (room messages, approval
  outcomes, commands); HTTP up (messages, activity, approval requests). No
  polling.
- **Push, not scan**: changes to the new tables are announced by Postgres
  `NOTIFY` triggers carrying the row, fanned out in-process to subscribers
  (agent stream, bridges). Same mechanism as room messages.
- **Every messaging platform** renders the same neutral model through
  `CollaborationAdapter` (`post_rich` / `update_rich` / `find_request_card`).
- **Who may answer an approval = who may address the agent** (the agent's
  addressing policy, judged in the request's room; owner only when no room).

## Data model (switch-core)

All tenant-scoped with row-level security; one migration,
`core/switch_core/migrations/versions/545f80e11f13_…`.

| Table | Purpose |
|---|---|
| `approval_requests` | A request a session waits on: `kind` approval/questions, `turn_id`, `title`, `detail`, `options` `[{id,label,decision}]` (approvals), `questions` (questions), `state` open/answered/expired/closed, `expires_at`, `answer` (approvals) or `answers` (questions), `answered_by` (`mxid` or `user:<id>`), `delivered_at` (null = still owed to the agent) |
| `session_activity_items` | One row per turn step (the turn itself, a message, a tool call, a notice), upserted by `revision`; see "Display parity" |
| `approval_request_posts` | Where a request's card is on a bridge: `token` (in button payloads), `handle` `A<n>` (typed answers), `external_post_id` (null until confirmed), `thread_ref`, `removed_at`, `unconfirmed_notice_at` |
| `turn_status_posts` | The message a turn is drawn in, per bridge: `external_post_id`, `thread_ref`, `reaction_message_ref`, `mark`, `attention_post_id` |

The session status line reuses the existing `agent_runtime_states` table
(working / awaiting-input / idle per agent and room) rather than a new one.

## Done (committed)

1. `0258ad8f4` — tables `approval_requests`, `session_activity_events`;
   `session_activity/service.py`, stores, host routes under `/agent-sessions`
   (`bridges/agent/api/activity_routes.py`), NOTIFY triggers
   (`db/session_activity_notify_ddl.py` + frozen copy in the migration, checked
   by `test_frozen_ddl_matches_create_all.py`), `session_activity/listener.py`
   wired into startup/shutdown/health.
2. `8026bcbec` — `session_activity/outcomes.py` + agent stream
   (`bridges/agent/protocol/stream.py`) pushes `approval_outcome` frames to the
   agent's watcher stream (scope `all`), sends everything undelivered on open
   and on listener resync; upkeep loop (`session_activity/maintenance.py`,
   expire every 5 s, prune activity >7 days hourly); answerer types
   `PlatformPerson(mxid)` / `SwitchUser(user_id)` with permission checks;
   gateway routes `GET /gateway/agent-sessions/approvals`,
   `POST /gateway/agent-sessions/{agent}/{session}/approvals/{request}/answer`
   (`gateway/agent_sessions.py`).
3. `db640435f` — agent-protocol revision 4 (`artifacts.yaml`, regenerated
   modules). `approval_outcome` is only sent to clients declaring `speaks >= 4`:
   runtimes ≤ 0.6.1 hand unknown frames to their room-event path and crash on a
   frame without `type`. switch-core speaks 4; agent-runtime still 3.

4. Step 4 — bridges render from the new tables (push):
   - Approval options carry `decision`; activity lines carry `thread_id`;
     tables `approval_request_posts` / `turn_status_posts`
     (`db/stores/session_activity_post_store.py`).
   - `session_activity/cards.py` turns a row into the renderers'
     `SnapshotRequest`/`RequestCard`, so every platform draws it unchanged
     (answerer shown as `DecidedBy`, with the platform handle when they
     answered on this bridge).
   - `session_activity/bridge_publisher.py` (`SessionActivityBridgePublisher`):
     one per bridge whose adapter `publishes_sdk_sessions`, subscribed to the
     listener for the bridge's tenant, with its own queue and task. Keys are
     coalesced while queued and handled by reading the rows as they are now.
     Cards: reserve `A<n>` handle + token (committed before the platform
     call, `external_post_id` null until confirmed), `post_rich`, thread via
     `BridgeMessageMap` (waits up to 5 s for the mapping, then channel root),
     `update_rich` on every later change, `find_request_card` for an
     unconfirmed post, never a repost. Turns: one `send_message` status per
     turn, then `update_message` ("**Working…** · N tool calls" + latest
     summary, "**Finished** …" at the end). Resync: every open request on the
     bridge, requests settled in the last 15 minutes that have a card, and
     every unfinished status message.
   - `session_activity/bridge_answers.py` (`ApprovalAnswers`): a press (token
     + option id or position) or typed answer (`A3 yes`, `A3 2`, bare yes/no
     as the first reply to the card) → `answer_approval(PlatformPerson(mxid))`;
     refusals reach the person via `tell_actor`. `BridgeCore` asks it first
     and falls through to the old path when it returns None. The typed-handle
     grammar accepts `A` as well as `R`.
   - Transition: `SessionPublisher.publish_pending` skips any session that
     has rows in `approval_requests` or `session_activity_events`, so a host
     reporting both ways does not get every card twice.
   - Wiring: `main.py` → `CollaborationBridgeLifecycleService` → `BridgeCore`
     (`session_activity_listener`, `session_activity_service`).
   - Not done: taking answered cards off the platform
     (`removes_answered_cards`), and the unconfirmed-card notice the old path
     posts. Teams and Telegram still lack `find_request_card`.

5. Step 5 — the host reports activity and approvals, and applies answers:
   - `console/packages/agent-providers/src/host/activity-reporter.ts` maps
     the session's own journal events to reports: `turn.upsert` running /
     terminal → `turn.started` / `turn.finished`; a tool item's first
     revision → `tool.called`, its first terminal status → `tool.finished`;
     `notice` → `notice` (attached to the running turn); approval
     `request.opened` → open; every `request.settled` → close (a question
     Switch never tracked answers NOT_FOUND, which is ignored). Line `seq` is
     `event.sequence * 2 + i`, so a replay is recorded once. Room and thread
     come from the origin of the command that started the turn
     (`HostedSession.originOf`; thread = origin thread, else the message).
     Progress is kept in `activity-reported.jsonl`; a session reporting for
     the first time starts at the end of its journal rather than replaying
     its history.
   - `shared-host.ts` sends them after each upload (`/agent-sessions`
     helpers alongside the `/sessions` ones). A server without the routes
     (404 with no code) turns reporting off with a warning; a refused line is
     logged and skipped.
   - Outcomes: the watcher's stream (`SwitchEventStream.onApprovalOutcome`,
     agent-protocol 4) wakes the worker through `approvals.wake`; the worker
     then reads `GET /agent-sessions/approvals/outcomes` (the server is the
     record, so the wake carries nothing), applies each of its own with
     `HostedSession.applyApprovalOutcome` (answer → the option's decision;
     expiry → `decline`, not `cancel`, which would interrupt the turn) and
     posts `/delivered`. It also reads once at start, and every 5 s while an
     approval is waiting, in case a wake was lost.
   - The runtime drops a frame without a string `type` instead of handing it
     to the room-event path, in both `event-stream.ts` and `bin.ts`.
   - agent-runtime speaks agent-protocol 4 and is 0.7.0 (`artifacts.yaml`,
     regenerated). **Not released**: tag `switch-agent-runtime-v0.7.0`.
   - The old `/sessions/events` upload is unchanged: the host gates work on
     its `session.upsert` receipt, and Console still reads transcripts
     through it.
   - Console polling: session discovery lists every 5 s (was 2 s) with one
     server read shared by every agent on the server per round, and doubles
     its wait after each failed round up to 60 s. The startup readiness loop
     backs off from 50 ms to 1 s, fails at once on 401/403, and logs any
     error other than the expected 404 instead of swallowing it.

6. Step 6 — Console reads transcripts from the host's journal:
   - `console/apps/switch-console-desktop/src/main/core/sdk-host/host-journal.ts`:
     `HostJournals` keeps one long-lived `node -e TAIL_SCRIPT` per open
     session, run through the agent's execution context (local, or its SSH
     host). The script tails `<sdk-sessions>/<sha256(id)>/events.jsonl`, and
     every 2 s reports whether the supervisor is alive and the last lease's
     `roomIds` / `retired`. `JournalTail.snapshot()` replays the journal the
     way `HostedSession` does (a reset's new epoch rebuilds the replica), and
     sets `connectivity` from the supervisor. A tail nobody has read for 60 s
     is closed.
   - RPCs `sdkHost.transcriptSource`, `journalSnapshot`, `journalEvents`
     (the last two keep `syncSdkSessionActivity`).
   - `hostJournalTransport(agentId, serverId)`: reads from the journal,
     while submit, reconcile, command status and attachments still go through
     Switch, the only place the host takes commands from.
     `SharedSessionPanel` asks `transcriptSource` once per client (and again
     when the host reports ready). It falls back to Switch when the journal
     is not on the agent's host, and shows a line saying why when the journal
     should have been readable but wasn't.
   - Known gap: host liveness reaches the open view only through the next
     snapshot, since there is no `session.connectivity` event in the journal.

## Step 7 — the server-side session layer is gone

Compatibility with deployed Consoles is waived (owner's call).

1. `0c099b57`: `SessionError` in `sessions/errors.py`.
2. `34789de7`: agent-protocol 5 `session_command` frame. It now carries only
   room controls (`!reset` and the like) from Switch to the watcher; Console
   no longer sends commands through Switch.
3. `3bf5184d`: the cutover. Hosts and the watcher no longer use
   `/sessions/*`. The watcher owns room routing (placed session if it runs
   here, else the latest assignment in its journal). The host builds room
   prompts itself (`room-prompt.ts`), fetches room attachments, reports
   activity and applies approval outcomes. Switch keeps session placement in
   memory only (`ConnectionRegistry.place_session` / `session_room` /
   `session_in_room` / `placements`), set by `connect_to_room`, and tags
   delivered events with the placed session's id.
4. `990fe3c9`: presence and occupancy from the registry only; room controls
   over `session_command`.
5. Direct IPC, no Switch and no file in between (`bd6e528a`, `b425df3f`):
   - Every session host is a child process of Console (a local session) or
     of the agent's sidecar (a remote one), spawned with a Node IPC channel.
     One process per session, so one crashing takes down nothing else.
     `host/session-channel.ts`: `SessionLinks` is the parent's end (request /
     reply, `ready`, and every recorded event pushed up); `serveParent` is the
     host's end.
   - The watcher hands room messages, approval wakes and room controls to
     hosts over `SessionLinks` (`askSession`). A room message waits on the
     host's acknowledgement and relaunches the host if it went away. The old
     handoff/drain files are gone; `handoff.ts` keeps only `HostWaker`.
   - Remote: the sidecar listens on a loopback port and writes
     `control.json` (`{port, token}`, mode 0600) to its state root
     (`host/control.ts`, `serveControl`). Console reads it over SSH and
     opens the port through the same SSH connection (`sidecar-control.ts`,
     `ControlClient`): session requests, `ensure`, and live event
     subscriptions.
   - Console: commands go straight to the host (`session-commands.ts`); the
     live transcript is pushed host → main → renderer (`transcripts.ts`). The
     journal file (`events.jsonl`) is read only to rebuild state after a
     restart and to show stopped sessions.
6. Removed from switch-core: `/sessions/*`, `/gateway/sessions/*`, the
   gateway command relay, `sessions/{service,publication,projection,
   validation,command_notifications}`, the old collaboration session modules
   (`outbound`, `inbound`, `transport`, `activity_journal`, `demo`), the old
   answer path and `session_request_post_store`. The refusal type the new
   answer path uses moved to `collaboration/session/refusal.py`. Kept:
   `contract.py`, `errors.py`, `http.py`, `normalise_mime_type`.
7. Room health for Console: `GET /gateway/agent-sessions/room-health`
   (the owner's agents' live connections and in-memory placements), and
   `POST /gateway/agent-sessions/{agent}/{session}/place` (`{roomId}`)
   behind "Reconnect to room".
8. Migration `b9e4d2a71c05` drops `session_activity_posts`,
   `session_request_posts`, `sdk_session_commands`, `sdk_session_events`,
   `sdk_room_admissions`, `sdk_sessions` and `media_blobs.sdk_session_id`
   (deleting the blobs uploaded into mirrored sessions). Its downgrade
   raises: the data cannot be rebuilt.

9. Idle sessions park. A host with a parent that has had nothing to do for
   `SWITCH_SESSION_PARK_AFTER_MS` (30 minutes by default, `off` to disable)
   records `parked` in `shared-state.jsonl` and exits. The idle check needs
   no turn running, no open request, no reset decision and no room message
   queued. It stops answering its parent first, so a request that arrives
   during the exit fails as unavailable and the sender starts it again. The
   watcher's next room message relaunches it (`deliver`); a Console command
   that finds it gone starts it with `hydrateSession` and sends again; the
   watcher's start-up `launchAssigned` skips parked sessions
   (`hostParked`).

### What is left

- End-to-end (`just bench`): the last run before the cleanup had 2 failures,
  competing controllers and two sessions taking one room. Rerun and fix.
- Known gaps: a session's role is freed only when the controller connection
  drops or the role is released; after a Core restart a session must
  `connect_to_room` again before room-scoped tool calls work; Console
  attachments have no path to the host; `publishes_sdk_sessions` on the
  adapters is now a misnomer (it means "draws activity and approval cards").

### Also required

- `CLAUDE.md`: agent-facing protocol changes must update all three connector
  skills (`connectors/*/skills/switch/SKILL.md`) — applies to steps 4–5.
- Tell the author of PR #528 before opening a PR against its branch.

## Notes for running tests

Store tests use testcontainers Postgres. If Docker is not found, set
`DOCKER_HOST` to your Docker socket (and `TESTCONTAINERS_RYUK_DISABLED=true`
if Ryuk cannot start).

## Display parity

Messaging platforms must show what they showed before the server-side session
layer went: each turn drawn step by step (tool calls with status, agent
messages, plan), question cards as well as approval cards, the working/queued
marker on the asking message, the "turn is stuck" notice, a working Stop
button, answered cards taken off the platform, and the notice for a card whose
delivery could not be confirmed. Only the mechanism changed: the host reports
small rows, and the bridge redraws from them with the existing renderers
(`bridges/collaboration/session/renderers/`). The deleted publisher
(`git show e36ffe1d~1:core/switch_core/bridges/collaboration/session/outbound.py`,
`.../sessions/publication.py`, `.../session/inbound.py`) is the reference for
behaviour; its tables do not come back.

Migration `545f80e11f13` is unreleased, so it is edited in place rather than
followed by another revision.

### Contract: host → Switch

`POST /agent-sessions/{session_id}/activity` — one row per turn step,
replacing the old activity lines. Upserted on
`(agent, session, turn_id, item_id)`; a row with a lower `revision` than the
stored one is ignored (`recorded: false`), an equal one is a no-op.

```
{
  "turn_id": str,
  "item_id": str,        // "turn" for the turn itself, "notice:<event sequence>" for a notice, else the item's id
  "kind": "turn" | "user-message" | "assistant-message" | "tool-activity" | "notice",
  "revision": int >= 0,  // turn: the host event sequence; item: item.revision; notice: 0
  "status": str,         // turn: queued|running|completed|interrupted|error
                         // item: in-progress|completed|failed|declined
                         // notice: info|warning|error
  "title": str,          // <= 500 chars, host truncates with "…"
  "text": str,           // <= 8000 chars, host truncates with "…"
  "command_id": str | null,   // turn rows only
  "room_id": str | null,      // from the turn's origin
  "thread_id": str | null,    // origin thread, else origin message
  "message_id": str | null,   // the message that asked (where the marker goes)
  "occurred_at": datetime
}
```

Table `session_activity_items` (replaces `session_activity_events`): the
fields above plus `created_at`/`updated_at`; primary key
`(tenant_id, agent_id, session_id, turn_id, item_id)`, which also serves as
the index for reading a turn. NOTIFY on insert/update carries
`agent_id, session_id, turn_id`. Pruned 7 days after `updated_at`.

`POST /agent-sessions/{session_id}/approvals` — a request a person can answer
(approval or questions):

```
{
  "request_id": str,
  "turn_id": str,
  "kind": "approval" | "questions",
  "title": str,                    // <= 500
  "detail": str | null,            // <= 4000
  "options": [{"id", "label", "decision"}],   // approval: >= 1; questions: []
  "questions": [{"id", "title", "prompt",
                 "options": [{"id", "label", "description"}],
                 "multi_select": bool, "allow_custom_answer": bool}],  // questions: >= 1; approval: []
  "room_id": str | null,
  "thread_id": str | null,
  "expires_at": datetime | null
}
```

`approval_requests` gains `turn_id`, `kind`, `title` (replacing `question`),
`detail`, `questions` (JSONB) and `answers` (JSONB, questions only:
`[{"question_id", "selected_option_ids", "custom_text"}]`). `answer` stays the
chosen option id for approvals. Outcomes (`approval_outcome` frame and
`GET /agent-sessions/approvals/outcomes`) carry `kind` and `answers` too; the
host applies a questions outcome as the request's answer.

### Platform notes

- `approval_request_posts` gains `removed_at` and `unconfirmed_notice_at`.
- `turn_status_posts` drops `tool_calls`/`finished` and gains
  `reaction_message_ref` (the asking message, as posted on this platform),
  `mark` (`queued` | `working` | null, what is on it now) and
  `attention_post_id` (the separate stuck-turn message, if any).

## Next: the watcher hosts the runtime (planned, owner agreed on direction)

Console (local) or the sidecar (remote) serves the Switch MCP runtime itself,
one per agent, in the watcher's process: streamable-HTTP MCP on
`127.0.0.1:<free port>/mcp`, one bearer token per session host (minted at
spawn, revoked on exit, passed as `SWITCH_RUNTIME_URL` / `SWITCH_RUNTIME_TOKEN`
in the host's env). No Node/npx needed on the machine. Every adapter already
maps an `HttpMcpServerSpec` (Claude `type:'http'`, Codex `url` +
`env_http_headers`/`bearer_token_env_var`, OpenCode `type:'remote'`, ACP
`type:'http'` when `mcpCapabilities.http`). Managed sessions run no plugin
hooks today (the Claude adapter disables the connector plugin), so the
python hook script only concerns standalone sessions.

- `switch-agent-runtime`: split `bin.ts` into a hostable `hosted.ts`
  (per-caller context instead of module constants) and the standalone binary.
- Watcher: `SessionPlacements` (room ↔ session, `placements.json` for
  restart only). `connect_to_room` is handled in-process: place locally,
  forward to Switch, roll back if refused. Routing is `sessionIn(room)`; the
  event `session_id` tag and `routePlaced` go.
- Host → watcher IPC gains `identity` (session, host, epoch; replaces the
  selector file) and `turn-end` (typing off).
- Switch: drop the event tag and the gateway `place` route; add
  `POST /agents/{id}/connection/placements` (full replacement, restated on
  reconnect) and a `room_released` frame for cross-machine takeover.
- Console "move session" goes to the watcher (control message `place` for
  remote).

Owner's decision (supersedes the transport above): Claude sessions get the
Switch tools and hooks in code through the Agent SDK (in-process MCP server
and hook callbacks), forwarded up the host's IPC pipe to the watcher. Codex,
OpenCode, Cursor and Antigravity get an MCP server hosted by the session host
itself on loopback (per-session token), passed to the CLI as a URL through its
SDK/launch config; Codex's experimental `dynamicTools` is not relied on. Both
front doors forward over the same pipe: host → watcher → Switch. The watcher
(Console or sidecar) stays the only thing talking to Switch and owns the room
map. No Node/npx and no credentials in the CLI's environment.

### Server side (done, uncommitted)

- Tables and the frozen NOTIFY DDL as above, edited into `545f80e11f13`.
  The trigger on `session_activity_items` announces
  `{tenant_id, agent_id, session_id, key: turn_id}` only; approval requests
  still ride with their row (or by key when too large).
- Routes: `POST /agent-sessions/{session}/activity` and `/approvals` take the
  bodies above. Outcomes (`GET /agent-sessions/approvals/outcomes`, camelCase
  outer keys) carry `kind` and `answers`, whose entries keep the stored
  snake_case keys. The `approval_outcome` frame keeps its snake_case outer
  keys (what `switch-agent-runtime`'s `event-stream.ts` reads) and gains
  `kind` and `answers`.
- Console: `POST /gateway/agent-sessions/{agent}/{session}/approvals/{request}/answer`
  takes `{"answer": "<option id>"}` for an approval or
  `{"answers": [{"questionId", "selectedOptionIds", "customText"}]}` for
  questions (exactly one). `GET /gateway/agent-sessions/approvals` returns
  `kind`, `turnId`, `title`, `detail`, `questions`, `answers`.
- `session_activity/bridge_publisher.py` draws each turn from its rows
  (`bridge_turns.py` builds the `TurnUpsert` / `Item`s) through the adapters'
  own `post_rich` / `update_rich`, with the stop control naming the session's
  running turn, the elapsed time, and the Console link; the queued/working
  marker; the attention message (`separate_attention_slot`); the frozen-stream
  notice; question cards; answered-card removal; the unconfirmed-card search
  or notice; and the "host offline" card state. A 5-second tick redraws
  running turns where the platform redraws for the clock, and anything whose
  agent went offline or came back.
- Stop: a press (`INTERRUPT_ACTION`) resolves its turn from
  `turn_status_posts`, is refused if that turn is no longer running, is
  judged by the agent's addressing policy in the room (as `!interrupt` is),
  and is relayed over the agent's stream as a `session_command`
  (`bridges/agent/commands.py`, `stop_control_frame`: epoch and turn
  `current`, origin `messageId` null).
- The adapters' "view activity" read-back (`set_activity_resolver`) answers
  from the same rows.
- `publishes_sdk_sessions` is now `draws_session_activity`.

### What the rows cannot say

- Elapsed time is measured on the server from the first step of a turn to be
  recorded to when its end was recorded (rows carry no start time), so a
  turn's queued-to-running gap before its first step is counted.
- The "stuck" notice covers a failed turn and an agent with no live
  connection. The old path also said so for an unacknowledged command and
  for a session in error; the rows carry neither.
- The person to mention on a stuck turn or a new card is the asking
  message's sender (looked up in `messages` by `message_id`), else the owner.
- A turn message's delivery is recorded only after the platform confirms it
  (no reservation token column), so a crash between the two posts it again.
  The frozen-stream notice is remembered in memory: a restart within the hour
  can repeat it.
- The stop control is drawn whenever a turn runs: the rows do not say
  whether the provider can be interrupted, so the host refuses it there.
- Notices (`kind: notice`) are stored but not drawn, as before.


Terminal sessions are dropped entirely (owner's call), Claude's included:
remove Console's PTY session path, its hook server, and the plugin hook
script's role in managed sessions. Each session host's MCP server listens on
`127.0.0.1:0` before the CLI is launched and passes the bound URL straight
into the CLI's launch config (no port files); a restart gets a fresh port and
token. Test: several concurrent sessions each reach their own server.

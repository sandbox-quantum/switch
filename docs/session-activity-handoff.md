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
| `approval_requests` | A question a session waits on: `question`, `options` `[{id,label,decision}]`, `state` open/answered/expired/closed, `expires_at`, `answer`, `answered_by` (`mxid` or `user:<id>`), `delivered_at` (null = still owed to the agent) |
| `session_activity_events` | Append-only short lines: `seq` (host's counter, idempotency key), `type` turn.started/tool.called/tool.finished/turn.finished/notice, `summary` (≤2000), `detail`, `room_id`, `thread_id`, `turn_id` |
| `approval_request_posts` | Where a request's card is on a bridge: `token` (in button payloads), `handle` `A<n>` (typed answers), `external_post_id` (null until confirmed), `thread_ref` |
| `turn_status_posts` | The one status message per turn per bridge: `external_post_id`, `thread_ref`, `tool_calls`, `finished` |

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

## What is left

### Step 7 — remove the server-side session layer

Compatibility with deployed Consoles is waived (owner's call), so this no
longer waits on a release. Commands from Console go through Switch as a relay
on the agent's stream (option A), not straight to the host.

What depends on the session tables today (mapped 2026-09-24):

- Server delivery of room messages does **not**: message → EventBuffer →
  the watcher's `all`-scope stream works with no session rows.
- What does: the room-owner decision (`/sessions/room-admission`, grants,
  reservations), turning a room message into a session command
  (`/sessions/{id}/room-message`: the server rebuilds the prompt from its own
  copy, wraps it in nonce markers, enforces per-room order, copies
  attachments), the command queue, lease/claim/recover/quiesce, the selector
  headers (`X-Switch-Session-*` → `session_binding` → the room a session's
  tool calls act in), role-lease liveness (`room_role_store._live` joins
  `SdkSession`), `agents_present_in` / `rooms_occupied` (discount stale claims
  of stopped sessions), room controls (`!reset` etc. → `submit_room_control`),
  the Slack stop button, and `media_blobs.sdk_session_id`.
- Console: discovery (`GET /gateway/sessions`), readiness polling, stop,
  retire, initial prompt, room health, reconnect-room, diagnostics.

Parts:

1. Done (`0c099b57`): `SessionError` in `sessions/errors.py`.
2. Done (`34789de7`): `POST /gateway/agent-sessions/{agent}/{session}/commands`
   relays an owner's command to the agent's watcher as a `session_command`
   frame (agent-protocol 5), stored nowhere; `HOST_OFFLINE` when no watcher
   speaking 5 is attached.
3. Done: the cutover. Hosts and the watcher no longer use `/sessions/*`.
   - Watcher (`shared-watcher.ts`): owner of a room = the session Switch
     says is placed in it (event field `session_id`, from `connect_to_room`)
     if that session runs here, else the latest assignment in its own
     journal; a dead owner is started again; with no owner it starts a
     session if allowed, otherwise holds the event (the journal keeps the
     event itself, content included, across restarts). Handoffs carry the
     event (`HANDOFF_PROTOCOL` 2). No admission, reservation, sweep or carry.
   - Host (`shared-host.ts`, rewritten): local epoch; no claim, renew,
     recover, quiesce, room binding, event upload or command fetch. Builds
     room prompts itself (`room-prompt.ts`: same nonce markers, unread
     notice, attachment refusals), fetches room attachments first through
     `/agents/{id}/rooms/{room}/media` (a missing one is named in the prompt
     instead of failing the turn), publishes its session selector at start,
     runs relayed commands, reports activity and applies approval outcomes.
   - Switch: `ConnectionRegistry.place_session` / `session_room` /
     `session_in_room` (memory only). `resolve_caller` takes the session id
     plus the connection; host/epoch headers are accepted and ignored.
     `connect_to_room` places the session. Delivered events carry the placed
     session's id. Session role leases are live while their connection is.
   - Console: discovery lists sessions from the agent's host
     (`host-sessions.ts`, one `node -e` per call, local or SSH); startup
     readiness reads the host journal; the chat view reads only the journal
     and says so when the host cannot be reached; stop/first prompt/commands
     go through the relay. Retire and attachment upload are gone from the
     chat view.
   - End-to-end harness (`core/tests/benchmarks`, `just bench`) adapted and
     passing: delivery, concurrency, lost host and worker, controller and
     Core restarts, competing controllers, upgrades, two sessions taking one
     room. Latency is measured push → provider dispatch.
   - Known regressions and gaps: a session's role is freed only when the
     agent's controller connection drops (or it is released), not when the
     session dies; after a Core restart a session must `connect_to_room`
     again before room-scoped tool calls work; with two controllers on two
     machines the winner answers a room with a new session of its own;
     Console attachments have no path to the host; the room-health and
     reconnect-room UI still call server routes that no longer know the
     sessions (removed with part 5); discovery reads each journal whole on
     every pass.
4. Server: presence and occupancy from the registry only (the host must
   release its room when a session stops), drop
   `require_recorded_rooms_unmoved` and the `SdkSession` lease arm, selector
   → an in-memory `session_rooms` map on the connection set by
   `connect_to_room`, room controls over `session_command`.
5. Delete `/sessions/*`, `/gateway/sessions/*`, `SessionAuthority`,
   `sessions/{service,publication,projection,validation,command_notifications}`,
   the old collaboration session modules and the old answer path, with their
   tests. Keep `contract.py` (renderers and cards use it), `errors.py`,
   `http.py`, `normalise_mime_type`.
6. Migration after `545f80e11f13`: drop `media_blobs.sdk_session_id` (and the
   `sdk-attachment:` blobs), `session_activity_posts`, `session_request_posts`,
   `sdk_session_commands`, `sdk_session_events`, `sdk_room_admissions`,
   `sdk_sessions`.

Part 3 is the risky one: it moves prompt construction (injection markers,
ordering, attachments) from the server into the host, and it can only be
verified end to end against a running Switch with a bridge and Console.

### Also required

- `CLAUDE.md`: agent-facing protocol changes must update all three connector
  skills (`connectors/*/skills/switch/SKILL.md`) — applies to steps 4–5.
- Tell the author of PR #528 before opening a PR against its branch.

## Notes for running tests

Store tests use testcontainers Postgres. If Docker is not found, set
`DOCKER_HOST` to your Docker socket (and `TESTCONTAINERS_RYUK_DISABLED=true`
if Ryuk cannot start).

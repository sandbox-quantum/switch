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

## What is left

### Step 5 — the host sends activity and approvals (Switch Console)

- In `console/packages/agent-providers/src/host/` (`shared-host.ts`,
  `session-host.ts`): alongside the existing upload, POST activity lines
  (mapping: turn.upsert running → turn.started, terminal → turn.finished;
  tool-activity item in-progress → tool.called, done → tool.finished; notice →
  notice; never an empty summary) and open/close approval requests
  (`request.opened` → `POST /agent-sessions/{sid}/approvals` with option
  `decision`; non-answered `request.settled` → `/close`). `requestOnce`
  hard-codes the `/sessions` prefix — add a variant.
- Handle `approval_outcome` in `switch-agent-runtime/src/event-stream.ts`
  (new callback; also make the default branch drop frames without `type`),
  route by `session_id` in `shared-watcher.ts` to the worker (own durable
  file, or bump `HANDOFF_PROTOCOL`), apply via the provider
  (`respondToRequest` with the option's decision; expired → cancel/decline and
  settle `expired`), then `POST …/approvals/{rid}/delivered`.
- Bump agent-runtime to agent-protocol 4 in `artifacts.yaml`, `just artifacts`,
  release the runtime (tag `switch-agent-runtime-v<version>`).
- The old `/sessions/events` upload **cannot be removed yet**: the host gates
  work on its `session.upsert` receipt, the old answer path validates against
  the snapshot, and Console reads transcripts through it.
- Also fix the Console polling found in 0.35: session list every 2 s **per
  linked agent** with no backoff (`remote-session-reconciler.ts`), 50 ms
  startup loop ignoring 404 (`shared-agent-runtime.ts`), 250 ms command loop
  (`shared-host.ts`, replaced by #528's wake hints).

### Step 6 — Console reads transcripts locally

`SharedSessionPanel` always uses `sharedSessionTransport` (reads switch-core,
polls every 500 ms). Add a local-host and a sidecar `SessionTransport` reading
the host's own journal; choose by where the session runs.

### Step 7 — remove the server-side session layer

Once 4–6 ship: drop `sdk_sessions` / `sdk_session_events` /
`sdk_session_commands` / `sdk_room_admissions` usage, `SessionAuthority`,
`sessions/publication.py`, the `/sessions/*` host routes and
`/gateway/sessions/*`, the host's event upload; migration to drop the tables;
keep older Console versions working during the transition.

### Also required

- `CLAUDE.md`: agent-facing protocol changes must update all three connector
  skills (`connectors/*/skills/switch/SKILL.md`) — applies to steps 4–5.
- Tell the author of PR #528 before opening a PR against its branch.

## Notes for running tests

Store tests use testcontainers Postgres. If Docker is not found, set
`DOCKER_HOST` to your Docker socket (and `TESTCONTAINERS_RYUK_DISABLED=true`
if Ryuk cannot start).

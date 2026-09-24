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

## Left mid-way (committed as WIP, tests not re-run)

Step 4 (bridges) had started:

- Approval options now carry `decision` (accept/acceptForSession/decline/
  cancel) — service, host route, gateway view, tests updated.
- `session_activity_events.thread_id` added (model, migration, service, route).
- Models + migration for `approval_request_posts` and `turn_status_posts`
  written; schema guard tests passed. **No store, publisher or inbound code yet.**

Run first: `just test core/tests/switch_core/session_activity` plus the schema
guards (`test_migration_parity.py`, `test_tenant_schema_catalogue.py`,
`test_frozen_ddl_matches_create_all.py`), then the full suite.

## What is left

### Step 4 — bridges render from the new tables (push)

Design agreed, not built:

- **Stores**: `ApprovalRequestPostStore` (create with handle retry on unique
  violation, get by token / by handle in channel / by external post),
  `TurnStatusPostStore`.
- **Card**: build the existing `RequestCard` from a row so all five platform
  renderers work unchanged — `SnapshotRequest(request_id, turn_id, revision,
  state=open|resolved|closed, content=ApprovalContent(kind="approval",
  title=question, detail=None, options=[ApprovalOption(option_id, label,
  decision)]), expires_at, result=RequestSettled(... outcome answered/expired/
  cancelled, result=ApprovalResult(option_id=answer)), decided_by=None)` and
  `RequestReference(token, handle)`.
- **Per-bridge publisher** (new module, e.g. `session_activity/bridge_publisher.py`):
  subscribes to `SessionActivityListener` for the bridge's tenant, with its
  **own queue/task** (the listener awaits subscribers serially; never call a
  platform inline). On `approval.open` post the card if the room is on this
  bridge (`Room.bridge_id`, `Room.external_channel_id`; thread via
  `BridgeMessageMap(bridge_id, external_channel_id, transport_event_id=thread_id)`,
  fall back to channel root on `ThreadUnavailable`); on answered/expired/closed
  `update_rich`; on `activity` create/edit the turn's status message
  (`send_message` + `update_message`, content through `translate_outbound`);
  on resync post cards for open requests with no post.
- **Inbound**: in `bridge_core._handle_inbound_interaction` and
  `_handle_text_answer`, try the new tables first (token from
  `parse_answer_action` / `parse_answer_position`; typed `A<n>` handle — widen
  the regex in `collaboration/session/text.py` from `[Rr]` to `[RrAa]`; bare
  "yes"/"no" as a reply to the card via `external_post_id`), resolve the person
  with `_identify_actor` (returns the mxid), call
  `answer_approval(..., answerer=PlatformPerson(mxid))`, report `SessionError`
  with `adapter.tell_actor`. Fall through to the old path when not found.
- **Wiring**: pass the listener from `main.py` to
  `CollaborationBridgeLifecycleService` → `BridgeCore`; start the subscriber in
  `BridgeCore.start` (inside `tenant_scope(bridge tenant)`), stop it in `stop`.
- **Gap**: Teams and Telegram lack `find_request_card`.
- Reusable test fakes: `tests/switch_core/sessions/test_publication.py`
  `Platform`, `test_turn_activity_publication.py` `ActivityPlatform`,
  `bridges/collaboration/test_rich_content_port.py` `_BareAdapter`,
  `test_session_text_answers.py` (BridgeCore built with `__new__`).

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

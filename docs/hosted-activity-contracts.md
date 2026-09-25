# Hosted agents on the session-activity model: contracts

Port of PR #538 (`feat/hosted-idle-autostop`, cloud "hosted" agents on EC2)
onto main after #543 ("Sessions live with the host", `df0aa35e`). Sibling of
`docs/session-activity-handoff.md`; read that first. Nothing here is built.
Paths are on `origin/main` unless marked *(#538)*; claims not checked against
code are marked **unverified**.

## Why

#538 was written against the 0.27 model: switch-core held every session
(`sdk_sessions.snapshot`), and the hosted pieces read it. Idle autostop
(`HostedLaunchStore.idle_busy` *(#538)*), the session limit and start/restart
checks (`gateway/hosted_launches.py` `session_operation` *(#538)*), credential
recovery (`/hosted/provider-credential` returns `sessions` *(#538)*), Console's
cloud session list (`rpc.sdkHost.sharedList`, polled every 2 s *(#538)*) and
failure notices (`SessionAuthority.failure_notice_thread` *(#538)*) all go
through tables that main's `b9e4d2a71c05` drops. On main the host owns the
session and Core only relays (`protocol/connections.py`
`relay_session_command`, in-memory `EventBuffer`, 2000 events / 15 min).

Main's local and SSH paths both assume that something can reach the watcher
directly: Console's own child process, or a loopback control port opened over
SSH (`host/control.ts` `serveControl`, desktop `sdk-host/sidecar-control.ts`).
Terraform permits **no inbound access** to a hosted worker, so for the cloud
the only link is the one the worker opens itself: the watcher's outbound
stream to Switch.

## Target design

- **The worker's watcher owns its sessions**, the same as a sidecar does:
  `shared-daemon.ts --watch-worker` running `runSharedWatcher` plus
  `serveControl`'s message handling. `hosted-bootstrap.ts` *(#538)* already
  starts the daemon with `--watch-worker`.
- **Core relays Console to the watcher** over the watcher's own SSE stream
  (down) and HTTP up-calls (up). The relayed vocabulary is `control.ts`'s
  `clientMessageSchema` / `SessionRequest`, so local, SSH and cloud share one
  set of message types. Core never stores or logs a relayed body.
- **Core keeps durably only what must outlive the worker or Core itself**: the
  launch and its revision (`hosted_launches`), infrastructure commands
  (`hosted_operations`), and a **wake mailbox** of addressed events not yet
  journaled by the watcher (new).
- **The controller stops a VM only on evidence**: a fresh idle report from the
  current worker, after the grace window, rechecked under the launch lock.
  Missing, stale or foreign reports count as busy.
- **Session existence and slot admission are the watcher's**, in one serial
  section that covers auto-created and Console-started sessions alike.
- **Fencing is two-level**: the durable `hosted_launches.revision` (bumped on
  every start, wake, restart, stop) and the in-memory
  `Connection.stream_generation` (bumped on every stream attach). Every
  up-call names both implicitly through the connection; every relay is bound
  to both at dispatch.

## Identity and fencing

A hosted watcher connection is a normal `scope: all` connection
(`ConnectionRegistry.open`) whose agent carries `metadata.hosted_launch_id`
*(#538)*. New in-memory fields on `Connection`:

| Field | Set by | Meaning |
|---|---|---|
| `launch_id`, `launch_revision` | `POST /hosted/worker/attach` | The launch and revision this stream serves. Read from `hosted_launches` under the launch advisory lock (`hosted-launch:{tenant}:{id}`, as `operation_launch` *(#538)*). |
| `boot_id`, `instance_id` | same | From `SWITCH_HOST_BOOT_ID` / `SWITCH_HOST_INSTANCE_ID`, which `prepareHostedDeployment` *(#538)* already exports. Diagnostic and dedupe context, not authority. |
| `idle_report` | `POST .../connection/idle` | See D2. |

`POST /hosted/worker/attach` `{connection_id, generation, boot_id,
instance_id, speaks}` — agent-authenticated (`get_agent_from_scope`), sent by
the watcher right after `onConnected` and before `replacePlacements`.

- Refused 403 `not_hosted_worker` unless `worker_launch` *(#538)* holds:
  launch `desired_state = running`, `state != error`, owner still a tenant
  member.
- Refused 409 (`require_current`, as `connection_placements`) for a stale or
  missing generation.
- Refused 426 `upgrade_required` when `speaks < HOSTED_RELAY_PROTOCOL_REVISION`
  (7, new). This is the cutover gate on the Core side (see Migration).
- Response `{launch_revision, limits: {sessions_per_agent}, idle: {report_every_s,
  fresh_for_s}}`. The worker holds `launch_revision` only to put it in logs;
  Core never trusts a revision the worker sends.

Any revision bump (`observe`, `note_addressed`, lifecycle routes) evicts every
connection of that agent bound to a lower revision with code
`launch_superseded` (new eviction reason, terminal for the client, like
`taken_over`), and runs `fail_stale_operations` *(#538)* as today. A
connection that has not attached is not a hosted watcher: Core relays nothing
to it and ignores its idle reports.

The `ac2ffa1d` fix *(#538)* (build the `event_stream` generator before
`record_client_declaration` can yield, in `handlers._open_event_stream`) and
the per-boot sequence floor (`agent_event_boot` sequence, migration
`51bc94a017d2`, `EventBuffer(sequence_base=event_boot << 32)` in `main.py`)
are ported as they are. With the floor, a cursor from before a Core restart is
always below the new head's range, so main's watcher takes the
`cursorReset` path (`SharedWatchAssignments.restart`) instead of silently
skipping; the mailbox (D3) covers the events that path loses.

## D1 — Console ⇄ cloud relay

### Vocabulary

The relayed message is exactly one element of `control.ts`
`clientMessageSchema` minus `id` and `token`, plus three additions that the
sidecar path gains too (so the three paths stay one vocabulary):

| Message | Answer | Notes |
|---|---|---|
| `{sessionId, request: SessionRequest}` | the host's reply | `command` (prompt, `session.stop`, `turn.interrupt`, `session.reset`, …; `origin.surface = "console"`, as `submitSessionCommand`), `snapshot`. `room` and `approvals` are **refused** from Console: only the watcher sends those. |
| `{subscribe: sessionId}` / `{unsubscribe}` | ack, then pushed `ServerEvent`s | As `ControlClient.subscribe`, including the standing failure on first subscribe. |
| `{place: {sessionId, roomId}}` | `PlaceOutcome` | "Reconnect to room". |
| `{forget: sessionId}` | ack | |
| `{health: true}` / `{watchHealth: bool}` | `WatcherHealth` / pushed `{health}` | |
| `{list: true}` **new** | `Session[]` (`sessionSchema`) | What `host-sessions.ts` `LIST_SCRIPT` reads over SSH, computed in-process. Extract the logic to `agent-providers/src/host/session-list.ts` and build `LIST_SCRIPT` from it, with a parity test. |
| `{journal: sessionId}` **new** | `Snapshot` | A stopped or parked session read from its `events.jsonl`. Needs `JournalTail.snapshot`'s replay (desktop `sdk-host/host-journal.ts`) moved into `agent-providers`. |
| `{attachment: {sessionId, name, mimeType, sha256, chunk, index, last}}` **new** | `{staged}` on the last chunk | Console → host; chunks ≤ 1 MiB, whole file ≤ `MAX_ATTACHMENT_BYTES` (10 MiB, `host/attachments.ts`), staged with `stageAttachment`. Closes main's "Console attachments have no path to the host" for all three paths. |

`ensure` is **refused** over the relay: it carries a full `SharedHostConfig`
(worker paths and credential locations) that Console must not dictate for a
cloud worker. Starting and restarting a cloud session stay `HostedOperation`s
(see Operations).

The loopback socket and the relay call one function: factor `serveControl`'s
per-message body into `handleControlMessage(links, ensure, control, message,
send)`; `serveControl` keeps the token handshake and the socket.

### Console → Core (gateway, user-authenticated)

Owner only, as today (`HostedLaunchStore.owned`). A launch that is not the
caller's, or not in the caller's tenant, is **404** (not 403), so existence
does not leak.

`POST /gateway/hosted-launches/{request_id}/relay`

```
request:  {"message": <relayed message>, "timeout_ms": int <= 30000}
response: {"ok": bool, "value"?: any, "error"?: {"code", "message"},
           "worker": {"launch_revision": int, "boot_id": str, "generation": int}}
```

Error codes (HTTP 200 with `ok: false` for host-side refusals, 4xx/5xx for
relay failures):

| Code | HTTP | When |
|---|---|---|
| `worker_sleeping` | 409 | `launch.sleeping` and not waking. Body carries `wake_available: true`; Console offers an explicit wake (lifecycle route), never an implicit one. |
| `worker_waking` / `worker_not_attached` | 409 | Waking, provisioning, or no attached hosted watcher. Console retries with backoff; nothing is queued. |
| `generation_changed` | 409 | The reply came from, or the dispatch target became, another generation or revision. Console drops its live views and resnapshots. |
| `relay_timeout` | 504 | No reply by the deadline. The outcome is unknown: Console reconciles commands through `snapshot` → `commandStatuses` (as `reconcileSessionCommand`), never by resending blind. |
| `refused_message` | 400 | `room`, `approvals`, `ensure`. |
| `too_large` | 413 | Request > 12 MiB, or a reply > 16 MiB (**tunable, unverified** that snapshots of long sessions fit). |

`GET /gateway/hosted-launches/{request_id}/relay/stream?subscribe=<sessionId>[&subscribe=…][&watchHealth=1]`
— SSE to Console. Frames `event` `{sessionId, event}`, `failure`
`{sessionId, failure}`, `health` `{health}`, `resync` `{reason}`, `worker`
`{launch_revision, boot_id, generation}` (first frame, and again on change).
Core holds **one** worker subscription per `(launch, session)`, reference
counted across Console streams, and unsubscribes on the last close.
Per-Console buffer: 1000 frames or 4 MiB; overflow sends `resync` and drops
the buffer, and Console calls `snapshot` again (`transcripts.ts`
`openTranscript` already does snapshot then live).

### Core → watcher (down): extend `session_command`

Main's `session_command` frame (protocol 5, `stream.py`) gains a discriminated
envelope; a frame with none of the keys below is today's room control. Sent
only to a connection that is attached (above) and declares `speaks >= 7`.

```
event: session_command
data: {"relay": {"id": "<uuid4>", "deadline_ms": int, "message": {...}}}
data: {"relay_cancel": {"id": "<uuid4>"}}
data: {"operation": {"id", "session_id", "action"}}        // see Operations
data: {"credential": {"revision": str | null}}              // see Credentials
data: {"wake": [{"room_id", "message_id", "event"}]}       // see D3
```

`ConnectionRegistry.relay_session_command` stays for room controls. New
`relay_to_hosted_watcher(agent_id, frame) -> (connection_id, generation) |
None` picks the one attached hosted watcher (the most recently attached if
several; more than one is logged as an error) rather than broadcasting, so a
reply has exactly one legitimate sender. Pending relays live in an in-memory
map `relay_id → {tenant, agent, launch_id, launch_revision, connection_id,
generation, future, deadline}`; nothing is written to the database. A detach,
eviction or revision bump fails every pending relay of that connection with
`generation_changed`.

### Watcher → Core (up, agent-authenticated)

`POST /agents/{agent_id}/connection/relay/{relay_id}`
`{connection_id, generation, ok, value?, error?}` — 404 for an unknown relay
or one registered to another agent; 409 `generation_changed` when the caller
is not the connection and generation the relay was dispatched to (checked with
`require_current`). A second reply is 409 and ignored.

`POST /agents/{agent_id}/connection/relay/push`
`{connection_id, generation, pushes: [{subscription: sessionId | "health",
seq: int, event? | failure? | health?}]}` — batched by the watcher (≤ 250 ms or
64 KiB). `seq` is per `(generation, subscription)`; Core forwards in order and
sends `resync` on a gap. Pushes for a subscription Core no longer holds are
answered with `{unsubscribe: [...]}` so the watcher stops sending them.

### Tests that prove D1

- Relay round trip for each message against a real watcher over a fake stream
  (agent-providers) and the Core routes (core), including `list` / `journal`
  parity with `LIST_SCRIPT` / `JournalTail`.
- `room`, `approvals`, `ensure` refused; a foreign tenant, a non-owner and a
  deleted launch all get 404.
- A reply from a superseded generation is refused and the Console request
  fails `generation_changed`; a revision bump mid-request does the same.
- Two Console streams on one session create one worker subscription; closing
  both unsubscribes; overflow yields `resync` and a fresh snapshot.
- Nothing relayed reaches the database or the log (assert on captured logs and
  a table scan in the store test).

## D2 — Idle report and autostop

### Report (watcher → Core)

`POST /agents/{agent_id}/connection/idle` — agent-authenticated, fenced like
`connection_placements` (`require_current`), accepted only from an attached
hosted watcher. Sent on every change and at least every `report_every_s` (30).

```
{
  "connection_id": str, "generation": int,
  "report_seq": int,          // monotonic per watcher process; lower or equal is ignored
  "busy": bool,
  "reasons": [{"kind": str, "session_id": str | null, "count": int}],
  "sessions": {"total": int, "live": int, "parked": int, "failed": int}
}
```

Reason kinds: `turn_running`, `turn_starting`, `room_pending` (watcher pump
queue or held room for a session), `approval_open`, `reset_waiting`,
`operation_claimed`, `relay_inflight`, `console_recent` (a Console relay
request in the last 10 minutes; an open live view alone does not count, so a
forgotten window cannot pin a VM), `failed_holding` (below).

Per-session busy is one predicate shared with parking: extract
`shared-host.ts`'s `idleEnough` conditions (status ready, no running turn, no
open request, no `resetDecisionPending`, no pending room input) into
`sessionBusy(snapshot, host)`; the host announces it to its parent over the
IPC pipe as a new host → parent message `{kind: 'busy', busy, reasons}`
(`session-channel.ts` `fromChildSchema`) on every change. A host that is not
running and has nothing queued in the watcher (parked, stopped, exited) is
idle. Parking (`SWITCH_SESSION_PARK_AFTER_MS`, 30 min) is unchanged and
separate: a parked host is simply idle for this report.

**Bounded holds**: a session whose host failed to start
(`SessionHostFailedError`, `pumps` entry `failed`) with queued room messages,
or one waiting on a reset decision, reports `failed_holding` /
`reset_waiting` as busy for at most 15 minutes after its failure notice was
posted, then idle. Its messages stay in the watcher journal and are retried on
the next address after wake (main's pump already retries a failed host once
per new message).

Core stores the latest accepted report on the `Connection` with Core's own
monotonic `received_at`. It is **fresh** when the connection is alive, still
the current generation, bound to the launch's current revision, and
`received_at` is within `fresh_for_s` (75). Core restart, detach, generation
change and revision bump all make it absent. **Absent or stale = busy.**

### Decision (controller observation)

`hosted_controller.observe` *(#538)* replaces `HostedLaunchStore.idle_busy`
with `idle_evidence(launch)`, busy when any of:

1. no fresh report, or the report says `busy`;
2. a `hosted_operations` row `queued`/`claimed` at the current revision;
3. a `hosted_wake_mailbox` row `pending`/`offered` for the agent (D3);
4. an `approval_requests` row `open` for the agent (Core's own record, main's
   `session_activity` tables).

Busy sets `active_at = now` (as today). The launch stops only when all hold,
under the launch advisory lock, in one transaction:

- not busy, `spec.auto_session` true, `hosted_idle_stop_minutes > 0`
  (`config.py` *(#538)*, default 0 = off);
- `now - active_at >= hosted_idle_stop_minutes`;
- the report's `received_at` is later than `active_at` (the idle evidence is
  newer than the last addressed activity; `note_addressed` bumps `active_at`
  under the same lock);
- `launch.revision` is the one the report's connection is bound to.

Then `desired_state = stopped`, `state = stopping`, `sleeping = true`,
`revision += 1` (as today); the bump evicts the watcher (`launch_superseded`)
so nothing it sends afterwards counts. An addressed event racing the decision
either commits first (bumps `active_at`, recheck fails) or after (the launch
is `sleeping`, so it wakes it and lands in the mailbox). The EBS volume
survives an EC2 stop, so anything the watcher journaled is resumed on wake.

### Tests that prove D2

- A pending approval, a running turn, a queued pump message and a claimed
  operation each keep the VM up indefinitely (no autostop across 3 grace
  windows).
- No report, a stale report, a report from a superseded generation, and a
  Core restart each count as busy.
- A mention between the last idle report and the decision prevents the stop.
- A failed host with queued messages stops holding after 15 minutes.
- `sessionBusy` and parking agree (one predicate, table test).

## D3 — Wake mailbox

### Table `hosted_wake_mailbox`

Tenant-scoped with RLS, like every table in main's `545f80e11f13`.

| Column | Meaning |
|---|---|
| `tenant_id, agent_id, room_id, message_id` | Primary key. `message_id` is `roomInputId(event)` (`host/room-inbox.ts`): the message id for an addressed message, `type:sha256` for a listened `room_join` or task event. This is the dedupe key everywhere. |
| `launch_id` | FK to `hosted_launches`, `ON DELETE CASCADE`. |
| `event` | JSONB: `{type, payload, missed}` as the watcher's `onEvent` builds a `Handoff.event`. |
| `state` | `pending` → `offered` → `acked`; or `cancelled` / `expired`. |
| `offered_to` | `connection_id:generation` while `offered`. |
| `outcome` | On ack: `journaled` / `duplicate` / `refused`. |
| `addressed_at, acked_at, expires_at` | |

Index `(tenant_id, agent_id, state, addressed_at)`.

### Write

For a hosted agent (`metadata.hosted_launch_id`), **every** addressed event
is written in the same transaction as `note_addressed` *(#538)*, in
`agent_client.py` `_note_hosted_addressed` and `on_task_delegate`, whether or
not a watcher is attached. The agreed decision covers the not-attached case;
writing unconditionally is how that case is covered without a race: an
attached-check followed by delivery can lose an event to a stream that dies,
or a Core that restarts, before the watcher journals it. Addressed traffic is
chat-rate, so the cost is one insert per addressed event for hosted agents
only. `ON CONFLICT DO NOTHING` makes a redelivered Matrix event a no-op.

Not written, with the room told why (existing unavailable reply), when
`desired_state` is `stopped` and `sleeping` is false (explicit Stop),
`deleted`, or `state = error`. **Explicit Stop takes precedence**: the
lifecycle Stop route sets every `pending`/`offered` row of the launch to
`cancelled` in its transaction, and one notice per room is posted through the
failure-notice path (reason `stopped`). Explicit Stop never wakes.

### Deliver

- **Attached**: the event arrives through the normal buffer path as today.
- **On attach** (`/hosted/worker/attach` success): Core sends every `pending`
  row, oldest first per room, as `session_command` `{"wake": [...]}` frames
  (≤ 50 per frame) *before* returning, so they reach the stream ahead of
  buffered events, and marks them `offered`.
- **While attached**: rows `pending` for more than 60 s are offered again (an
  event lost to a buffer gap or overflow).
- Detach, eviction or revision bump returns that connection's `offered` rows
  to `pending`.

The watcher handles a `wake` entry as a held delivery keyed by room and
message, never by sequence: `SharedWatchAssignments.park` (the `parked`
record already stores the event and is keyed by `delivery(room, message)`),
then the normal `admit` path. Dedupe: skip when the journal already has an
assignment, a `parked` or a `released` record for the same `(room,
message)`, or the pump queue holds it. This holds across a Core restart
(sequence floor or reset) because nothing is keyed by sequence.

### Ack

`POST /agents/{agent_id}/connection/mailbox/ack`
`{connection_id, generation, entries: [{room_id, message_id, outcome, reason?}]}`
— sent only after the `parked` (or assignment) record is on disk
(`host/journal.ts` syncs the file on append). Fenced by `require_current`;
accepted from an attached watcher at the current revision; idempotent (an
already-`acked` row is `ok`). The watcher also acks events that arrived
through the normal path once journaled, so a row never outlives its delivery.
`refused` is for an event the watcher will not act on (for example session
limit reached and auto-start off); the watcher posts the failure notice
itself.

### Retention

`pending`/`offered` rows expire after 24 h (`expires_at`), with one notice per
room (reason `expired`). `acked`, `cancelled` and `expired` rows are pruned 7
days after `acked_at`/`updated_at` by the existing upkeep loop
(`session_activity/maintenance.py`). More than 500 `pending` rows for one
agent refuses the insert and tells the room (fail loud, not silent drop).

### Tests that prove D3

- Sleep → mention → wake → exactly one turn, with Core restarted (a) before
  the worker attaches, (b) after `wake` is sent but before ack, (c) after ack.
- Mention while attached, stream killed before the watcher journals: one turn
  after reconnect.
- Explicit Stop with pending rows: rows cancelled, one notice per room, no
  wake, no turn after a later manual start.
- A duplicate `wake` for an already-assigned message is acked `duplicate`.
- Expiry notice after 24 h; overflow refusal at 501.

## Operations: `hosted_operations` as the infra queue

`HostedOperation` *(#538)* keeps `start` / `restart` of a cloud session:
durable, idempotent by client-chosen `id`, with an outcome record. Console's
other session actions go through the relay.

Changes:

- **Admission moves to the watcher.** `session_operation` *(#538)* stops
  reading `SdkSession`: Core checks only ownership, launch `ready`/`running`,
  id reuse, and one pending operation per session. Whether the session exists
  and whether a slot is free are the watcher's answers (below).
- **Push, not poll.** Insert → `session_command` `{"operation": {...}}` to the
  attached watcher. On attach, every `queued` row at the current revision is
  pushed. `runHostedControl`'s 2 s loop *(#538)* goes.
- **Claim** `POST /hosted/operations/{id}/claim` `{connection_id, generation}`
  replaces `/operations/claim`: `queued → claimed` only for an attached
  watcher at `operation.launch_revision`; stores `claimed_by =
  connection_id:generation` and `claimed_boot_id` (new columns). 409 for
  anything else. A pushed operation the watcher cannot claim is dropped.
- **Result** `POST /hosted/operations/{id}/result` as today, plus
  `{connection_id, generation}`. The watcher writes the outcome to
  `operations.jsonl` in its root before posting, and re-posts every
  unconfirmed outcome on each attach, so a lost result is recovered rather
  than re-executed ("a lost result is never a reason to execute the operation
  again", `hosted-control.ts` *(#538)*, stays true). Core accepts a re-post
  from a later generation of the same boot (`claimed_boot_id` matches).
- **States** unchanged: revision mismatch turns `queued → failed` and
  `claimed → unknown` (`fail_stale_operations`); `claimed` for 5 minutes with
  no result → `unknown`. `unknown` tells the owner to inspect the session
  (now via `snapshot`/`journal` over the relay).

## Session existence and slot admission (watcher)

One serial section in `runSharedWatcher` (the existing `pending` promise
chain) decides, for both auto-created sessions (`admit` →
`assignments.assign`) and operations (`start` / `restart`):

- `start` for a session id that exists under `sharedSessionsBase()` →
  result `failed` "already exists"; `restart` for one that does not, or that
  belongs to another agent → `failed` "not found" (as
  `executeHostedOperation` *(#538)* checks today).
- Active = live or starting, not stopped, not retired; parked counts as
  active. `start`, `restart` of a stopped session, and a new auto-created
  session are refused when active ≥ `limits.sessions_per_agent` (from
  attach; `hosted_sessions_per_agent`, default 8). A refused operation is
  `failed` "session limit"; a refused auto-create posts a notice (reason
  `capacity`) and acks the mailbox row `refused`.
- Local and SSH watchers get the same check with no limit configured.

Test: two concurrent starts plus one auto-create at limit − 1 admit exactly
one.

## Credentials

`POST /hosted/provider-credential` *(#538)* drops `sessions` (it lists
`SdkSession`s; the watcher knows its own) and keeps `{status, kind, provider,
revision, credential}` with `Cache-Control: no-store`.

- **Push**: a change to the owner's `provider_connections` row
  (`verified_at` moves, or the row is deleted) sends `session_command`
  `{"credential": {"revision": str | null}}` to the attached watcher. The
  frame carries no secret.
- **Fetch**: on the push, on each attach, and every 10 minutes as a backstop
  (was every 2 s), the watcher fetches and compares `revision`.
- **Apply**: a new revision is materialized (`materializeHostedProvider`),
  then each live session restarts at its next idle point (never mid-turn);
  Codex keeps #538's `refreshCodexAuthentication` in `codex/home.ts` rather
  than main's copy-once, in hosted mode only. `revoked` stops every host
  (`supervision.stop`), reports idle, and makes addressed events answer
  "provider disconnected" instead of starting sessions. GitHub installation
  tokens (`/hosted/github-credential`, `github_issued_tokens`) are unchanged.
- **Wake while revoked** does not start the VM: `note_addressed` refuses to
  wake a launch whose provider connection is missing, and the room is told to
  have the owner reconnect (**unverified** whether #538 already does this; it
  appears not to).

## Failure notices

#538's `POST /agent-sessions/{id}/room-failure` depends on
`SessionAuthority` (gone). Replace with an agent-authenticated
`POST /agents/{agent_id}/room-notices`
`{connection_id, generation, room_id, message_id, reason}`, reasons
`startup | delivery | conversation | capacity | stopped | expired | revoked`:

- Authorization equals `post_message`'s for this agent (agent's client is in
  the room, room not archived) plus: the caller is the current attached
  watcher, and `message_id` is a message in that room. Posting goes through
  the same `protocol.send_message` path as `post_message`, threaded on the
  message's thread (`Message.thread_root_event_id`).
- **Once per message and reason**: the key `[agent, room, message, reason]`
  under an advisory lock, checked against `messages.content.switch_room_failure`
  as #538 does. Core-originated reasons (`stopped`, `expired`) use the same
  function.
- Not an MCP tool, so the tool surface and the Switch skill are unchanged.
  Main's `announceStartFailure` (owner-addressed `send_targeted_message`)
  stays for local and SSH.

The watcher keeps unsent notices in `notices.jsonl` and retries them on
attach.

## Room controls while sleeping

`commands.py` `_dispatch_control_command`: compute `delivered = placed is not
None and relay_session_command(...)`. When not delivered and the agent is
hosted:

- `!reset`: if the launch is sleeping or waking, call `note_addressed` (wakes
  it) and reply "The cloud worker is waking up. The reset was not queued …
  send `!reset` again" (#538 wording). Two steps on purpose: a destructive
  command is never queued for later; the person reissues it once the agent
  is back. Not written to the mailbox.
- `!interrupt`, `!compact`: reply that the agent is asleep and nothing is
  running; do not wake.
- Otherwise main's existing "controller is not connected" reply.

Placements are in-memory in Core and restated by the watcher on attach, so a
sleeping agent has no placement; the check must not rely on `placed`.

## Migration

### Schema

Our 11 revisions `ab921ef034cd → c29f7018ea44 → e7240c165b92 → f138a612de04 →
a472be90d1f6 → 48ab0298a34b → 51bc94a017d2 → 62cf05b128e3 → 73da16c239f4 →
84eb27d340a5 → 95fc38e451b6` are applied on the shared pilot with parent
`2d84b6f1c705`. None references the tables `b9e4d2a71c05` drops (checked by
grep). Never edit or re-parent them.

1. `<rev>_merge_hosted_and_session_activity.py`: `down_revision =
   ("95fc38e451b6", "e3b7c9d2a415")`, empty upgrade and downgrade.
2. `<rev>_hosted_wake_mailbox.py`: the table, RLS policy, grants (follow
   `545f80e11f13`); `hosted_operations.claimed_by`, `claimed_boot_id`.
3. Test: `alembic heads` is one head; upgrade from `95fc38e451b6` and from
   `e3b7c9d2a415` both reach it; `test_frozen_ddl_matches_create_all.py`
   still passes (no new NOTIFY DDL is needed; mailbox delivery is pull-on-attach).

### Pilot order

The pilot sits on our head; main's `a7e1c4b90d23 … e3b7c9d2a415` are not
applied, and among them `b9e4d2a71c05` drops `sdk_sessions`,
`sdk_session_events`, `sdk_session_commands`, `sdk_room_admissions`,
`session_request_posts` and deletes blobs tied to them. Its downgrade raises.

1. Stop every hosted launch through the controller with desired `stopped`
   and `sleeping = false` (explicit Stop, so nothing wakes), and wait for
   `stopped`. Volumes persist.
2. `pg_dump` the pilot database.
3. Export, per hosted agent, what exists only in the doomed tables: sessions
   and their last status, undelivered `sdk_session_commands`, room
   admissions. Used only to tell owners what was pending; transcripts are on
   the worker volumes (the host always journals `events.jsonl`; **verify on
   one pilot volume before step 4**).
4. Deploy the new Core; `alembic upgrade heads` (main's chain, including the
   destructive revision, then the merge and the mailbox).
5. Roll the worker image (WP6 migration runs on first boot), then Console.

### Cutover gating (Core + worker + Console together)

- Core refuses `/hosted/worker/attach` below protocol 7 (`upgrade_required`),
  so an old worker image cannot half-work against new Core; the controller
  launches the runtime build Core names in the spec.
- Console detects `hosted_relay` on the version route (`version_routes.py`)
  and otherwise shows "update Switch Console" for cloud agents. An old
  Console against new Core fails on the removed `sharedList` path; compatibility
  is waived as in main's step 7.
- An old Core never sees a new worker: images are rolled after Core.

### Retained worker state (first boot of the new image)

Run by the bootstrap before the daemon starts, idempotent, each step recorded
in `<state root>/state-version.json` so a crash resumes it:

- **Placements**: none to write. Main's `SessionPlacements.open(root, () =>
  assignments.placements())` already derives them from `assignments.jsonl`
  for a watcher with no `placements.json`; Console-started sessions use their
  config's `roomConnection.restoreRoomId`.
- **Inbox / handoffs**: any per-session handoff or drain file #538's host
  left (main removed them, `handoff.ts` keeps only `HostWaker`) is imported
  into the watcher journal as `parked` records keyed by room and message,
  then deleted. **Unverified**: exact file names on #538 volumes.
- **Native, config and provider homes**: Codex homes are
  `<root>/<sha256(sessionId)>` on both branches (`codex/home.ts`), so they
  carry over; verify OpenCode data dirs and Claude project dirs resolve to
  the same paths under main's `provider-home.ts` and move (rename on the same
  volume) where not. No credential is copied into a config file.
- **Pending operations**: an operation applied before the cutover with an
  unposted result is recorded in `operations.jsonl` and re-posted; the Core
  row has become `failed`/`unknown` by revision bump, and the re-post is
  refused 409, which is logged, not retried.
- **Activity**: `activity-reported.jsonl` absent → main starts reporting at
  the journal's end, so no history is replayed to the platforms.

## Data held where

| What | Where | Durable? |
|---|---|---|
| Transcripts, provider state, native homes, placements, room journal, operation outcomes, unsent notices | Worker volume | Yes (survives EC2 stop) |
| Launch, revision, sleeping, `active_at` | `hosted_launches` | Yes |
| Start/restart commands and outcomes | `hosted_operations` | Yes |
| Addressed events not yet journaled | `hosted_wake_mailbox` | Yes, ≤ 24 h pending, 7 d receipts |
| Approval requests, activity rows | main's `session_activity` tables | Yes (as main) |
| Idle report, pending relays, live subscriptions, placements | `ConnectionRegistry` | No: lost on Core restart, and loss means busy / retry |

## What the contracts cannot say

- A relay timeout leaves a command's outcome unknown until Console reads a
  snapshot; if the worker went to sleep in between, only a wake answers it.
- Sleeping sessions cannot be inspected without waking: Core holds no
  transcript by design. A read-only cache of the last snapshot was rejected
  for that reason; revisit if owners ask.
- `console_recent` is a heuristic; ten minutes is arbitrary.
- The mailbox guarantees exactly-once hand-off to the watcher journal, not
  exactly-once turns: a host that crashes mid-turn after the hand-off is
  main's recovery story (**unverified** that a host restarted with a queued
  room message in its inbox resumes it).

## Decisions on the open questions

Resolved by the port owner; the reviewer may reopen any of them.

1. **Frames**: new frames, not envelopes on `session_command`. This follows
   main's one-frame-per-purpose pattern (`session_command`, `approval_outcome`,
   `room_released`): `relay` carries Console requests to the watcher and
   `wake` carries mailbox rows. `session_command` stays room controls only.
   Wherever this note says `session_command` `{"wake": ...}` or relay
   envelopes, read the dedicated frame.
2. **Snapshots are paged**, not capped: `journal` and `snapshot` answers are
   paged at 1 MiB with a cursor; a single entry above the page size fails
   loudly with its size.
3. **Relay is owner-only**, as in #538.
4. **`wake` rows carry the platform thread** (it is already in the event
   payload), so an expired or refused row is answered in its thread.
5. **Mailbox writes always** for hosted agents, deduped by `(room,
   message)`, because the detached check races.

## Open questions (as first written)

1. Frame naming: the agreed direction is to extend `session_command`; a
   separate `hosted_control` frame would be clearer on the wire. Decide
   before protocol 7 is cut.
2. Reply size cap for `snapshot` (16 MiB proposed) versus paging `journal`.
3. Should tenant admins (not only the owner) be able to relay to a cloud
   agent? #538 is owner-only; kept.
4. Whether `wake` rows should also carry the platform thread so the watcher
   can answer an expired row in-thread without a lookup.
5. Mailbox write-always versus only-when-detached (see D3 Write); write-always
   is proposed because the detached check races.

## Work packages

- **WP1 base port.** Rebase #538's non-session parts onto main: controller,
  launches, provider and GitHub connections, bootstrap, `agent_event_boot`
  floor, `ac2ffa1d`. Remove every `SdkSession` / `SessionAuthority` use
  (`hosted_routes.py`, `hosted_launches.py`, `hosted_launch_store.py`,
  `session_routes.py`, `commands.py`). Merge revision. Tests: migrations
  single head; #538's controller and launch tests green.
- **WP2 worker runtime on `--watch-worker`.** Main's `--watch-worker` branch
  of `shared-daemon.ts` with `SessionLinks` and in-process supervision; drop
  `runHostedControl`'s loop; `handleControlMessage` factored out of
  `serveControl`; `list`, `journal`, `attachment`; attach, idle report,
  `busy` IPC, operation claim/result with `operations.jsonl`, credential
  push/fetch, watcher-side admission, `notices.jsonl`.
- **WP3 server.** `/hosted/worker/attach`, `launch_superseded` eviction,
  relay registry and routes (gateway and agent), `session_command`
  envelopes at protocol 7, idle report storage and `idle_evidence`,
  operation push/claim, credential push, `/agents/{id}/room-notices`,
  `!reset` two-step.
- **WP4 mailbox.** Table, write in `note_addressed`'s transaction, offer on
  attach and re-offer, ack route, Stop cancellation, expiry and pruning.
- **WP5 Console cloud.** A `CloudRelayClient` with `ControlClient`'s
  interface; `askHost`, `transcripts.ts`, `host-sessions.ts`, the health
  monitor and stop/forget route cloud agents through it; `sleeping` and
  `waking` shown as health states from the launch, with an explicit wake;
  cloud sidebar reads `list` instead of polling `sharedList`.
- **WP6 cutover and state migration.** Pilot runbook above; first-boot
  migration; version gates on all three sides.
- **WP7 acceptance** (`just bench` scenarios plus a pilot run):
  1. retained Codex and OpenCode conversations resume after cutover;
  2. two sessions on one worker, room takeover between them
     (`replace_placements`, `room_released`);
  3. a pending approval and a running turn never auto-stop;
  4. sleep → mention → exactly one turn, across a Core restart at each step;
  5. explicit Stop never wakes, and cancels pending rows;
  6. lost claim and lost result: no double execution, outcome recovered;
  7. generation change mid-relay and mid-operation is fenced;
  8. revoked provider credentials: hosts stop, no restart loop, no wake;
  9. tenant isolation: foreign tenant and non-owner relay, ack, claim and
     notice calls all 404/403 and leak nothing;
  10. load: many hosted agents with many parked sessions keep Core CPU and
      pool use flat (idle reports only; no per-session traffic).

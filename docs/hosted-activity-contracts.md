# Hosted agents on the session-activity model: contracts

Port of PR #538 (`feat/hosted-idle-autostop`, cloud "hosted" agents on EC2)
onto main after #543 ("Sessions live with the host", `df0aa35e`). Sibling of
`docs/session-activity-handoff.md`; read that first. Nothing here is built.
Paths are on `origin/main` unless marked *(#538)* (`758bc5ae`); claims not
checked against code are marked **unverified**.

## Why

#538 was written against the 0.27 model: switch-core held every session
(`sdk_sessions.snapshot`), and the hosted pieces read it. Idle autostop
(`HostedLaunchStore.idle_busy` *(#538)*), the session limit and start/restart
checks (`gateway/hosted_launches.py` `session_operation` *(#538)*), credential
recovery (`/hosted/provider-credential` returns `sessions` *(#538)*), Console's
cloud session list (`rpc.sdkHost.sharedList`, polled every 2 s *(#538)*),
room-message submission (`sessions/service.py` `submit_room_message` *(#538)*)
and failure notices (`SessionAuthority.failure_notice_thread` *(#538)*) all go
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
  starts the daemon with `--watch-worker`. Session tool calls are forwarded to
  the process that holds the agent's connection (`switch-agent-runtime`
  `hosted.ts`), so on the worker only the watcher talks to Switch.
- **Core relays Console to the watcher** over the watcher's own SSE stream
  (down) and HTTP up-calls (up), in dedicated frames. The relayed vocabulary
  is `control.ts`'s `clientMessageSchema` / `SessionRequest`, so local, SSH and
  cloud share one set of message types. Core never stores or logs a relayed
  body.
- **Only the current worker can be the watcher.** Attach needs a capability
  the controller mints per launch revision; any other holder of the agent key
  is refused the watcher's stream, placements and relays.
- **Core keeps durably only what must outlive the worker or Core itself**: the
  launch and its revision (`hosted_launches`), infrastructure commands
  (`hosted_operations`), and a **wake mailbox** of every addressed event until
  the watcher has it on disk (new).
- **The controller stops a VM only on evidence**: a fresh idle report from the
  current worker that acknowledges every mutating relay Core dispatched, after
  the grace window, rechecked under the launch lock. Missing, stale or foreign
  reports count as busy.
- **Session existence and slot admission are the watcher's**, in one serial
  section that covers auto-created and Console-started sessions alike.

## Identity, fencing and the worker capability

### Levels

| Level | Where | Bumped by |
|---|---|---|
| `hosted_launches.revision` *(#538)* | Postgres | every start, wake, restart, stop, autostop (`observe`, `note_addressed`, lifecycle routes) |
| worker capability | `hosted_launches.worker_capability_hash`, `worker_capability_revision` (new) | every successful `prepare` |
| `Connection.stream_generation` | memory (`ConnectionRegistry._new_incarnation`, random seed per boot) | every stream open or reattach |
| Core boot | `agent_event_boot` sequence *(#538, migration `51bc94a017d2`)* | every Core start |

A durable record that names a connection (`offered_to`, `claimed_by`) stores
`core_boot:connection_id:generation`. Generations are only unique within one
Core boot, so a record from another boot is treated as foreign, never
compared.

### Minting (controller, `hosted_controller.prepare` *(#538)*)

`prepare` already returns the agent key as `switch_credentials.env`
(`SWITCH_API_TOKEN`). It additionally:

- mints 32 random bytes as `worker_capability`, in the transaction that sets
  `state = provisioning`, storing `sha256` in `worker_capability_hash` and
  `launch.revision` in `worker_capability_revision`. The previous hash is
  replaced, so only the most recently prepared VM holds a valid capability;
- returns it as a top-level `worker_capability` field, not inside
  `switch_credentials.env`, with `Cache-Control: no-store` as today.

A capability is valid iff its hash matches **and**
`worker_capability_revision = launch.revision` **and** `desired_state =
running`, `state != error`, owner still a tenant member (`worker_launch`
*(#538)*). Any revision bump therefore makes it obsolete without a write. A
`prepare` retried at the same revision (controller crash after boot) rotates
it and the running VM is refused on its next reattach: a visible failure
(`worker_capability_obsolete`, launch goes to `provisioning` and then the
10-minute `error` path in `observe`), never two valid workers.

The bootstrap writes it to `<state root>/worker-capability` with mode 0600 by
atomic rename on every boot. It must not use `writeNewJson`
(`hosted-bootstrap.ts` *(#538)*), which is write-once. The capability is never
put in the provider or session environment and never logged.

### Attaching

Attach is the stream open itself: `GET /agents/{agent_id}/events` (main's
`_open_event_stream`) with headers `X-Switch-Worker-Capability`,
`X-Switch-Host-Boot-Id`, `X-Switch-Host-Instance-Id` (from
`SWITCH_HOST_BOOT_ID` / `SWITCH_HOST_INSTANCE_ID`, which
`prepareHostedDeployment` *(#538)* already exports). For an agent whose
metadata carries `hosted_launch_id` *(#538)*, Core takes the launch advisory
lock (`hosted-launch:{tenant}:{id}`, as `operation_launch` *(#538)*) and:

| Outcome | HTTP / code | When |
|---|---|---|
| refused | 403 `worker_capability_required` | no header |
| refused, terminal | 403 `worker_capability_obsolete` | hash or revision mismatch, launch not running. The watcher exits cleanly and does not restart itself (like `EVICTION_TAKEN_OVER` in `shared-watcher.ts`). |
| refused | 426 `upgrade_required` | `speaks < HOSTED_PROTOCOL_REVISION` (7, new; `artifacts.yaml` `agent-protocol` goes 6 → 7) |
| refused | 409 `worker_already_attached` | another connection of this agent is attached as worker, alive (beat within `HEARTBEAT_TTL_SECONDS`, 6 s), with a different `boot_id` |
| takeover | 200 | same `boot_id`, different connection id (daemon restart on the same boot): the old connection is evicted `taken_over` |
| reattach | 200 | same connection id, under main's existing `expected_generation` rule (`SupersededReattachError`) |

There is exactly one attached worker per agent. Two VMs holding a valid
capability cannot happen by construction; a refused second worker retries
with backoff and wins only once the first has lapsed.

On success the connection gets in-memory `launch_id`, `launch_revision`,
`boot_id`, `instance_id`, `worker = true`. The first frame after
`connection_state` is `worker_attached` (see Frames), and every `pending` wake
row is sent before the first buffered event.

### What a non-worker connection of a hosted agent may do

Any holder of the agent key (a local Console, an old VM, a leaked key) can
still call the agent's tool operations; that is the agent key's power and is
unchanged. It is **refused 403 `hosted_worker_only`** for:

- opening or reattaching any connection of a hosted agent without a valid
  capability. This covers the watcher's own connection id, so a generic
  "reopen to take over" is gated too;
- `connection/subscribe`, `connection/placements`, `place_session` and room
  claims;
- every hosted up-call below (relay reply and push, idle, mailbox ack,
  operations, notices).

The frames of protocol 7 go only to the attached worker.
`relay_session_command` (room controls) is also narrowed to it for hosted
agents; it no longer broadcasts to every `scope: all` connection.
`observe`'s `listening` check *(#538)*, which counts any `spawn_capable`
connection as ready, counts only the attached worker at the current revision.

### Revision bump

Any bump evicts that agent's attached worker if it is bound to a lower
revision, with code `launch_superseded` (new, terminal like `taken_over`). It
also fails that connection's pending relays with `generation_changed`,
returns its wake offers to `pending` (D3), and runs `fail_stale_operations`
*(#538)*.

### Core restart and the sequence floor

The per-boot sequence floor (`agent_event_boot`,
`EventBuffer(sequence_base=event_boot << 32)` *(#538)*) is ported, and with it
the `ac2ffa1d` fix *(#538)*: build the `event_stream` generator before
`record_client_declaration` can yield, in `handlers._open_event_stream`. Main
lacks the fix.

With the floor, a new boot's sequences are **above** every cursor from an
earlier boot. Main's restart detection (`stream.py`: `conn.cursor > head`,
then `buffer.mark_restarted` and a `gap` with `all_rooms`) then never fires,
and without more the restart is silent. The port carries #538's second branch
(`0 < conn.cursor < floor - 1`, `protocol/stream.py` *(#538)*) into main's
form: `mark_restarted`, a `gap` frame with `all_rooms: true` and `resumed_at =
floor - 1`.

Because `resumed_at` is above the client's cursor, `event-stream.ts`
computes `cursorReset: false`, and the watcher's `onGap` does **not** append a
`restarted` record (`SharedWatchAssignments.restart`). That is correct:
sequence numbers are never reused across boots, so the watcher's
sequence-based dedupe stays valid. Events lost with the old buffer are
recovered by the mailbox (D3) for hosted agents. For local and SSH watchers
the gap warning is the signal, as today. Main's `cursor > head` branch stays
for a database whose sequence was reset.

### Tests

- `test_worker_attach_requires_current_capability`: an old worker reconnects
  after a revision bump → 403 `worker_capability_obsolete`, and it receives no
  wake, relay or placement.
- `test_local_console_cannot_take_over_hosted_stream`: an agent-key client
  opens `scope: all`, reopens the worker's connection id, posts placements →
  all 403, and the worker's generation is unchanged.
- `test_second_worker_refused_while_first_alive`, and
  `test_same_boot_takeover_evicts_old`.
- `test_prepare_rotates_capability` (the old VM's reattach is refused).
- `test_stream_reports_restart_below_floor` (core) and
  `test_gap_above_cursor_is_not_cursor_reset` (switch-agent-runtime).

## Frames (protocol 7)

One frame per purpose, as main already has (`session_command` 5,
`approval_outcome` 4, `room_released` 6). All are sent only to the attached
worker. `session_command` stays room controls only.

| Frame | Data | Body? |
|---|---|---|
| `worker_attached` | `{launch_revision, limits: {sessions_per_agent}, idle: {report_every_s, fresh_for_s}, credential_revision, queued_operations: [id], cancelled: [{room_id, message_id}]}` | no |
| `relay` | `{id, deadline_ms, relay_seq \| null, message}` | yes (Console request) |
| `relay_cancel` | `{id}` | no |
| `wake` | `{entries: [{room_id, message_id, thread_id, event}]}`, ≤ 50 entries | yes (room event) |
| `mailbox_cancel` | `{entries: [{room_id, message_id}]}` | no |
| `operation` | `{id}` | no: a doorbell to claim |
| `credential` | `{revision \| null}` | no: a doorbell to fetch |

Frames that carry a body are queued per connection (as `session_commands`),
bounded at 64 frames or 8 MiB. Past that a relay fails `worker_busy` (503) and
a wake entry stays `pending`. Nothing is dropped silently.

## D1 — Console ⇄ cloud relay

### Vocabulary

The relayed message is exactly one element of `control.ts`
`clientMessageSchema` minus `id` and `token`, plus additions the sidecar path
gains too, so the three paths stay one vocabulary:

| Message | Answer | Notes |
|---|---|---|
| `{sessionId, request: SessionRequest}` | the host's reply | `command` (prompt, `session.stop`, `turn.interrupt`, `session.reset`, …; `origin.surface = "console"`, as `submitSessionCommand`). `snapshot` is paged (below). `room` and `approvals` are **refused**: only the watcher sends those. |
| `{subscribe: sessionId}` / `{unsubscribe}` | ack, then pushed `ServerEvent`s | As `ControlClient.subscribe`, including the standing failure on first subscribe. |
| `{place: {sessionId, roomId}}` | `PlaceOutcome` | "Reconnect to room". |
| `{forget: sessionId}` | ack | |
| `{health: true}` / `{watchHealth: bool}` | `WatcherHealth` / pushed `{health}` | |
| `{list: true}` **new** | `Session[]` (`sessionSchema`), paged | What `host-sessions.ts` `LIST_SCRIPT` reads over SSH, computed in-process. Extract to `agent-providers/src/host/session-list.ts` and build `LIST_SCRIPT` from it, with a parity test. |
| `{journal: sessionId}` **new** | `Snapshot`, paged | A stopped or parked session read from its `events.jsonl`; `JournalTail.snapshot`'s replay (desktop `sdk-host/host-journal.ts`) moves into `agent-providers`. |
| `{page: {snapshotId, index}}` **new** | one page | See Paged answers. |
| `{attachment: …}`, `{attachmentCancel: transferId}` **new** | see Attachments | Closes main's "Console attachments have no path to the host" for all three paths. |

`ensure` is **refused**: it carries a full `SharedHostConfig` (worker paths
and credential locations) that Console must not dictate for a cloud worker.
Starting and restarting a cloud session stay `HostedOperation`s.

Mutating messages are `command`, `place`, `forget`, `attachment`,
`attachmentCancel`. Everything else is read-only; that split drives D2.

The loopback socket and the relay call one function: factor `serveControl`'s
per-message body into `handleControlMessage(links, ensure, control, message,
send)`; `serveControl` keeps the token handshake and the socket.

### Console → Core (gateway, user-authenticated)

**Owner only**, as #538 (`HostedLaunchStore.owned`). A launch that is not the
caller's, or not in the caller's tenant, is **404** (not 403), so existence
does not leak. Tenant admins cannot relay.

`POST /gateway/hosted-launches/{request_id}/relay`

```
request:  {"message": <relayed message>, "timeout_ms": int <= 30000}   // body <= 2 MiB
response: {"ok": bool, "value"?: any, "error"?: {"code", "message"},
           "worker": {"launch_revision": int, "boot_id": str, "generation": int}}
```

For a mutating message the route takes the launch lock, checks the launch is
awake and the worker attached at the current revision, bumps
`hosted_launches.relay_seq` (new, durable) and `active_at`, registers the
pending relay, commits, and only then enqueues the `relay` frame (D2, C6).
Read-only messages take no lock and carry `relay_seq: null`.

| Code | HTTP | When |
|---|---|---|
| `worker_sleeping` | 409 | `launch.sleeping` and not waking; body `wake_available: true`. Console offers an explicit wake (lifecycle route), never an implicit one. |
| `worker_waking` / `worker_not_attached` | 409 | Waking, provisioning, or no attached worker. Console retries with backoff; nothing is queued. |
| `generation_changed` | 409 | The reply came from, or the dispatch target became, another generation or revision. Console drops its live views and resnapshots. |
| `worker_busy` | 503 | Frame queue full. |
| `relay_timeout` | 504 | No reply by the deadline. Outcome unknown: Console reconciles through `snapshot` → `commandStatuses` (as `reconcileSessionCommand`), never by resending blind. |
| `refused_message` | 400 | `room`, `approvals`, `ensure`. |
| `too_large` | 413 | Request > 2 MiB. Replies are never too large: they are paged. |

`GET /gateway/hosted-launches/{request_id}/relay/stream?subscribe=<sessionId>[&subscribe=…][&watchHealth=1]`
is an SSE stream to Console with these frames:

- `event` `{sessionId, event}` and `failure` `{sessionId, failure}`;
- `health` `{health}`;
- `resync` `{sessionId | null, reason}`;
- `worker` `{launch_revision, boot_id, generation}`, sent first and again on
  change.

Core holds **one** worker subscription per `(launch, session)`, reference
counted across Console streams, and unsubscribes on the last close.
Per-Console buffer: 1000 frames or 4 MiB. Opening this stream is read-only
(D2).

### Core → watcher, watcher → Core

`relay` frames carry a uuid4 `id`. Pending relays live in an in-memory map
`id → {tenant, agent, launch_id, launch_revision, relay_seq, core_boot,
connection_id, generation, future, deadline}`; nothing is written to the
database but `relay_seq`. A detach, eviction or revision bump fails every
pending relay of that connection with `generation_changed`.

- `POST /agents/{agent_id}/connection/relay/{relay_id}`
  `{connection_id, generation, ok, value?, error?}`. The reply is 404 for an
  unknown relay or one registered to another agent. It is 409
  `generation_changed` when the caller is not the connection and generation
  the relay was dispatched to (`require_current`, as
  `connection_placements`). A second reply is 409 and ignored. Replies are ≤
  1 MiB plus envelope; a larger value is refused 413 and the watcher must
  page it.
- `POST /agents/{agent_id}/connection/relay/push`
  `{connection_id, generation, pushes: [{subscription: sessionId | "health",
  seq, event? | failure? | health?}]}`, batched by the watcher (≤ 250 ms or
  64 KiB). `seq` is per `(generation, subscription)`; Core forwards in order
  and sends `resync` on a gap. A push for a subscription Core no longer holds
  is answered `{unsubscribe: [...]}`.

### Paged answers and live views

`snapshot`, `journal` and `list` answers are paged; nothing is capped.

- **Pinning.** The first answer is `{snapshotId, epoch, throughSequence,
  bytes, sha256, pageCount, page: {index: 0, data}}`. The watcher serializes
  the answer once and pins the bytes under
  `<state root>/relay-pages/<snapshotId>`. `epoch` and `throughSequence` are
  the `Snapshot`'s (`session-v1` `snapshotSchema`). Pages are 1 MiB slices of
  that one serialization, so an entry larger than a page is simply split.
  Console reassembles, checks `bytes` and `sha256`, then parses.
- **Cursor retention.** `{page: {snapshotId, index}}` is valid for 120 s after
  the previous page was served. At most 4 pinned answers per watcher, at most
  64 MiB pinned bytes; beyond that a new request fails `snapshot_busy` (503,
  retry). An expired or unknown id is `snapshot_expired`: Console starts over.
  Pins are deleted on expiry, on generation change and at watcher start.
- **Subscribe first.** Console opens the relay stream with `subscribe` before
  requesting the snapshot, buffers live events, then drops those with
  `sequence ≤ throughSequence` and applies the rest. If the first buffered
  event is above `throughSequence + 1`, or a buffered event's `epoch` differs,
  that is a gap: resync. `transcripts.ts` `openTranscript` already does
  snapshot then live; it gains the buffering.
- **Resync** (Console discards the view, keeps the subscription, requests a
  new snapshot):

  | Reason | Signal |
  |---|---|
  | session reset (epoch changed) | a live event with a new `epoch`; a later `page` is `snapshot_superseded` |
  | generation or revision change | `worker` frame changes; pending pages fail `generation_changed` |
  | Console buffer overflow | `resync {reason: overflow}` |
  | push sequence gap | `resync {reason: gap}` |
  | page cursor expired | `snapshot_expired` |

  Three resyncs of one session within 30 s stop the loop and show an error.

### Attachments

- `{attachment: {transferId, sessionId, name, mimeType, size, sha256, index,
  count, chunk}}`: `chunk` is base64 of ≤ 1 MiB, and the whole file is at most
  `MAX_ATTACHMENT_BYTES` (10 MiB, `host/attachments.ts`).
- **Idempotent and ordered**: `(transferId, index)` identifies a chunk. An
  index below the next expected one is re-acknowledged without effect. An
  index above it is refused `out_of_order` with the expected index.
- **Digest**: on the last chunk the watcher checks `size` and `sha256`, then
  stages with `stageAttachment` and answers `{staged: {transferId, ref}}`. A
  mismatch deletes the transfer and fails `digest_mismatch`.
- **Bounds**: at most 4 transfers and 32 MiB staged per watcher; beyond that
  it fails `staging_full` (503).
- **Cleanup**: `attachmentCancel`, 120 s without a chunk, generation change,
  and watcher start all delete partial transfers. A staged `ref` is consumed
  once by the `command` that names it, and deleted unconsumed after 10 min.

### Tests that prove D1

- Relay round trip for each message against a real watcher over a fake stream
  (agent-providers) and the Core routes (core), including `list` / `journal`
  parity with `LIST_SCRIPT` / `JournalTail`.
- `room`, `approvals`, `ensure` refused; a foreign tenant, a non-owner, a
  tenant admin and a deleted launch all get 404.
- A reply from a superseded generation is refused and the Console request
  fails `generation_changed`; a revision bump mid-request does the same.
- `test_snapshot_pages_pinned_across_events`: events and a reset land between
  pages; the pages still form the pinned snapshot, and the reset yields
  `snapshot_superseded` and a resync.
- `test_subscribe_before_snapshot_no_loss`: events land while the
  subscription is being set up; no event is lost or applied twice.
- `snapshot_expired` after 120 s idle; `snapshot_busy` at the fifth pin.
- Attachments: a chunk resent after a lost reply, out of order, a digest
  mismatch, `staging_full`, and a disconnect mid-transfer (partial deleted).
- Two Console streams on one session create one worker subscription; overflow
  yields `resync`.
- Nothing relayed reaches the database or the log (captured logs and a table
  scan).

## D2 — Idle report and autostop

### Report (watcher → Core)

`POST /agents/{agent_id}/connection/idle`, accepted only from the attached
worker (`require_current`). Sent on every change and at least every
`report_every_s` (30).

```
{
  "connection_id": str, "generation": int,
  "report_seq": int,          // monotonic per watcher process; lower or equal is ignored
  "relays_through": int,      // highest relay_seq the watcher has applied and reflected in busy
  "busy": bool,
  "reasons": [{"kind": str, "session_id": str | null, "count": int}],
  "sessions": {"total": int, "live": int, "parked": int, "failed": int}
}
response: {"queued_operations": [id], "credential_revision": str | null}
```

The response is the durable catch-up for lost `operation` and `credential`
doorbells.

The reason kinds are:

- `turn_running`, `turn_starting`;
- `room_pending`: the watcher's pump queue, or a held room for a session;
- `approval_open`, `reset_waiting`, `operation_claimed`, `relay_inflight`;
- `console_recent`: a **mutating** relay in the last 10 minutes. Read-only
  messages (`list`, `snapshot`, `journal`, `page`, `health`, `subscribe`) and
  an open live view do not count, so a forgotten window cannot pin a VM;
- `failed_holding` (below).

Per-session busy is one predicate shared with parking: extract
`shared-host.ts`'s `idleEnough` conditions (status ready, no running turn, no
open request, no `resetDecisionPending`, no pending room input) into
`sessionBusy(snapshot, host)`. The host announces it to its parent as a new
host → parent message `{kind: 'busy', busy, reasons}` (`session-channel.ts`
`fromChildSchema`) on every change. A host that is not running and has
nothing queued in the watcher is idle. Parking (`SWITCH_SESSION_PARK_AFTER_MS`,
30 min) is unchanged; a parked host is idle for this report.

**Bounded holds**: a session whose host failed to start
(`SessionHostFailedError`, `pumps` entry `failed`) with queued room messages,
or one waiting on a reset decision, reports `failed_holding` /
`reset_waiting` as busy for at most 15 minutes after its failure notice was
posted, then idle. Its messages stay in the watcher journal and are retried on
the next address after wake.

Core stores the latest accepted report on the `Connection` with its own
monotonic `received_at`. It is **fresh** when the connection is alive, the
current generation, bound to the launch's current revision, and `received_at`
is within `fresh_for_s` (75). Core restart, detach, generation change and
revision bump all make it absent. **Absent or stale = busy.**

### Activity Core knows about

A command can be dispatched and still be invisible to the next idle report.
The watcher may have sent the report before it applied the command, or before
the host posted `busy`. So Core does not wait to be told:

- Under the launch lock, a mutating relay bumps `relay_seq` and sets
  `active_at = now` before the frame is sent (D1).
- While any mutating relay of the launch is pending (in the in-memory map),
  the launch is busy.
- Once replies are in, idle is trusted again only from a report with
  `relays_through ≥ hosted_launches.relay_seq`. The watcher advances
  `relays_through` only after the host has taken the command, so its `busy`
  already reflects it. A report below the watermark counts as busy.
  `relay_seq` is durable, so the watermark survives a Core restart: the report
  is absent then anyway.
- Read-only relays, the relay stream and snapshots take no lock and touch
  neither `active_at` nor the watermark.

### Decision (controller observation)

`hosted_controller.observe` *(#538)* replaces `HostedLaunchStore.idle_busy`
with `idle_evidence(launch)`. The launch is busy when any of these holds:

1. there is no fresh report, the report says `busy`, or `relays_through <
   relay_seq`;
2. a mutating relay of the launch is pending;
3. a `hosted_operations` row is `queued`/`claimed` at the current revision;
4. a `hosted_wake_mailbox` row for the agent is `pending`, `offered`,
   `accepted` or `cancel_requested` (D3);
5. an `approval_requests` row for the agent is `open` (main's
   `session_activity` tables).

Busy sets `active_at = now` (as today). The launch stops only when all of the
following hold, under the launch advisory lock, in one transaction:

- not busy, `spec.auto_session` true, `hosted_idle_stop_minutes > 0`
  (`config.py` *(#538)*, default 0 = off);
- `now - active_at >= hosted_idle_stop_minutes`;
- the report's `received_at` is later than `active_at` (`note_addressed` and
  mutating relays bump `active_at` under the same lock);
- `launch.revision` is the one the report's connection is bound to.

Then `desired_state = stopped`, `state = stopping`, `sleeping = true` and
`revision += 1`, as today. The bump evicts the worker (`launch_superseded`)
and obsoletes its capability, so nothing it sends afterwards counts. An
addressed event or relay racing the decision either commits first (bumps
`active_at`, and the recheck fails) or after (the launch is `sleeping`: an
addressed event wakes it and lands in the mailbox, and a relay is refused
`worker_sleeping`). The EBS volume survives an EC2 stop.

### Tests that prove D2

- A pending approval, a running turn, a queued pump message and a claimed
  operation each keep the VM up across 3 grace windows.
- No report, a stale report, a superseded generation, and a Core restart each
  count as busy.
- `test_command_dispatch_races_autostop`: a Console prompt is dispatched after
  the watcher's last idle report and before the host posts `busy`, and
  observation runs in between → no stop (pending relay, then watermark).
- `test_read_only_relay_does_not_renew_activity`: `list`, `snapshot`, `page`
  and an open relay stream for longer than the grace window → the VM stops.
- A mention between the last idle report and the decision prevents the stop.
- A failed host with queued messages stops holding after 15 minutes.
- `sessionBusy` and parking agree (one predicate, table test).

## D3 — Wake mailbox

The mailbox **always writes** for hosted agents, whether or not a worker is
attached. An "is it attached?" check followed by delivery can lose an event
to a stream that dies, or a Core that restarts, before the watcher journals
it.

### Table `hosted_wake_mailbox`

Tenant-scoped with RLS, like every table in main's `545f80e11f13`.

| Column | Meaning |
|---|---|
| `tenant_id, agent_id, room_id, message_id` | Primary key. `message_id` is `roomInputId(event)` (`host/room-inbox.ts`): the message id for an addressed message, `type:sha256` for a listened `room_join` or task event. The dedupe key everywhere. |
| `launch_id` | FK to `hosted_launches`, `ON DELETE CASCADE`. |
| `thread_id` | The platform thread from the event payload (`payload.thread_id`, as `threadOf` in `shared-watcher.ts` reads it), so notices land in-thread without a lookup. |
| `event` | JSONB `{type, payload, missed}` as the watcher's `onEvent` builds `Handoff.event`. |
| `state` | See below. |
| `ever_offered` | Set on the first offer and never cleared. |
| `offered_to`, `offered_until` | `core_boot:connection_id:generation` and the lease, while `offered`. |
| `origin` | `live` or `cutover` (Migration). |
| `addressed_at, updated_at, expires_at` | |

Index `(tenant_id, agent_id, state, addressed_at)`.

States:

```
pending ──offer──▶ offered ──ack journaled──▶ accepted ──ack admitted──▶ admitted
   ▲                  │                          │
   └──lease expiry / ─┘                          │
      foreign boot or generation                 │
explicit Stop: pending & !ever_offered ─▶ cancelled                       (definite)
               pending & ever_offered, offered, accepted ─▶ cancel_requested
cancel_requested ─watcher─▶ cancelled (not admitted) | admitted (already running)
other terminal: refused, duplicate, expired (never offered), expired_uncertain
```

### Write

For a hosted agent every addressed event is written in the same transaction
as `note_addressed` *(#538)*. That happens in `agent_client.py`
`_note_hosted_addressed` and `on_task_delegate` *(#538)*.
`ON CONFLICT DO NOTHING` makes a redelivered Matrix event a no-op. Traffic is
chat-rate, so the cost is one insert per addressed event, for hosted agents
only.

The event is not written, and the room is told why through the existing
unavailable reply, when `desired_state` is `stopped` with `sleeping` false
(explicit Stop), `deleted`, or `state = error`. If the agent already has 500
rows `pending` or `offered`, the insert is refused and the room is told:
loud, not a silent drop.

### Offer (lease, then send)

Delivery to the watcher always follows **mark offered, then send**:

1. `UPDATE … SET state = 'offered', ever_offered = true, offered_to = :me,
   offered_until = now() + 60 s WHERE state = 'pending'` (conditional; it can
   never overwrite an `accepted` or later row), commit;
2. then enqueue: into the `EventBuffer` for a live event, or into a `wake`
   frame for a row sent on attach.

- **Live, worker attached**: after the insert commits, the normal buffer path
  runs behind step 1. Without an attached worker the row stays `pending`.
- **On attach**: every `pending` row, oldest first per room, as `wake` frames
  before the first buffered event.
- **Reclaim** runs on attach (for that agent), at Core start, and every 30 s
  in the upkeep loop (`session_activity/maintenance.py`). It moves `offered →
  pending` when the lease has expired, when `offered_to` names another Core
  boot, or when it names a generation that is no longer attached. Reclaimed
  rows are offered again, and the watcher dedupes.

A Core hard crash after step 1 leaves `offered` rows with a foreign boot;
reclaim at start returns them. A crash between the insert and step 1 leaves
`pending`, which is delivered on attach.

### Ack (retried)

`POST /agents/{agent_id}/connection/mailbox/ack`
`{connection_id, generation, entries: [{room_id, message_id, outcome, reason?}]}`
is accepted from the attached worker at the current revision. Every
transition is a conditional update that only moves forward:

| Outcome | Sent when | Row |
|---|---|---|
| `journaled` | the `parked` or assignment record is on disk (`host/journal.ts` syncs on append) | `pending`/`offered` → `accepted` |
| `admitted` | the session host has taken it (host `inbox.jsonl` `accepted`) | `accepted` → `admitted` |
| `duplicate` | the journal already has it | → `accepted` or `admitted` as the journal says |
| `refused` | the watcher will not act on it (limit reached and auto-start off); the watcher posts the notice | → `refused` |
| `cancelled` / `admitted` | reply to a cancel (below) | `cancel_requested` → `cancelled` / `admitted` |

An ack for a row already at or past the target state is `ok`. An ack from a
`pending` row (reclaimed while the ack was in flight) is applied, so a lease
expiry never loses an ack. The watcher appends `mailbox-acked {room, message,
outcome}` to `assignments.jsonl` after Core confirms. It re-sends every
unconfirmed ack on attach and with every idle report, ≤ 200 per call. A lost
ack without a reconnect is therefore retried within 30 s. Even if the retries
fail, lease expiry re-offers the row and the watcher answers `duplicate`.

The watcher treats `wake` and live events alike: a held delivery keyed by room
and message, never by sequence. It goes through `SharedWatchAssignments.park`
(the `parked` record stores the event and is keyed by `delivery(room,
message)`), then the normal `admit` path. It skips a delivery when the
journal already has an assignment, `parked` or `released` record for the same
`(room, message)`, or the pump queue holds it.

### Acceptance boundary and Stop

**A row is accepted when the watcher's journal record is fsynced.** From then
on only the watcher can say whether it ran. Core therefore announces an
outcome as definite only when it knows it:

- **Explicit Stop** (lifecycle route, in its transaction) moves rows that were
  never offered to `cancelled`, and posts one notice per room in-thread:
  "cancelled, not run". It moves `offered`, `accepted` and ever-offered
  `pending` rows to `cancel_requested`, with no notice yet. `admitted` rows
  are untouched. Explicit Stop never wakes.
- If the worker is still attached, Core sends `mailbox_cancel` before the VM
  stops. In every case the `cancelled` list rides on the next
  `worker_attached`. `cancel_requested` rows are durable tombstones: kept until
  the watcher answers or the launch is deleted.
- **Watcher reconcile, before admission.** On boot the watcher admits nothing
  from its journal (held rooms, parked deliveries, pump queue) until it has
  processed `worker_attached.cancelled`. For each entry:
  - journaled and not yet admitted to a host: append `released` with reason
    `cancelled` (fsynced), then ack `cancelled`, and Core posts "cancelled,
    not run";
  - already admitted: ack `admitted`, and Core posts "had already started
    before Stop";
  - unknown to the journal: ack `cancelled`, which is definite because
    nothing on the worker has it.
- A launch deleted with `cancel_requested` rows posts nothing (the agent is
  removed); no outcome is invented.

### Retention

Rows that were never offered and are still `pending` expire after 24 h
(`expired`, one notice per room, in-thread: "expired, not run"). Ever-offered
rows past 24 h move to `expired_uncertain`, with a notice that says delivery
could not be confirmed and never claims the event did not run. Terminal rows
are pruned 7 days after `updated_at` by the upkeep loop.

### Tests that prove D3

- Sleep → mention → wake → exactly one turn, with Core restarted before
  attach, after `wake` is sent but before ack, and after ack.
- `test_core_crash_after_offer_reclaims`: rows `offered` under a dead boot go
  back to `pending` at start and are delivered once.
- `test_lost_ack_retried_without_reconnect`: the ack POST fails once on a
  healthy stream → retried with the next idle report; the row is `accepted`.
- `test_offer_ack_race_never_regresses`: an ack commits between reclaim and
  re-offer; the re-offer's conditional update does not touch the row.
- `test_stop_between_fsync_and_ack`: the row is `cancel_requested`; next boot
  the watcher releases it and acks `cancelled`; notice "not run"; no turn.
- `test_stop_between_ack_and_admission`: same, from `accepted`.
- `test_stop_after_admission`: acked `admitted`; notice "had already started".
- Mention while attached, stream killed before the watcher journals: one turn
  after reconnect.
- The 501st `pending`/`offered` insert is refused with a room notice; expiry
  notices distinguish `expired` from `expired_uncertain`.

## Operations: `hosted_operations` as the infra queue

`HostedOperation` *(#538)* keeps `start` / `restart` of a cloud session:
durable, idempotent by client-chosen `id`, with an outcome record. Console's
other session actions go through the relay.

- **Admission moves to the watcher.** `session_operation` *(#538)* stops
  reading `SdkSession`. Core checks only ownership, launch `ready`/`running`,
  id reuse, and one pending operation per session.
- **Doorbell, not payload.** An insert sends an `operation {id}` frame to the
  attached worker. Core re-rings every 5 s while the row is `queued`, up to 6
  times. The durable catch-up is `worker_attached.queued_operations` and the
  idle-report response, so a doorbell lost on a healthy connection costs at
  most one report interval (30 s). `runHostedControl`'s 2 s poll *(#538)* goes.
- **A doorbell only prompts a fenced claim; it never replays an operation.**
  `POST /hosted/operations/{id}/claim` `{connection_id, generation}` replaces
  `/operations/claim`. It moves `queued → claimed` only for the attached
  worker at `operation.launch_revision`, storing `claimed_by =
  core_boot:connection_id:generation` and `claimed_boot_id` (new columns).
  Anything else is 409, including a second claim. A doorbell for a claimed or
  finished id is ignored.
- **Result**: `POST /hosted/operations/{id}/result` as today, plus
  `{connection_id, generation}`. The watcher writes the outcome to
  `operations.jsonl` before posting and re-posts every unconfirmed outcome on
  each attach. A lost result is recovered, not re-executed ("a lost result is
  never a reason to execute the operation again", `hosted-control.ts`
  *(#538)*, stays true). Core accepts a re-post from a later generation of the
  same host boot (`claimed_boot_id` matches).
- **States** unchanged: a revision mismatch turns `queued → failed` and
  `claimed → unknown` (`fail_stale_operations`); `claimed` for 5 minutes with
  no result → `unknown`, which tells the owner to inspect the session via
  `snapshot`/`journal`.

Tests: `test_operation_doorbell_lost_on_healthy_stream` (claimed within one
report interval); a duplicate doorbell after claim causes no second
execution; lost claim reply and lost result → one execution, outcome
recovered.

## Session existence and slot admission (watcher)

One serial section in `runSharedWatcher` (the existing `pending` promise
chain) decides for both auto-created sessions (`admit` →
`assignments.assign`) and operations (`start` / `restart`):

- `start` for a session id that exists under `sharedSessionsBase()` → result
  `failed` "already exists"; `restart` for one that does not, or that belongs
  to another agent → `failed` "not found" (as `executeHostedOperation`
  *(#538)* checks today).
- Active means live or starting, not stopped, not retired; parked counts as
  active. `start`, `restart` of a stopped session, and a new auto-created
  session are refused when active ≥ `limits.sessions_per_agent`
  (`hosted_sessions_per_agent`, default 8). A refused operation is `failed`
  "session limit"; a refused auto-create posts a notice (reason `capacity`)
  and acks the mailbox row `refused`.
- Local and SSH watchers get the same check with no limit configured.

Test: two concurrent starts plus one auto-create at limit − 1 admit exactly
one.

## Credentials

`POST /hosted/provider-credential` *(#538)* drops `sessions` (it lists
`SdkSession`s; the watcher knows its own) and keeps `{status, kind, provider,
revision, credential}` with `Cache-Control: no-store`.

- **Doorbell**: a change to the owner's `provider_connections` row
  (`verified_at` moves, or the row is deleted) sends `credential {revision}`
  to the attached worker. The frame carries no secret.
- **Fetch**: on the doorbell, on each attach, and whenever
  `credential_revision` in an idle-report response differs from the one
  applied. The 2 s poll *(#538)* goes.
- **Apply**: a new revision is materialized (`materializeHostedProvider`),
  then each live session restarts at its next idle point, never mid-turn.
  Codex keeps #538's `refreshCodexAuthentication` in `codex/home.ts` rather
  than main's copy-once, in hosted mode only. `revoked` stops every host
  (`supervision.stop`), reports idle, and makes addressed events answer
  "provider disconnected" instead of starting sessions. GitHub installation
  tokens (`/hosted/github-credential`, `github_issued_tokens`) are unchanged.
- **Wake while revoked** does not start the VM: `note_addressed` refuses to
  wake a launch whose provider connection is missing, and the room is told to
  have the owner reconnect. #538's `note_addressed` has no such check.

## Failure notices

#538's `POST /agent-sessions/{id}/room-failure` depends on
`SessionAuthority`, which is gone. It is replaced by an agent-authenticated
`POST /agents/{agent_id}/room-notices`
`{connection_id, generation, room_id, message_id, thread_id, reason}`, with
reasons `startup | delivery | conversation | capacity | stopped | expired |
cancelled | revoked | upgrade`:

- Authorization equals `post_message`'s for this agent (the agent's client is
  in the room, the room is not archived) plus: the caller is the attached
  worker, and `message_id` is a message in that room. Posting goes through
  `protocol.send_message` in `thread_id`.
- **Once per message and reason**: the key `[agent, room, message, reason]`
  under an advisory lock, checked against `messages.content.switch_room_failure`
  as #538 does. Core-originated reasons (`stopped`, `expired`, `cancelled`,
  `upgrade`) use the same function, with the thread taken from the mailbox row.
- Not an MCP tool, so the tool surface and the Switch skill are unchanged.
  Main's `announceStartFailure` (`watcher-tools.ts`) stays for local and SSH.

The watcher keeps unsent notices in `notices.jsonl` and retries them on
attach.

## Room controls while sleeping

`commands.py` `_dispatch_control_command`: compute `delivered = placed is not
None and relay_session_command(...)`, where the relay goes only to the
attached worker. When nothing was delivered and the agent is hosted:

- `!reset`: if the launch is sleeping or waking, call `note_addressed` (which
  wakes it) and reply "The cloud worker is waking up. The reset was not
  queued … send `!reset` again" (#538 wording). This is two steps on purpose:
  a destructive command is never queued for later. Not written to the
  mailbox.
- `!interrupt`, `!compact`: reply that the agent is asleep and nothing is
  running; do not wake.
- Otherwise main's existing "controller is not connected" reply.

Placements are in memory in Core and restated by the watcher on attach, so a
sleeping agent has no placement. The check must not rely on `placed`.

## Migration

### Schema

Our 11 revisions are applied on the shared pilot with parent `2d84b6f1c705`:
`ab921ef034cd → c29f7018ea44 → e7240c165b92 → f138a612de04 →
a472be90d1f6 → 48ab0298a34b → 51bc94a017d2 → 62cf05b128e3 → 73da16c239f4 →
84eb27d340a5 → 95fc38e451b6`. None references the tables `b9e4d2a71c05`
drops (checked by grep). Never edit or re-parent them.

1. `<rev>_hosted_cutover_manifest`, child of `95fc38e451b6`, deployed with
   the transitional build (Pilot order). It adds `hosted_cutover_volumes
   (tenant_id, launch_id, preflight_state, manifest_sha256, completed_at)` and
   `hosted_cutover_items (tenant_id, agent_id, launch_id, session_id, kind,
   room_id, message_id, thread_id, disposition, payload JSONB NULL,
   notice_posted_at)`, with RLS.
2. `<rev>_merge_hosted_and_session_activity`: `down_revision =
   ("<cutover_manifest>", "e3b7c9d2a415")`, with empty upgrade and downgrade.
3. `<rev>_hosted_activity`: `hosted_wake_mailbox` (RLS, grants as
   `545f80e11f13`). `hosted_launches.worker_capability_hash`,
   `worker_capability_revision`, `relay_seq`. `hosted_operations.claimed_by`,
   `claimed_boot_id`. It also copies every `hosted_cutover_items` row with
   disposition `import` into the mailbox as `pending`, `origin = cutover`,
   `expires_at = now() + 24 h`.

An empty merge only proves the graph has one head. It does not prove the
cutover is safe. The migration tests are real upgrades with data, against
PostgreSQL:

- `test_upgrade_from_hosted_head`: seed a database at `95fc38e451b6` with
  launches, operations, `sdk_*` rows, room-failure receipts and cutover items;
  `alembic upgrade heads`. Launches and operations are intact, `import` items
  are in the mailbox, the `sdk_*` tables are gone.
- `test_upgrade_from_main_head`: seed at `e3b7c9d2a415` (a main deployment
  that never had hosted agents) and upgrade. The hosted tables are created
  empty and nothing else changes.
- `alembic heads` is one head; `test_frozen_ddl_matches_create_all.py` still
  passes (no new NOTIFY DDL: mailbox delivery is offer-on-attach plus live
  buffer).
- `test_cutover_refuses_incomplete_preflight` (below).

### Preflight: pending work on retained volumes

The #538 volumes hold work that main's code cannot pick up as-is (checked at
`758bc5ae`):

- `room-inbox.jsonl` `received` records carry `{sequence, roomId, messageId,
  missed, gap}`. There is **no event body**: #538 submitted the ids to Core
  (`shared-host.ts` → `/room-message`), and Core rebuilt the prompt from
  `messages` (`delivery/replay.py` `replay_room_event`, which refuses anything
  older than the 15-minute buffer window and multi-file groups). Main has
  neither the route nor `delivery/replay.py` / `transport/stored_event.py`.
- `assignments.jsonl` holds `{sequence, roomId, messageId, config}` and
  `restarted` records only (no `handled`, `parked`, `released`). Main's schema
  is a superset, but `config` must parse under main's `sharedConfigSchema`.
- Per-session `inbox.jsonl` uses the same record types as main
  (`accepted{command}`, `dispatched`, `finished`, `stopped`, `reset-started`,
  `reset-completed`, …). Commands carry `origin.{roomId, threadId,
  messageId}`.
- #538 has no `handoff.ts`; main's `handoff.ts` is the in-memory `Handoff`
  type and `HostWaker`, not a file. So no handoff file needs importing.

Main's host recovery (`session-host.ts`, on load) already settles what the
host holds:

- open requests become `request.settled` `interrupted`;
- `accepted`/`dispatched` commands become `command.status` `unknown`
  (`HOST_RESTARTED`, not resent), with a transcript notice;
- `reset-started` without `reset-completed` waits for a reset decision
  (`RESET_OUTCOME_UNKNOWN`).

So reset state is preserved as-is, and request state is preserved as
`interrupted`: a provider's pending permission call dies with its process on
both branches. What remains is making room-originated work visible, or
running it once.

The **preflight** is `hosted-preflight` (new, agent-providers). It is built
from the new image's code and runs read-only against each retained volume
while the transitional Core is up. For each session root and the watcher root
it:

1. parses every journal (`assignments.jsonl`, `room-inbox.jsonl`,
   `inbox.jsonl`, `events.jsonl`, `delivery-*.jsonl`, `shared-state.jsonl`)
   with **main's** schemas. Any failure blocks that volume and names the file
   and line;
2. lists, without bodies:
   - `room_pending`: `received` records with no `ack`;
   - `command_pending`: `accepted` with no `dispatched`, split by origin
     (room or Console);
   - `command_uncertain`: `dispatched` with no `finished`;
   - `request_open` (from `events.jsonl`);
   - `reset_pending`;
3. uploads the manifest to `POST /gateway/hosted-cutover/{launch_id}/manifest`
   (tenant admin), which stores it in `hosted_cutover_items` and records its
   digest.

The transitional Core then gives every item a disposition, joining
`messages` (by `transport_event_id`) with `sdk_session_commands` receipts:

| Item | Disposition |
|---|---|
| `room_pending` or room-origin `command_pending`, with no finished command receipt for `(room, message)` | `import`: the payload is rebuilt with `to_inbound` and `message_payload` (replay's reconstruction without the 15-minute window) into `payload`. On a multi-file group, a missing blob or a deleted message it becomes `unrecoverable` instead. |
| any item with a finished receipt | `ran`, dropped |
| `command_uncertain` (room) | `uncertain`: notice "may have been interrupted by the upgrade; re-send if needed" |
| Console-origin `command_pending` | `settled_by_host`: main's host marks it `unknown` in the transcript Console shows; nothing is posted to a room, so no private prompt text leaks |
| undelivered Core-side `sdk_session_commands` (room origin) | `import` as above; Console origin → owner notice without the prompt text |
| `request_open` | `interrupted`: in-thread notice "the approval was interrupted by an upgrade; ask the agent again" (reason `upgrade`) |
| `reset_pending` | `preserved`: no action |
| `unrecoverable` | notice "could not be carried across the upgrade; please send it again" |

Notices are posted by the transitional Core, once per key, through #538's
room-failure receipt path, before anything is deleted. Imported payloads live
only in `hosted_cutover_items` until the `hosted_activity` revision copies
them into the mailbox. Nothing is written to a file.

**Gate.** Before `b9e4d2a71c05` can run, every non-deleted launch needs a
volume with `preflight_state = complete`, every item needs a disposition, and
every notice must be posted. `alembic upgrade heads` would order
`b9e4d2a71c05` freely between the branches, so the cutover runs through a
wrapper (`just hosted-cutover-upgrade`) that checks this and refuses. A guard
inside `b9e4d2a71c05` or `env.py` is rejected: it would run on every main
deployment.

### Pilot order

The pilot sits on our head; main's `a7e1c4b90d23 … e3b7c9d2a415` are not
applied. Among them `b9e4d2a71c05` drops `sdk_sessions`, `sdk_session_events`,
`sdk_session_commands`, `sdk_room_admissions` and `session_request_posts`,
and deletes blobs tied to them. Its downgrade raises.

1. Stop every hosted launch through the controller with desired `stopped`
   and `sleeping = false` (explicit Stop, so nothing wakes), and wait for
   `stopped`. Volumes persist.
2. Deploy the transitional Core (#538 plus the cutover-manifest revision, the
   manifest route and the disposition job).
3. Run the preflight on every retained volume; resolve blocked volumes; wait
   for the dispositions and notices.
4. `pg_dump` the pilot database.
5. Deploy the new Core through `just hosted-cutover-upgrade` (main's chain,
   including the destructive revision, then the merge and `hosted_activity`).
6. Roll the worker image (first-boot migration below), then Console.

### Cutover gating (Core + worker + Console together)

- Core refuses a hosted stream below protocol 7 (`upgrade_required`), so an
  old worker image cannot half-work against new Core. The controller launches
  the runtime build Core names in the spec.
- Console detects `hosted_relay` on the version route (`version_routes.py`)
  and otherwise shows "update Switch Console" for cloud agents. An old
  Console against new Core fails on the removed `sharedList` path;
  compatibility is waived as in main's step 7.
- An old Core never sees a new worker: images are rolled after Core.

### Retained worker state (first boot of the new image)

The bootstrap runs this before the daemon starts. It is idempotent, and each
step is recorded in `<state root>/state-version.json` so a crash resumes it:

- **Room inbox**: `room-inbox.jsonl` is renamed to
  `room-inbox.jsonl.pre-cutover` and **not** imported. Its pending entries
  reach the watcher through the mailbox (`origin = cutover`), so there is one
  source and dedupe by `(room, message)` covers any overlap.
- **Assignments**: rewritten to main's schema if the preflight found `config`
  differences; the original is kept as `.pre-cutover`. Sequence numbers stay
  valid: #538 already used the per-boot floor and the new Core continues the
  same `agent_event_boot` sequence.
- **Session journals** stay in place; main's host recovery settles them (see
  Preflight).
- **Placements**: none to write. `SessionPlacements.open(root, () =>
  assignments.placements())` derives them from `assignments.jsonl` for a
  watcher with no `placements.json`; Console-started sessions use their
  config's `roomConnection.restoreRoomId`.
- **Native, config and provider homes**: Codex homes are
  `<root>/<sha256(sessionId)>` on both branches (`codex/home.ts`). The
  preflight also checks that OpenCode data dirs and Claude project dirs
  resolve to the same paths under main's `provider-home.ts`; the first boot
  moves (renames on the same volume) where they do not. No credential is
  copied into a config file.
- **Pending operations**: an operation applied before the cutover with an
  unposted result is recorded in `operations.jsonl` and re-posted. The Core
  row has become `failed`/`unknown` by revision bump, the re-post is refused
  409, and that is logged, not retried.
- **Activity**: with `activity-reported.jsonl` absent, main starts reporting at
  the journal's end, so no history is replayed to the platforms.

## Data held where

| What | Where | Durable? |
|---|---|---|
| Transcripts, provider state, native homes, placements, room journal, operation outcomes, unsent notices, unconfirmed acks, pinned pages, staged attachments | Worker volume | Yes (survives EC2 stop); pages and partial transfers are cleared at start |
| Launch, revision, sleeping, `active_at`, worker capability hash, `relay_seq` | `hosted_launches` | Yes |
| Start/restart commands and outcomes | `hosted_operations` | Yes |
| Addressed events until admitted, and Stop tombstones | `hosted_wake_mailbox` | Yes, ≤ 24 h open, 7 d terminal |
| Pre-cutover pending work | `hosted_cutover_items` | Until the mailbox copy; drop after the pilot |
| Approval requests, activity rows | main's `session_activity` tables | Yes (as main) |
| Idle report, pending relays, live subscriptions, placements, frame queues | `ConnectionRegistry` | No: lost on Core restart, and loss means busy / retry |

## What the contracts cannot say

- A relay timeout leaves a command's outcome unknown until Console reads a
  snapshot. If the worker went to sleep in between, only a wake answers it.
- Sleeping sessions cannot be inspected without waking: Core holds no
  transcript by design. A read-only cache of the last snapshot was rejected
  for that reason.
- `console_recent` is a heuristic; ten minutes is arbitrary.
- The mailbox guarantees one hand-off to the watcher journal and an honest
  outcome, not exactly-once turns. A host that crashes mid-turn after
  admission is main's recovery story: the turn is reported interrupted, not
  resent.
- Pre-cutover room messages older than the platform's own history (a deleted
  message) can only be reported, not replayed.

## Open questions

1. Whether a tenant admin should get read-only relay (`list`, `snapshot`) for
   support. Relay is owner-only in this note, as #538 is.
2. The 500-row mailbox bound and the 24 h expiry are guesses; revisit with
   pilot traffic.

## Work packages

- **WP1 base port.** Rebase #538's non-session parts onto main: controller,
  launches, provider and GitHub connections, bootstrap, `agent_event_boot`
  floor with the below-floor restart branch, `ac2ffa1d`. Remove every
  `SdkSession` / `SessionAuthority` use (`hosted_routes.py`,
  `hosted_launches.py`, `hosted_launch_store.py`, `session_routes.py`,
  `sessions/service.py`, `commands.py`). Merge revision. Tests: real upgrades
  from both heads; #538's controller and launch tests green;
  `test_stream_reports_restart_below_floor`.
- **WP2 worker runtime on `--watch-worker`.** Main's `--watch-worker` branch
  of `shared-daemon.ts` with `SessionLinks` and in-process supervision; drop
  `runHostedControl`'s loop; factor `handleControlMessage` out of
  `serveControl`. Adds `list`, `journal`, paged answers, attachment transfers,
  capability file and attach headers, idle report with `relays_through`,
  `busy` IPC, the doorbell handlers (`operation`, `credential`) with claim and
  result via `operations.jsonl`, watcher-side admission, reconcile-before-admit
  for `cancelled`, retried acks, `notices.jsonl`.
- **WP3 server.** Worker capability: minted in `prepare`, checked on stream
  open, one attached worker, `hosted_worker_only` gating of opens, reattach,
  subscribe and placements, `launch_superseded` eviction, and room-control
  relay narrowed to the worker. Protocol 7 frames (`worker_attached`, `relay`,
  `relay_cancel`, `wake`, `mailbox_cancel`, `operation`, `credential`) with
  bounded per-connection queues. Gateway relay route and relay stream
  (owner-only, 2 MiB requests, paged replies, resync reasons); agent relay
  reply and push routes. `relay_seq` and `active_at` stamping under the launch
  lock, pending-relay busy, idle report storage, `idle_evidence` with the
  watermark. Operation doorbell with re-ring, fenced claim, result re-post.
  Credential doorbell and idle-report catch-up.
  `/agents/{id}/room-notices`. `!reset` two-step.
- **WP4 mailbox.** Table with states, leases and `ever_offered`; write in
  `note_addressed`'s transaction; mark-offered-then-send on the live path and
  on attach; reclaim on attach, at start and in upkeep; forward-only ack
  route; Stop's `cancelled` / `cancel_requested` split and tombstone delivery;
  expiry (`expired` vs `expired_uncertain`) and pruning; the 500-row bound.
- **WP5 Console cloud.** A `CloudRelayClient` with `ControlClient`'s
  interface; `askHost`, `transcripts.ts` (subscribe-first, paged snapshot,
  resync), `host-sessions.ts`, the health monitor and stop/forget route cloud
  agents through it; chunked attachment upload; `sleeping` and `waking` shown
  as health states from the launch, with an explicit wake; the cloud sidebar
  reads `list` instead of polling `sharedList`.
- **WP6 cutover and state migration.** The transitional build
  (cutover-manifest revision, manifest route, disposition job and notices),
  `hosted-preflight`, the `just hosted-cutover-upgrade` gate, the pilot
  runbook above, the first-boot migration, and version gates on all three
  sides.
- **WP7 acceptance** (`just bench` scenarios plus a pilot run):
  1. retained Codex and OpenCode conversations resume after cutover; a
     pre-cutover pending room message runs exactly once or is reported;
  2. two sessions on one worker, room takeover between them
     (`replace_placements`, `room_released`);
  3. a pending approval, a running turn and a just-dispatched Console prompt
     never auto-stop;
  4. sleep → mention → exactly one turn, across a Core restart at each step;
  5. explicit Stop never wakes; nothing reported "not run" ever runs;
  6. lost doorbell, lost claim and lost result: no double execution, outcome
     recovered;
  7. a generation change mid-relay, mid-page and mid-operation is fenced;
     an old VM and a local Console cannot attach;
  8. revoked provider credentials: hosts stop, no restart loop, no wake;
  9. tenant isolation: foreign tenant and non-owner relay, ack, claim and
     notice calls all 404/403 and leak nothing;
  10. load: many hosted agents with many parked sessions keep Core CPU and
      pool use flat (idle reports only; no per-session traffic).

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
| worker capability | `hosted_launches.worker_capability_hash`, `worker_capability_encrypted`, `worker_capability_revision` (new) | first `prepare` at each running revision |
| `Connection.stream_generation` | memory (`ConnectionRegistry._new_incarnation`, random seed per boot) | every stream open or reattach |
| Core boot | `agent_event_boot` sequence *(#538, migration `51bc94a017d2`)* | every Core start |

A durable record that names a connection (`offered_to`, `claimed_by`) stores
`core_boot:connection_id:generation`. Generations are only unique within one
Core boot, so a record from another boot is treated as foreign, never
compared.

### Issuance: one capability per running revision

The capability has to follow the revision, and the revision changes on every
wake, while the `request_id` and the retained VM stay the same. Today's
controller never gets a new bundle to a woken VM
(`deploy/hosted/controller/.../gateway.py` `accept_launch` *(#538)*):

- it returns early once `instance_launch_issued` is set, which stays true for
  the retained instance;
- otherwise it calls `prepare` only when the assignment secret has no version
  whose `ClientRequestToken` is the `request_id`, which is true after the
  first launch;
- the reconciler starts a stopped instance as soon as desired is `running`
  (`reconciler.py` `_running`: `state == "stopped"` → `start_instance`),
  without waiting for any bundle.

The worker reads the assignment secret's `AWSCURRENT` version each time its
service starts (`deploy/hosted/worker/switch_hosted_worker.py` `main` →
`SecretsManager.read` *(#538)*). The service is `switch-hosted-worker.service`,
`Restart=always`, `RestartSec=15s`. So a secret refreshed before the start
reaches the VM on boot, and a service restart re-reads it without a reboot.
The contract promises **safe rejection plus recovery**, not an atomic Core
and EC2 start: a worker that boots on an obsolete bundle is refused by Core,
then restarts onto the current one.

**Core, `prepare` (idempotent by revision).** For a launch at revision R that
is `desired_state = running` (checked already):

- if `worker_capability_revision = R`, return the **same** capability,
  decrypted from `worker_capability_encrypted`;
- otherwise mint 32 random bytes, store `encrypt_token(capability,
  jwt_secret_key)` in `worker_capability_encrypted` (the way the agent key's
  `ApiKey.encrypted_key` is stored, `crypto.py`), `sha256` in
  `worker_capability_hash` and R in `worker_capability_revision`, in the
  transaction that sets `state = provisioning`;
- return `{..., "revision": R, "worker_capability": ...}`. The capability is a
  top-level field, not inside `switch_credentials.env`, with `Cache-Control:
  no-store` as today.

Minting overwrites the previous revision's values, so at most one capability
is valid. A retry at the same revision returns the same bytes, so a lost
response costs nothing.

**Controller, bundle per revision.** `accept_launch` builds the bundle version
token as `uuid5(request_id, str(revision))` and adds two columns to the
controller's agent store (`store.py`, SQLite): `required_bundle_token` and
`bundle_token`, plus `required_bundle_revision` so that a job older than the
required revision is ignored rather than rolling the requirement (and, through
step 2, `AWSCURRENT`) back to an obsolete bundle.

1. For a job with desired `running`, set `required_bundle_token` to the
   revision's token before anything else. The `instance_launch_issued` early
   return is removed from this step; it still guards `run_instance`.
2. If the secret has a version with that token **and its stages include
   `AWSCURRENT`** (`describe_secret` → `VersionIdsToStages[token]`), the
   bundle is persisted: set `bundle_token` and stop. If the version exists
   without `AWSCURRENT`, move the stage to it
   (`update_secret_version_stage`, `MoveToVersionId = token`,
   `RemoveFromVersionId` = the current holder), then set `bundle_token`.
   Mere presence of the version is never enough.
3. Otherwise call `prepare`, check `prepared.revision == job.revision` (a
   mismatch is a stale job: stop and wait for the next poll), build the
   bundle, and `put_secret_value` with that `ClientRequestToken`. The put
   moves `AWSCURRENT` to the new version. Then set `bundle_token`.

The reconciler neither calls `run_instance` nor `start_instance` while
`bundle_token != required_bundle_token`; it reports `provisioning`. So a
retained VM never boots on the previous revision's bundle.

**Crash and loss recovery**:

- A controller restart after `prepare` but before the put: the next poll
  reaches step 3 again, `prepare` returns the same capability (same
  revision), and the put goes through.
- A lost `put_secret_value` response: either the version exists (step 2 on
  the next poll) or it does not (step 3 again). Secrets Manager commits a put
  atomically. A retry with the same token and different content (the GitHub
  token is issued fresh on each `prepare`) is refused `ResourceExistsException`, which
  the controller treats as step 2. Step 2 is checked first, so this only
  happens when the check and the put race.
- A restart between the put and `bundle_token`: step 2 on the next poll.
- A revision bump after `prepare(R)` returns: the controller can still
  write R's bundle, set both tokens to R and start the instance before its
  next poll. The bundle gate does not prevent that boot. What makes it safe
  is Core: the R capability is refused on attach (`worker_capability_obsolete`),
  so that worker never gets a wake, relay, placement or operation. The next
  poll then writes R+1's bundle (steps 1–3), and the obsolete-bundle restart
  below moves the running worker onto it.

**Obsolete boot bundle on a running instance.** A worker that is refused
`worker_capability_obsolete`, or evicted `launch_superseded`, restarts its
service onto the current secret. It never retries with the same bundle:

1. The daemon exits with code 75 (`EX_TEMPFAIL`), reserved for this case.
2. `switch_hosted_worker.py` records the secret `VersionId` it booted with
   (returned by `get_secret_value`) as obsolete in
   `<state root>/obsolete-bundle`, then exits. systemd restarts the service
   15 s later.
3. On start, the worker reads `AWSCURRENT`. If its `VersionId` is the recorded
   obsolete one, it does **not** start the daemon. It polls the secret every
   30 s and logs a warning every 5 minutes, and starts the daemon only once a
   different version is current. So there is no daemon restart loop and no
   repeated refused attach, only one cheap poll.
4. With a new version current, it deletes the marker and boots normally. If
   that bundle is obsolete as well (another bump in between), the same steps
   run again, once per revision, which is bounded by how often the owner or
   autostop changes the launch.

If the launch was stopping (autostop, Stop, restart), EC2 stops the instance
while the worker waits, and the marker has no effect on the next boot. That
boot reads a newer version, because `start_instance` is gated on the bundle.
While a worker waits, `observe` sees no attached worker and the launch stays
`provisioning`. Its existing 10-minute `error` path is the visible failure if
the controller never supplies a bundle.

**Validity.** A capability is valid iff its hash matches **and**
`worker_capability_revision = launch.revision` **and** `desired_state =
running`, `state != error`, owner still a tenant member (`worker_launch`
*(#538)*). Any revision bump makes it obsolete without a write.

**On the worker.** `switch_hosted_worker.py` accepts a `workerCapability`
field in the bundle (its parser rejects unknown fields today). The bootstrap
writes it to `<state root>/worker-capability` with mode 0600 by atomic rename
on every boot. It must not use `writeNewJson` (`hosted-bootstrap.ts`
*(#538)*), which is write-once. The capability is never put in the provider or
session environment and never logged.

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
- `test_prepare_idempotent_by_revision` (core): two `prepare` calls at R
  return the same capability; after a bump to R+1 a third returns a new one
  and the R capability is refused on attach.
- `test_sleep_wake_same_request_id_refreshes_bundle` (controller, with the
  fake cloud of `tests/test_controller.py`): run, autostop, wake with the same
  `request_id` and retained instance. `prepare` is called for the new
  revision, a new secret version becomes `AWSCURRENT`, and `start_instance`
  is not called before `bundle_token` matches. The woken worker attaches with
  the new capability.
- `test_revision_bump_between_prepare_and_start_recovers` (controller, Core
  and worker, fake cloud): `prepare(R)` returns, Core bumps to R+1, and the
  controller writes R and starts the instance. The R worker is refused 403 and
  exits 75, and no wake, relay or placement reaches it. The next poll writes
  R+1 as `AWSCURRENT`, the service restarts onto it and attaches at R+1. The
  worker waits (no daemon start) while `AWSCURRENT` is still the obsolete
  version.
- `test_bundle_present_but_not_current_is_promoted` (controller): a version
  with the token but no `AWSCURRENT` stage is promoted before `bundle_token`
  is set.
- `test_controller_restart_between_issuance_and_persistence` (controller):
  kill after `prepare` returns, before `put_secret_value`; restart. One secret
  version for that revision, holding the capability `prepare` first returned.
  The same test with the put response lost and a `ResourceExistsException`
  retry.
- `test_stream_reports_restart_below_floor` (core) and
  `test_gap_above_cursor_is_not_cursor_reset` (switch-agent-runtime).

## Frames (protocol 7)

One frame per purpose, as main already has (`session_command` 5,
`approval_outcome` 4, `room_released` 6). All are sent only to the attached
worker. `session_command` stays room controls only.

| Frame | Data | Body? |
|---|---|---|
| `worker_attached` | `{launch_revision, limits: {sessions_per_agent}, idle: {report_every_s, fresh_for_s}, credential_revision, queued_operations: [id], relay_fence, cancelled: [{room_id, message_id, reason}]}` (`reason` is `stopped` or `expired`) | no |
| `relay` | `{id, deadline_ms, relay_seq \| null, message}` | yes (Console request) |
| `relay_cancel` | `{id}` | no |
| `wake` | `{entries: [{room_id, message_id, thread_id, event}]}`, ≤ 50 entries | yes (room event) |
| `mailbox_cancel` | `{entries: [{room_id, message_id}]}` | no |
| `operation` | `{id}` | no: a doorbell to claim |
| `credential` | `{revision \| null}` | no: a doorbell to fetch |

Frames that carry a body are queued per connection (as `session_commands`),
bounded at 64 frames or 8 MiB. A mutating relay reserves its slot before it
takes a `relay_seq` (D2), so a full queue refuses it `worker_busy` (503)
without consuming a sequence number. A wake entry that does not fit stays
`pending`. Nothing is dropped silently.

A relay's `deadline_ms` is an absolute deadline in Unix epoch milliseconds
(Core's wall clock when it sent the relay plus the request's timeout). Core
fails the relay `relay_timeout` at that moment whatever the worker does; a
worker may use it to abandon work nobody will read, and must not treat it as
a duration.

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

For a mutating message the route takes the launch lock and checks that the
launch is awake and the worker is attached at the current revision. It then
reserves a slot in that connection's frame queue (or fails `worker_busy`),
bumps `hosted_launches.relay_seq` (new, durable) and `active_at`, registers
the pending relay, commits, and only then puts the frame in its reserved
slot. Putting a frame in a reserved slot cannot fail. What can still lose the
frame is the connection dying or Core crashing; both end in a reattach, and
the reattach fence settles the sequence (D2). Read-only messages take no
lock and carry `relay_seq: null`.

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
  "relays_through": int,      // contiguous resolved watermark (below)
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
- `approval_open`, `reset_waiting`, `operation_claimed`, `relay_inflight`, `host_unknown`;
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
posted, then idle. When the hold ends, the watcher acks each of that session's
mailbox rows `held` (D3), so Core stops counting them too. The messages stay in
the watcher journal and are retried on the next address of that session,
after a wake if need be.

Core stores the latest accepted report on the `Connection` with its own
monotonic `received_at`. It is **fresh** when the connection is alive, the
current generation, bound to the launch's current revision, and `received_at`
is within `fresh_for_s` (75). Core restart, detach, generation change and
revision bump all make it absent. **Absent or stale = busy.**

### Activity Core knows about

A command can be dispatched and still be invisible to the next idle report.
The watcher may have sent the report before it applied the command, or before
the host posted `busy`. So Core does not wait to be told:

- Under the launch lock, a mutating relay reserves its queue slot, bumps
  `relay_seq` and sets `active_at = now` before the frame is sent (D1).
- While any mutating relay of the launch is pending (in the in-memory map),
  the launch is busy.
- Once replies are in, idle is trusted again only from a report with
  `relays_through ≥ hosted_launches.relay_seq`, read under the lock at
  decision time. A report below that counts as busy. `relay_seq` is durable,
  so the rule survives a Core restart; the report is absent then anyway.
- Read-only relays, the relay stream and snapshots take no lock and touch
  neither `active_at` nor `relay_seq`.

**`relays_through` is a contiguous resolved watermark**: the largest N such
that every sequence number up to N is *resolved*. It is never the highest
number received, because a lower one may still be in flight. A sequence
number is resolved when its effect, if any, is already reflected in the
watcher's `busy`. Each number is resolved exactly one way:

| Resolution | When |
|---|---|
| `taken` | `command`: the host replied to the command (accepted, or a status). The host posts `busy` before it replies whenever its busy state changed, and the channel is ordered, so the watcher has applied the change first. `place`, `forget`, `attachment`, `attachmentCancel`: the watcher's handler has returned its answer. |
| `refused` | validation failed in the watcher, or the host refused (`STALE_EPOCH`, `UNSUPPORTED_CAPABILITY`, `HOST_STOPPING`, …). Nothing changed. |
| `interrupted` | received before a watcher restart and not resolved. The hosts died with it (`KillMode=control-group` in `switch-hosted-worker.service`), so nothing can apply the command later. After the restart, host recovery has settled it (`unknown`, `HOST_RESTARTED`), so current `busy` already reflects it. |
| `not_delivered` | at or below the reattach fence and never received (below). |
| `abandoned` | the handler had not yet dispatched to the host, and the watcher cancelled it (below). Cancelling happens inside the watcher's serial section, and the handler checks the flag in that section right before dispatching, so a cancelled handler can never apply later. The relay reply, if Console still waits, is `relay_timeout`. |
| `barrier` | the command was dispatched to the host, no reply came, and a later busy barrier to that host has completed (below). |

**Elapsed time alone never resolves a relay.** An unresolved relay is busy,
reported as reason `relay_inflight` with its session, however old it is and
whatever idle report Core last cached. Its handler may still be waiting to
dispatch (the session's host starting, the watcher's serial chain), or the
host may still be about to act on it. After 5 minutes unresolved (logged as a
warning), the watcher tries to close it in one of two ways:

- **Not yet dispatched**: cancel the handler, then resolve `abandoned`.
- **Dispatched, no reply**: send the host a busy barrier, a new parent → host
  message `{kind: 'busyBarrier', id}` (`session-channel.ts`
  `toChildSchema`). The host runs it on the same serial chain as
  `accept` (`session-host.ts` `this.serial`), so it completes only after every
  earlier command has been accepted or refused. It answers `{kind: 'busy',
  busy, reasons, barrier: id}` with its state at that point. The watcher
  applies that state, then resolves `barrier`.

If the barrier gets no answer (the host is hung, or its serial chain is
stuck behind the command), the host's state is **unknown**, and unknown
counts as busy (reason `host_unknown`). The relay stays unresolved. The watcher
retries the barrier every minute. It gives up only if the host exits or is
stopped; a host that has exited cannot apply the command, and the host's
recovery on its next start settles it (`interrupted`). A permanently hung
host therefore keeps the VM up. That is visible (`host_unknown` in the
report, and in Console's health view), and stopping the session from Console
or the room releases it.

The watcher keeps `relays.jsonl` beside `assignments.jsonl`, with records
`received {seq, id}` (fsynced before the message is applied) and `resolved
{seq, how}`. It computes `relays_through` from them: completion out of order
advances nothing until the gap below it resolves.

**Gateway request cancellation.** Console can drop the request (closed
window, network, its own timeout) at any await in the route. Once the
sequence number is about to be committed, the rest of the route runs as one
task under `asyncio.shield`, in D1's order: register the pending relay, commit,
then put the frame in its reserved slot. Registration comes first so that an
immediate worker reply always finds its relay. The task opens and closes its
own database session (`tenant_session`), never the request's: `asyncio.shield`
does not stop the request middleware from closing the request's session when
the request is torn down. Cancelling the request cancels only the wait for the
reply, never the send. A healthy worker stream therefore
gets the frame, and neither side reconnects because Console left. The reply
is discarded when it arrives, and the watermark advances as usual. If the
shielded step itself fails after the commit (Core crash, the connection
gone), that is the fenced reconciliation's case below.

**Fenced reconciliation on attach.** A sequence number can be committed and
never reach the watcher: the connection dies between commit and send, or Core
crashes. Both end in a new attach, which runs under the launch lock:

1. Every pending relay of the old connection or boot has already failed
   `generation_changed`. A frame for a gone connection has no queue to land
   in, so no relay numbered at or below the current `relay_seq` can reach the
   new connection.
2. Core sends `relay_fence = hosted_launches.relay_seq` in `worker_attached`.
   Every relay after that takes a higher number and targets the new
   connection.
3. Before its first idle report, the watcher resolves every number at or
   below the fence that has no `received` record as `not_delivered`, and
   every `received` one without `resolved` as `interrupted` if its process
   restarted.

A hole therefore lasts at most until the next attach, and while it lasts the
worker's connection is gone, so the report is absent and the launch is busy
for that reason anyway. There are no Core-side voids to track: a queue
refusal happens before a number is taken.

### Decision (controller observation)

`hosted_controller.observe` *(#538)* replaces `HostedLaunchStore.idle_busy`
with `idle_evidence(launch)`. The launch is busy when any of these holds:

1. there is no fresh report, the report says `busy`, or `relays_through <
   relay_seq`;
2. a mutating relay of the launch is pending;
3. a `hosted_operations` row is `queued`/`claimed` at the current revision;
4. a `hosted_wake_mailbox` row for the agent is `pending`, `offered` or
   `accepted` (D3). `held` rows and `cancel_requested` tombstones do not
   count. A held input is waiting for a new address, not for time, and a
   tombstone is settled at the next attach. Whatever work either causes then
   shows in the report;
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
- `test_permanent_startup_failure_holds_then_sleeps`: a host that always
  fails to start, one mention → one failure notice → busy for 15 minutes →
  rows `held` → the VM stops. A later mention wakes it, the held message is
  retried before the new one, and no second notice is posted for the held
  message.
- `test_relay_crash_after_commit_before_enqueue`: Core crashes after
  committing `relay_seq = N` and before sending. After restart and reattach,
  `relay_fence = N`, the watcher resolves N `not_delivered`, `relays_through`
  reaches N, and the VM can stop.
- `test_relay_queue_refusal_takes_no_sequence`: a full queue returns
  `worker_busy` and `relay_seq` is unchanged.
- `test_relay_out_of_order_completion`: N+1 resolves before N;
  `relays_through` stays at N-1 until N resolves.
- `test_delayed_handler_at_five_minutes_stays_busy`: Core's cached report
  says idle, and a command handler is blocked before dispatch for more than 5
  minutes. The launch stays busy the whole time (`relays_through` below
  `relay_seq`). At 5 minutes the watcher abandons the handler; unblocking it
  afterwards dispatches nothing; the watermark advances and the VM can stop.
  Variants: dispatched with a delayed host reply → resolved only after the
  barrier completes, with the barrier's busy state applied; a host that does
  not answer the barrier → `host_unknown`, busy, no resolution.
- `test_gateway_cancel_after_commit_still_enqueues`: the Console request is
  cancelled right after the commit. The frame still reaches the worker on the
  same stream generation (no reconnect), the watermark advances, and
  `relay_seq` has no hole.
- `test_gateway_cancel_with_teardown_and_immediate_reply`: through the real
  ASGI app and middleware, the client disconnects during the shielded step so
  the request's session is closed, and the fake worker replies the moment the
  frame arrives. The shielded task's commit and send succeed on its own
  session, the reply finds its registered relay (no 404), and no
  closed-session error is raised or logged.
- `test_relay_worker_restart`: the watcher restarts with N received but not
  resolved. N resolves `interrupted` and the watermark advances; the host's
  recovered state decides `busy`.
- Each mutating message kind (`command` accepted, `command` refused, `place`,
  `forget`, `attachment`, `attachmentCancel`) advances the watermark.
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
| `notice_owed` | The room notice a terminal move owes (`stopped`, `expired`, `expired_uncertain`, `started_before_*`), set in the same transaction as the move and cleared once the room has it. |
| `addressed_at, updated_at, expires_at` | |

Index `(tenant_id, agent_id, state, addressed_at)`.

States:

```
pending ──offer──▶ offered ──ack journaled──▶ accepted ──ack admitted──▶ admitted
   ▲                  │                          │  ▲
   └──lease expiry / ─┘                 ack held │  │ ack admitted (retry worked)
      foreign boot or generation                 ▼  │
                                                held
explicit Stop: pending & !ever_offered ─▶ cancelled                       (definite)
               pending & ever_offered, offered, accepted, held ─▶ cancel_requested (stopped)
24 h:          accepted, held ─▶ cancel_requested (expired)
cancel_requested ─watcher─▶ cancelled (not admitted) | admitted (already running)
other terminal: refused, duplicate, expired (never offered), expired_uncertain
```

`held` is the durable form of the watcher's bounded failure hold (D2): the
input is on the worker's disk, its failure notice has been posted, and it is
waiting for the next address of its session, not for time. It does not keep
the VM awake.

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
| `held` | the session's host failed to start, the failure notice is posted (`room-notices`, reason `startup`), and the 15-minute hold has ended | `accepted` → `held` |
| `admitted` after `held` | a later address of the session started its host, and the held input was admitted ahead of the new one | `held` → `admitted` |
| `cancelled` / `admitted` | reply to a cancel (below) | `cancel_requested` → `cancelled` / `admitted` |

**Held inputs.** The watcher keeps a held input's `parked` record and its
`failure-notified` key. It retries the host start only on a new address of
the same session (a live event or a mailbox row), or on a Console `start` /
`restart` operation for it, and then admits held inputs in their original
order before the new one. If the start fails again, the new message gets its
own notice and goes `held` after its own hold, while the already-held inputs
stay `held` and get no second notice (once per message and reason, Failure
notices). Sleeping, waking and Core restarts do not touch held inputs; only
the watcher's journal and the rows do.

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
  `pending` rows and `held` rows to `cancel_requested` (reason `stopped`),
  with no notice yet. `admitted` rows are untouched. Explicit Stop never
  wakes.
- If the worker is still attached, Core sends `mailbox_cancel` before the VM
  stops. In every case the `cancelled` list rides on the next
  `worker_attached`. `cancel_requested` rows are durable tombstones: kept until
  the watcher answers or the launch is deleted. They are exempt from the 24 h
  expiry and the 7-day prune below.
- **Watcher reconcile, before admission.** On boot the watcher admits nothing
  from its journal (held rooms, parked deliveries, pump queue) until it has
  processed `worker_attached.cancelled`. For each entry:
  - journaled or held, and not yet admitted to a host: append `released`
    with the entry's reason (fsynced), then ack `cancelled`, and Core posts
    "cancelled, not run" (or "expired, not run" for reason `expired`);
  - already admitted: ack `admitted`, and Core posts "had already started
    before Stop";
  - unknown to the journal: ack `cancelled`, which is definite because
    nothing on the worker has it.
- A launch deleted with `cancel_requested` rows posts nothing (the agent is
  removed); no outcome is invented.

### Retention

By state, 24 h after `addressed_at`:

| State | Becomes | Notice |
|---|---|---|
| `pending`, never offered | `expired` | in-thread, one per room: "expired, not run" (definite: the worker never had it) |
| `pending` ever offered, or `offered` | `expired_uncertain` | says delivery could not be confirmed; never claims the event did not run |
| `accepted`, `held` | `cancel_requested` (reason `expired`) | none yet; the watcher settles it at the next attach, and the notice then says which way it went |
| `cancel_requested` | unchanged | none. Tombstones are exempt from expiry and pruning and stay until the watcher answers or the launch is deleted. |

Terminal rows (`admitted`, `cancelled`, `refused`, `duplicate`, `expired`,
`expired_uncertain`) are pruned 7 days after `updated_at` by the upkeep loop.

### Owed notices

Every notice above is posted after its transaction commits, so a send can
fail after the row has moved. The row keeps `notice_owed` until the room has
the notice; the upkeep loop retries owed notices every 30 s, up to 100 rooms a
pass, logging a warning for each failure. The per message and reason receipt
(Failure notices) keeps a retry from posting twice. A row pruned with its
notice still owed takes the obligation with it.

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
- `test_tombstone_survives_expiry_and_prune`: a `cancel_requested` row 8 days
  old is still there and still in `worker_attached.cancelled`.
- `test_held_row_expires_through_watcher`: a `held` row at 24 h becomes
  `cancel_requested (expired)`; on the next attach the watcher releases it and
  the notice says "expired, not run".
- `test_permanent_startup_failure_holds_then_sleeps` (D2) covers the
  `accepted → held → admitted` path.

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
  The host boot that claimed may claim again while the row is still `claimed`
  (`claimed_boot_id` matches): its claim reply may have been lost, and the
  watcher runs an operation only after journaling its claim, so a repeat claim
  never runs it twice. `worker_attached.queued_operations` and the idle-report
  response list those ids for that boot alongside the `queued` ones. Anything
  else is 409, including a claim from another boot. A doorbell for a claimed
  or finished id is ignored.
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
  to the attached worker. The frame carries no secret. A delete sends
  `revision: null` and nothing else: the launch keeps its state and revision,
  so the worker is not failed or superseded — it stays attached, stops its
  hosts on the `revoked` fetch, and idle-stops like any quiet worker.
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
reasons `startup | delivery | conversation | capacity | auto_start_off | stopped | expired |
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

1. `a3c9e5f71d28_hosted_cutover_manifest`, child of `95fc38e451b6`, run by
   `hosted-cutover-upgrade prepare` (Pilot order). It adds
   `hosted_cutover_volumes (tenant_id, launch_id, preflight_state pending |
   blocked | complete, manifest_sha256, completed_at, blocked_reason,
   imports_queued_at)` and `hosted_cutover_items (tenant_id, agent_id,
   launch_id, session_id, kind, room_id, message_id, thread_id, evidence,
   disposition, payload JSONB NULL, notice_posted_at)`, with RLS; copies what
   the `sdk_*` tables and queued `hosted_operations` hold for hosted agents
   into items; and makes one `pending` volume per hosted agent's latest
   launch. It refuses a database whose launches outlived `sdk_sessions`.
2. `33e037ee949f` merges it with `e3b7c9d2a415`. It runs after
   `b9e4d2a71c05`, in the same transaction, and raises unless every volume of
   a non-deleted launch is `complete`, every item of one is decided, and every
   `import` attachment still has its `media_blobs` row. The raise rolls the
   drop back. With no cutover volumes (every main database, every fresh one)
   it does nothing.
3. `c4d8e2f1a9b7` (worker capability) and `d7e3a9c1f5b2`
   (`hosted_wake_mailbox`, RLS). The mailbox copy of `import` items is not a
   migration: `hosted-cutover-upgrade` queues them through
   `HostedMailboxStore.write` right after the upgrade (`pending`, `origin =
   cutover`, `expires_at = now() + 24 h`), once per volume, recorded in
   `imports_queued_at`. The worker's manifest upload queues any not yet
   queued, under the launch lock.

An empty merge only proves the graph has one head. It does not prove the
cutover is safe. The migration tests (`test_migration_hosted_merge.py`) are
real upgrades with data, against PostgreSQL:

- a pilot database at `95fc38e451b6` with launches, operations and `sdk_*`
  rows is captured at the manifest revision, its volume recorded, and
  upgraded to heads: launches and operations are intact, every item is
  decided, the `sdk_*` tables are gone;
- the gate refuses, naming the launch, while a volume is `pending` or
  `blocked` (with the file and line the check named), an item is undecided,
  an import has no event, an import's blob would be dropped with its session,
  or the old tables changed after `prepare`; a bare `alembic upgrade heads`
  in each of those states rolls back with the drop undone;
- once recorded, the upgrade keeps exactly the session blob an import needs,
  drops the others, and queues the import once;
- a main database at `e3b7c9d2a415` upgrades with the hosted tables empty;
- `alembic heads` is one head; `test_frozen_ddl_matches_create_all.py` still
  passes (no new NOTIFY DDL: mailbox delivery is offer-on-attach plus live
  buffer).

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

The **preflight** is `hosted-preflight` (agent-providers). The first boot of
the new image runs it in place; before the drop it runs as
`hosted-bootstrap.mjs --preflight-check <state-dir> <scratch-dir>` against a
copy of each stopped volume, which it makes in the scratch directory and
removes, so the volume itself is never written. The manifest it answers is
the one the first boot will write, because the items depend only on the
journals. For each session root and the watcher root it:

1. parses every journal (`assignments.jsonl`, `room-inbox.jsonl`,
   `inbox.jsonl`, `events.jsonl`, `delivery-*.jsonl`, `shared-state.jsonl`)
   with **main's** schemas. Any failure blocks that volume and names the file
   and line;
2. lists, without bodies, what it found per source:
   - `room_pending`: `received` records in a session's `room-inbox.jsonl`
     that are not acknowledged. The rule is exactly
     `SharedRoomInbox.readMessageState` *(#538)*: an `ack` matches by
     `identity` (`JSON.stringify([roomId, messageId])`) when it has one,
     otherwise by the `sequence` of the latest `received` for that message,
     and a `cursor` record with `reset: true` clears the sequence match.
     Legacy `received` records without `missed`/`gap` parse with the defaults
     (`storedReceivedSchema`). `failure-notified` identities are listed too;
   - host commands from each session's `inbox.jsonl`, with `origin.surface`,
     `origin.roomId` and `origin.messageId` and the furthest record seen
     (`accepted`, `dispatched`, `finished`);
   - `request_open` (from `events.jsonl`) and `reset_pending`, per session;
3. prints `{"manifest": {manifest_sha256, items}}`, or `{"blocked": {step,
   file, line, error}}` with the file on the volume, and exits 2 when blocked.
   `hosted-cutover-upgrade record <launch-id> <file>` applies it: a manifest
   is merged with Core's capture and decided (below) and the volume becomes
   `complete` with its digest; a blocked check makes it `blocked` with the
   reason. After the upgrade the worker's first boot uploads the manifest to
   `POST /agents/{id}/connection/cutover-manifest`, which only confirms it:
   `409 cutover_manifest_unrecorded` for a volume with nothing recorded,
   `409 cutover_manifest_conflict` for a different digest (the volume changed
   after its check).

**One disposition per logical room message.** The same message can appear in
up to three sources at once: `room_pending` (its room-inbox ack was lost), a
host command that got as far as `dispatched`, and a Core
`sdk_session_commands` row whose status never became terminal. Core merges
every record by `(agent_id, room_id, message_id)` before deciding. The Core
receipt for a room message is found by its command id, which #538 derives as
`uuid5(NAMESPACE_URL, "switch-room:{agent}:{room}:{message}")`
(`sessions/service.py` `submit_room_message` *(#538)*). The strongest evidence
wins, in this order:

| Evidence, across all sources for the message | Disposition |
|---|---|
| a host `finished` record, or a receipt with status `applied` | `ran`: dropped, no notice |
| a host `dispatched` record, or a receipt with status `dispatched` or `unknown` | `uncertain`: in-thread notice "may have been interrupted by the upgrade; re-send if needed". Never imported. |
| a receipt with status `rejected` | `unrecoverable`: notice "was not run; please send it again" |
| only `room_pending`, a host `accepted` record, or a receipt with status `accepted` | `import`: the payload is rebuilt with `to_inbound` and `message_payload` (replay's reconstruction without the 15-minute window) into `payload`. A multi-file group, a missing blob or a deleted message makes it `unrecoverable` instead. |

Items that are not room messages are decided on their own:

| Item | Disposition |
|---|---|
| Console-origin host command, `accepted` only | `settled_by_host`: main's host marks it `unknown` in the transcript Console shows; nothing is posted to a room, so no private prompt text leaks |
| Console-origin Core receipt never delivered to the host | owner notice without the prompt text |
| `request_open` | `interrupted`: in-thread notice "the approval was interrupted by an upgrade; ask the agent again" (reason `upgrade`) |
| `reset_pending` | `preserved`: no action |

A `failure-notified` message that is imported gets one more notice (reason
`upgrade`): "will run now, after the upgrade", so the earlier failure notice
is not the last word.

An import into a session that also has a `reset_pending` item does not run
now: the host holds room messages until the reset is decided. Every such
import, failure-notified or not, gets the `conversation` notice instead,
which says it waits and who acts: anyone in the room with `!reset @agent`,
or the owner with Start a fresh conversation in Switch Console. It is keyed
like the worker's own `conversation` notice, so a message #538 already told
this is not told again.

**Imported commands never meet the old host's dedupe record.** Main's host
accepts a command id it has seen only if the command is identical, and
otherwise returns the old status or `IDEMPOTENCY_CONFLICT`
(`session-host.ts` `accept`). The old `accepted` record for an imported
message is still in `inbox.jsonl`, and recovery marks it `unknown`. The ids
already differ: main's `roomCommandId` hashes with SHA-256 (`room-prompt.ts`)
where #538 used uuid5. The contract does not rely on that. A mailbox row with
`origin = cutover` runs under `uuidFrom("switch-room-cutover:{agent}:{room}:{message}")` (the hash `roomCommandId` uses),
a namespace no earlier build used. The transcript then shows the old command
as interrupted and not sent, followed by the imported one running: both true.
Only `import` produces a mailbox row, and one message has at most one row
(primary key), so it runs at most once.

Notices are posted by the new Core after the upgrade, once per key
(`post_notice_once`), and each is recorded in `notice_posted_at`: at the
manifest upload, and by the mailbox upkeep for every item still owed, so a
volume whose worker has nothing to upload is not skipped and a failed post
is retried. Recording a manifest keeps each import's attachment through the
drop: its `media_blobs` row is detached from its #538 session, which
`b9e4d2a71c05` would otherwise delete. Imported payloads live only in
`hosted_cutover_items` until they are queued into the mailbox. Nothing is
written to a file.

Tests:

- `test_cutover_merges_overlapping_records`. The fixture is a retained volume
  written in the exact 758bc5ae formats: a `room-inbox.jsonl` with a legacy
  `received` (no `missed`/`gap`), an `ack` without `identity`, a `cursor`
  reset, and a `received` whose ack was lost; an `inbox.jsonl` whose
  room-origin command for that same message reached `dispatched`; and an
  `sdk_session_commands` row for it (the uuid5 id) with status `accepted`.
  The result is one item, `uncertain`, with one notice and no mailbox row.
  Variants: host `accepted` only → one `import`; receipt `applied` → `ran`.
- `test_imported_command_not_deduped_by_old_record`: a session whose
  `inbox.jsonl` holds the old `accepted` record for a message that is then
  imported. After recovery the old command is `unknown`, and the imported one
  is accepted under the cutover id and runs once.

**Gate.** Before `b9e4d2a71c05` can run, every hosted agent's latest
non-deleted launch needs a volume with `preflight_state = complete`, every
item of one needs a disposition, every `import` needs its event, and every
import attachment needs a `media_blobs` row no session owns.
`hosted-cutover-upgrade` checks all of this, plus that every launch is
stopped and that the `sdk_*` rows still match what `prepare` captured (the
old Core did not run again), and refuses with one line per problem, naming
the launch. `alembic upgrade heads` would order `b9e4d2a71c05` freely between
the branches, and Core runs it at boot, so the merge revision checks the
same volumes, decisions and blobs after the drop and rolls it back. A guard
inside `b9e4d2a71c05` or `env.py` is still rejected; the merge revision is
ours and is a no-op without cutover volumes.

**Revised from the approved design, and why.** The approved design had a
transitional Core (#538 plus the manifest revision, a manifest route and the
disposition job) receive each worker's upload and post every notice before
the drop. That cannot be built as written, and the gate above is the closest
lossless design:

- *No Core can serve the upload before the drop.* The disposition code is
  main's (`to_inbound`, the attachment group rules, the mailbox), so a
  transitional Core would be a second release of #538 carrying a port of it;
  the new Core cannot run on a database still at `a3c9e5f71d28`, and the old
  Core must stay down from `prepare` on or its capture goes stale. A worker
  therefore has no Core to reach before the drop, and running the preflight
  needs no worker at all: the same code checks a copy of the stopped volume,
  and the one-shot `record` step (new code, directly against the database at
  `a3c9e5f71d28`) applies it with the tables it reads still present.
- *Notices cannot be posted before the drop.* Posting needs a running Core's
  agent clients. Nothing a notice needs is dropped: the items, the rooms and
  the messages all survive, so the gate requires every notice to be decided,
  not posted, and the new Core posts each owed notice durably, once.
- *Imports are queued after the drop, not copied by a revision,* so they go
  through the mailbox's one write path and are queued once per volume.

### Pilot order

The pilot sits on our head; main's `a7e1c4b90d23 … e3b7c9d2a415` are not
applied. Among them `b9e4d2a71c05` drops `sdk_sessions`, `sdk_session_events`,
`sdk_session_commands`, `sdk_room_admissions` and `session_request_posts`,
and deletes blobs tied to them. Its downgrade raises.

1. Stop every hosted launch through the controller with desired `stopped`
   and `sleeping = false` (explicit Stop, so nothing wakes), and wait for
   `stopped`. Volumes persist.
2. Take the old Core down and keep it down until step 8; nothing may write
   to the `sdk_*` tables or a volume from here on.
3. `pg_dump` the pilot database.
4. `just hosted-cutover-upgrade prepare`: refuses unless every launch is
   stopped, then captures the old tables at `a3c9e5f71d28`.
5. For each launch `just hosted-cutover-upgrade status` lists: snapshot its
   volume, attach the copy to a maintenance host with the new runtime build,
   and run `node hosted-bootstrap.mjs --preflight-check <state-dir>
   <scratch-dir> > <launch-id>.json` (`<state-dir>` is the volume's `state`
   directory, `<scratch-dir>` a directory that does not exist yet, outside
   it). Then `just hosted-cutover-upgrade record <launch-id>
   <launch-id>.json`, whether the check passed or blocked.
6. For a blocked volume, repair the file and line the reason names on the
   real volume, snapshot it again and repeat step 5 for it.
7. `just hosted-cutover-upgrade status` until it reports nothing blocking.
8. `just hosted-cutover-upgrade` (the `upgrade` step): the gate, main's chain
   including the destructive revision, the merge and the mailbox, then the
   imports queued. Deploy the new Core; it posts the owed notices.
9. Roll the worker image (first-boot migration below), then Console. Start
   the launches within 24 hours of step 8, or their queued imports expire
   (each with its notice).

A step that fails can be run again: `record` of the same manifest changes
nothing, and `upgrade` rolls back whole and, after the drop, only queues
what is not yet queued. Should the gate report that the old tables changed
after `prepare`, restore the dump from step 3 and start again at step 2.

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
| Transcripts, provider state, native homes, placements, room journal (including held inputs), relay journal (`relays.jsonl`), operation outcomes, unsent notices, unconfirmed acks, pinned pages, staged attachments | Worker volume | Yes (survives EC2 stop); pages and partial transfers are cleared at start |
| Launch, revision, sleeping, `active_at`, worker capability (hash, encrypted copy, revision), `relay_seq` | `hosted_launches` | Yes |
| Bundle token required and persisted, per agent | controller agent store (SQLite) | Yes |
| Worker bundle for the current revision | assignment secret, `AWSCURRENT` | Yes; one version per running revision |
| Start/restart commands and outcomes | `hosted_operations` | Yes |
| Addressed events until admitted, held inputs, and cancel tombstones | `hosted_wake_mailbox` | Yes: 24 h to expiry, 7 d terminal; tombstones until answered |
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

## Settled scope

- **Relay is owner-only.** Tenant admins get no relay, read-only or
  otherwise, for now; a non-owner is 404 (D1). Support access would be a
  separate, audited feature.
- **Mailbox limits are pilot defaults**: 500 rows `pending` or `offered` per
  agent (the bound D3 enforces; `accepted` and `held` rows are on the worker's
  disk and do not count), 24 h to
  expiry, 7 days to prune. Hitting a limit is always visible: a refused insert
  tells the room, and expiry posts its notice. The upkeep loop logs, per agent,
  pending-or-offered count, oldest such row and refusals, and the pilot sets the
  final values from those numbers.

## Work packages

- **WP1 base port.** Rebase #538's non-session parts onto main: controller,
  launches, provider and GitHub connections, bootstrap, the controller's
  per-revision bundle (`required_bundle_token` / `bundle_token`, start gated
  on it and on the version holding `AWSCURRENT`, `accept_launch` without the
  `instance_launch_issued` early return for the bundle step), `agent_event_boot`
  floor with the below-floor restart branch, `ac2ffa1d`. Remove every
  `SdkSession` / `SessionAuthority` use (`hosted_routes.py`,
  `hosted_launches.py`, `hosted_launch_store.py`, `session_routes.py`,
  `sessions/service.py`, `commands.py`). Merge revision. Tests: real upgrades
  from both heads; #538's controller and launch tests green;
  `test_stream_reports_restart_below_floor`,
  `test_sleep_wake_same_request_id_refreshes_bundle`,
  `test_controller_restart_between_issuance_and_persistence`.
- **WP2 worker runtime on `--watch-worker`.** Main's `--watch-worker` branch
  of `shared-daemon.ts` with `SessionLinks` and in-process supervision; drop
  `runHostedControl`'s loop; factor `handleControlMessage` out of
  `serveControl`. Adds `list`, `journal`, paged answers, attachment transfers,
  capability file (from the bundle's `workerCapability`, accepted by
  `switch_hosted_worker.py`) and attach headers, `relays.jsonl` and the
  contiguous `relays_through` with the attach fence, handler cancellation and
  the `busyBarrier` host message, exit 75 on an obsolete capability with the
  worker's `obsolete-bundle` wait, idle report,
  `busy` IPC, the doorbell handlers (`operation`, `credential`) with claim and
  result via `operations.jsonl`, watcher-side admission, reconcile-before-admit
  for `cancelled`, held inputs and the `held` ack, cutover rows under the
  cutover command id, retried acks, `notices.jsonl`.
- **WP3 server.** Worker capability: issued per running revision by
  `prepare`, idempotent at a revision (stored encrypted beside its hash),
  checked on stream open, one attached worker, `hosted_worker_only` gating of opens, reattach,
  subscribe and placements, `launch_superseded` eviction, and room-control
  relay narrowed to the worker. Protocol 7 frames (`worker_attached`, `relay`,
  `relay_cancel`, `wake`, `mailbox_cancel`, `operation`, `credential`) with
  bounded per-connection queues. Gateway relay route and relay stream
  (owner-only, 2 MiB requests, paged replies, resync reasons); agent relay
  reply and push routes. Mutating relays reserve a queue slot, then stamp
  `relay_seq` and `active_at` under the launch lock; register the pending
  relay, commit, then send, as one task shielded from request cancellation
  that owns its own database session (the request's session is closed by
  middleware at teardown, shield or not), tested by
  `test_gateway_cancel_with_teardown_and_immediate_reply`; `relay_fence` in
  `worker_attached`; pending-relay busy, idle report storage, `idle_evidence`
  with the contiguous watermark and without `held` rows or tombstones. Operation doorbell with re-ring, fenced claim, result re-post.
  Credential doorbell and idle-report catch-up.
  `/agents/{id}/room-notices`. `!reset` two-step.
- **WP4 mailbox.** Table with states, leases and `ever_offered`; write in
  `note_addressed`'s transaction; mark-offered-then-send on the live path and
  on attach; reclaim on attach, at start and in upkeep; forward-only ack
  route; the `held` state; Stop's `cancelled` / `cancel_requested` split and
  tombstone delivery; expiry by state (`expired`, `expired_uncertain`,
  `cancel_requested (expired)`), tombstones exempt; pruning; the 500-row
  bound and its upkeep metrics.
- **WP5 Console cloud.** A `CloudRelayClient` with `ControlClient`'s
  interface; `askHost`, `transcripts.ts` (subscribe-first, paged snapshot,
  resync), `host-sessions.ts`, the health monitor and stop/forget route cloud
  agents through it; chunked attachment upload; `sleeping` and `waking` shown
  as health states from the launch, with an explicit wake; the cloud sidebar
  reads `list` instead of polling `sharedList`.
- **WP6 cutover and state migration.** The cutover-manifest revision,
  `hosted-preflight` and its `--preflight-check`, the per-message merge and
  dispositions, the `just hosted-cutover-upgrade` steps and gate with the
  merge-revision guard, the confirm-only manifest route, durable cutover
  notices, the pilot runbook above, the first-boot migration, and version
  gates on all three sides.
- **WP7 acceptance** (`just bench` scenarios plus a pilot run):
  1. retained Codex and OpenCode conversations resume after cutover; a
     pre-cutover pending room message runs exactly once or is reported;
  2. two sessions on one worker, room takeover between them
     (`replace_placements`, `room_released`);
  3. a pending approval, a running turn and a just-dispatched Console prompt
     never auto-stop; a lost relay and a permanently failing host do not keep
     the VM up forever;
  4. sleep → mention → exactly one turn, across a Core restart at each step,
     with the woken VM on a fresh capability under the same `request_id`;
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

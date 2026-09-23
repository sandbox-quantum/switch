# Persistent local SDK host

The host runs Claude, Codex, OpenCode, Antigravity and Cursor outside Electron.
It owns provider processes, a durable command inbox and a replayable chat journal.
Closing a client leaves execution running. Restarting the host resumes the native
provider conversation and retains the transcript. Interrupted work is reported;
it is never silently resent or replaced with a fresh conversation.

Build the shared and agent-providers packages, then run:

```sh
node dist/host-daemon.mjs /absolute/private/state-directory
```

`connectHost` starts or reconnects to the detached daemon. `HostConnection` is its
client. The private endpoint file contains the loopback address and bearer token;
keep the state directory private. Provider environment and configuration are also
stored there so the host can recover sessions independently of the desktop app.

The production Console path uses the shared daemon and server authority described
below. The private local daemon is retained for isolated provider testing and
rejects Switch identity credentials. Both paths use native provider adapters.

## Current boundary

Host events and client commands contain no publication authority. Verified command
origin is context only. The shared server must select any request card destination
and permitted content. Ordinary assistant output stays in session details; explicit
MCP room replies use their existing path. The local host publishes nothing to rooms.

The wire validators reject the former audience field. Journals written with that
field require explicit conversion before this development host can reopen them.

Reset and model changes use durable command outcomes. Native compaction is enabled
only when the adapter supports it. Shared sessions support authenticated attachment
staging; the private local HTTP test daemon does not accept attachment uploads.
See [SDK sessions](../../../../docs/sdk-sessions.md) for capability and recovery
semantics. Journals and attachments currently have no automatic retention policy.

## Verification

The normal package suite covers durable command identity, stopped-session recovery,
interrupted queues and request settlement. The opt-in live test exercises all five
installed, authenticated CLIs with file tools, duplicate commands, reconnection,
host restart and conversational resume:

```sh
SDK_HOST_LIVE=1 pnpm exec vitest run src/host/host.integration.test.ts
```

The live test uses scratch directories and consumes provider usage.

## Shared host

`runSharedHost` connects one provider session to the Switch session authority.
The standalone entry point is `dist/shared-host-daemon.mjs`:

```sh
node dist/shared-host-daemon.mjs /path/to/state /path/to/session-config.json
```

Supply `SWITCH_API_ENDPOINT` (the agent API base URL) and `SWITCH_API_TOKEN`
through the process environment. The JSON file contains `session` (the session-v1
session shape) and `start` (the local host's provider/input shape). Do not put the
host credential in that file or pass it to the provider environment. The state
directory is reused on restart. Switch assigns every session epoch. No local command
endpoint is exposed by this process.

Apply the backend migrations first. Owner-authenticated gateway routes under
`/gateway/sessions` provide snapshots, replay and command submission. The DEV
Console host workbench's **Shared sessions** tab attaches through a saved server
sign-in. A gateway message command can supply `roomId` to select a request-card
room; the server checks agent membership and chooses the channel. Cards use the
verified owner's linked platform identity for answers. Ordinary transcript items
are never sent through the card publisher.

The host persists acquisition/recovery operations, its command inbox, native
conversation ID, transcript, upload cursor, exact wire events and acknowledgements.
It retries transport failures with the same operation and event IDs. A short
connection loss does not stop the provider. If renewal cannot complete within the
lease safety window, the host stops execution before releasing its lease. The
standalone daemon reconnects and recovers from saved state when transport returns.

Recovery follows three steps:

1. Fence the previous execution. On macOS and Linux, the standalone daemon runs
   in an isolated process group. A live owner is never displaced. After an owner
   crash, the next daemon kills and verifies the remaining process group before
   reclaiming the state directory. This requires `ps` and local process control.
2. Mark the old lease quiescent and upload all saved events under the old epoch.
   Switch accepts reconciliation without granting execution or command delivery.
3. Submit a durable recovery operation. Switch serializes it in PostgreSQL,
   closes outstanding callbacks, interrupts unfinished turns and marks unconfirmed
   commands unknown. It grants a new epoch only after reconciliation. The host
   resumes the saved native conversation and never resends an uncertain action.

An applied message command means that its input was durably accepted; its turn
can still be interrupted. A failed answer callback has an unknown command outcome,
not a confirmed rejection. Answer reservations and publication remain server-owned.

Recovery fails visibly when the native conversation ID is missing, a journal has
an incomplete write, or process termination cannot be verified. Windows and
embedded hosts without an isolated process group support graceful recovery but
require operator fencing after a crash. Do not copy a live state directory or
remove owner locks without verifying that all its provider processes have exited.
Pre-recovery state directories lack the durable lease metadata and require explicit
migration; they are not silently treated as new conversations. Journals are retained
without compaction in this experimental implementation.

Shared commands currently support queued text and request answers. SSH deployment
and production session routing remain outside this experimental path.

## Compatibility paths and when they can go

One inbound connection per agent is reached by upgrading parts that are not
upgraded together — a Console, the worker bundles already installed in its state
roots, and a Switch server that may be older than both. Each path below exists
for one of those gaps. None is removed here; each is written down with the
condition that makes removing it safe, so a later change can check the condition
rather than guess at it.

- **Workers that have not said they read handoffs** (`handoff.ts`,
  `HANDOFF_PROTOCOL`). A controller routes only to a worker whose state root
  declares the protocol, and the declaration is left in place when the worker
  stops. Removable once no state root in use can have been written by a bundle
  older than the one that first declared it — in practice, when the oldest
  Console that may still be running against these roots is at or past that
  release, remote hosts included. Removing it sooner routes deliveries into a
  worker that never reads them, and they wait for the session's own ask.
- **Sessions holding a room connection of their own** (`carryLegacyRooms`,
  `replaceSupersededSessions`). A watcher start asks Switch what each session
  predating the agent connection is serving, carries those rooms across and
  replaces the session. Removable once no start finds a session whose
  `roomConnection.connectionId` is not the agent's — which is one watcher
  restart after the last host is upgraded, and is observable from the absence of
  the carry request. Removing it sooner replaces a working session with nothing
  recorded, which is the one failure here that cannot be undone.
- **Servers with no route for a session's own room work** (`shared-host.ts`, the
  404 answer to `room-reservations`). Asked once, said once in the log, and not
  asked again for the life of the session. Removable once the oldest server the
  app supports answers the route. Until then a session on such a server hears
  about a room message only while its controller is routing to it, which is what
  the log line says.
- **Servers that ignore `include_command=true` on `room-message`**
  (`shared-host.ts`). The parameter rides in the query string precisely so an
  older server can ignore it; the plain receipt carries no command and the host
  falls back to the ordered command endpoint. Removable on the same terms as the
  route above: when no supported server answers the plain receipt. Costs a
  request per delivery until then, and nothing else.
- **Servers that do not say on renewal whether a session's rooms are owed
  anything** (`shared-host.ts`, `ROOM_PULL_MS`). The worker asks with
  `room_work=true` in the query string, which an older server ignores. An
  answer with no `roomWork` boolean leaves the worker not knowing, so it asks
  `room-reservations` on the interval as it did before the renewal could say.
  Removable once the oldest server the app supports answers `roomWork`. Until
  then an idle session on such a server makes one extra request per interval.


### Command delivery

Core sends `session_commands` hints over the agent watcher’s existing all-scope
SSE connection after command acceptance commits. The watcher signals the matching
local worker through `commands.wake`; the worker then reads the durable, ordered
command queue. These hints do not claim rooms or start sessions.

Workers also check commands on startup and every five seconds to recover missed
hints, support older watchers or servers, and work while the watcher is offline.
The 250 ms local loop still flushes provider events, but no longer requests
commands on every pass. A room admission that cannot return its command directly
triggers an immediate queue check. Notifications are process-local in Core;
commands handled by another server process rely on the fallback check.


Host cleanup stops the provider process without publishing a terminal session
status. The unfinished session keeps its room claim while its supervisor recovers
it. An explicit `session.stop` remains terminal and allows a later room message
to start a new session. Server rejections retain their endpoint and reason in
host logs. Only a locally elapsed renewal deadline is labelled lease expiry.

Room messages are admitted only after Core acknowledges a ready or running
state in the current lease epoch. Local provider readiness alone does not imply
that Core has received that state.

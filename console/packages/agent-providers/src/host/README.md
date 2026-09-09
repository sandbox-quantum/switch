# Persistent local SDK host

The host runs Claude, Codex, OpenCode, Gemini and Cursor outside Electron.
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

The Console development view uses this real host through main-process RPC:

```sh
SWITCHDASH_DB_FILE=/tmp/console-host-check.db VITE_SESSION_HOST=1 pnpm dev
```

Run that command from the desktop app directory after building workspace packages.
The view supports new local sessions, saved conversations, chat, tool activity,
approvals and question forms. It is not the production session route.

## Current boundary

The local daemon accepts local-only sessions and rejects Switch identity
credentials. The separate experimental shared daemon uses the Switch server's
lease, authorization and reservation path described below. No tmux fallback is
used by either host.

Host events and client commands contain no publication authority. Verified command
origin is context only. The shared server must select any request card destination
and permitted content. Ordinary assistant output stays in session details; explicit
MCP room replies use their existing path. The local host publishes nothing to rooms.

The wire validators reject the former audience field. Journals written with that
field require explicit conversion before this development host can reopen them.

Attachments, steering, reset, compact and model changes are unavailable. A partial
journal write fails visibly and requires explicit repair. Journals currently have
no retention or compaction policy. This is not a release-ready tmux replacement.

## Verification

The normal package suite covers durable command identity, stopped-session recovery,
interrupted queues and request settlement. The opt-in live test exercises all five
installed, authenticated CLIs with file tools, duplicate commands, reconnection,
host restart and conversational resume:

```sh
SDK_HOST_LIVE=1 pnpm exec vitest run src/host/host.integration.test.ts
```

The live test uses scratch directories and consumes provider usage.

## Experimental shared host

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

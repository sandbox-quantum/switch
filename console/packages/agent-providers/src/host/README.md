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

## Hosted bootstrap (phase 1)

switch-hosted-bootstrap is a POSIX operator entry point for one pre-provisioned
Claude session. It builds the same shared-host configuration used by Console,
persists its generated host, epoch and room-connection identities, and runs the
shared host daemon under the existing supervisor in the foreground:

    switch-hosted-bootstrap /srv/switch/session-state /run/switch/deployment.json

The state directory must be absolute, private to the current user and disjoint
from the workspace. The workspace, Claude executable and both credential files
must already exist. A version 1 deployment file has this shape:

    {
      "version": 1,
      "session": {
        "sessionId": "assigned-session-id",
        "agentId": "server-issued-agent-id"
      },
      "provider": {
        "kind": "claude",
        "credential": {
          "kind": "api-key",
          "path": "/run/secrets/claude"
        },
        "binaryPath": "/opt/claude/bin/claude",
        "context": "Operator-supplied non-secret session context"
      },
      "workspacePath": "/srv/workspaces/agent",
      "room": {
        "roomId": "server-issued-room-id",
        "startCursor": 0
      },
      "runtimeMode": "approval-required",
      "switchCredentialsPath": "/run/secrets/switch-agent.json",
      "mcpRuntime": "@sandboxaq/switch-agent-runtime@<published-version>"
    }

The Claude credential file contains only the raw credential plus an optional
trailing newline. The api-key kind supplies it to the worker as
ANTHROPIC_API_KEY; setup-token supplies it as CLAUDE_CODE_OAUTH_TOKEN. This is
pass-through wiring only. Phase 1 has not established through a live provider
call that a setup token is accepted, nor that any supplied credential has model
access or quota.

switchCredentialsPath uses the existing Switch agent credential JSON shape.
Both files must be mounted outside the state directory and workspace. The
bootstrap stores their file references, never their values. The provider value
is loaded into the supervisor's in-memory child environment; the Switch worker
reads its mounted file. The worker inherits only a fixed set of ordinary process
variables. HOME, CLAUDE_CONFIG_DIR, TMPDIR and the XDG directories point inside
the private state directory, and ambient provider, cloud and Node startup
credentials are not inherited.

The resolved Switch credential file and Claude executable are pinned into the
saved launch configuration. Treat mounted files as immutable while the bootstrap
is running. To rotate a credential in phase 1, confirm the foreground bootstrap
and its worker have stopped, replace the contents at the same resolved file path,
then restart the bootstrap. Versioned symlink-target rotation and live credential
replacement need controller support and are not part of this entry point.

On restart, the complete non-secret deployment specification must match the saved
plan. The bootstrap rebuilds and checks the launch configuration while retaining
the saved identity IDs; a changed assignment or added environment entry fails
before launch. Known provider and Switch credential values are redacted from the
hosted worker log across output chunk boundaries. Hosted failure.json records a fixed
message rather than a provider error. These exact-value guards do not classify
arbitrary sensitive text produced by agent work.

The process owns the supervisor it starts. SIGINT and SIGTERM request graceful
worker shutdown; a worker that does not exit within 30 seconds receives SIGKILL,
then the existing process-group fence verifies the worker process group has exited. A
fencing or cleanup failure is returned as a failure. The bootstrap refuses to
adopt an already-running worker because it could not account for that worker's
foreground shutdown.

This phase does not provision compute, clone repositories, validate provider
authentication, isolate tenants, manage credentials, expose hosted Console UI or
run the room watcher. It starts exactly one already-authorized session bound to
one room. Room-triggered session creation, pause/enable coordination, capacity,
cloud assignment, managed secret rotation and deletion require a hosted
controller in a later phase.

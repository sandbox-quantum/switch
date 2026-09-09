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
node dist/shared-host-daemon.mjs /path/to/new-state /path/to/session-config.json
```

Supply `SWITCH_API_ENDPOINT` (the agent API base URL) and `SWITCH_API_TOKEN`
through the process environment. The JSON file contains `session` (the session-v1
session shape) and `start` (the local host's provider/input shape). Do not put the
host credential in that file or pass it to the provider environment. The state
directory must not exist. Switch assigns the session epoch. No local command
endpoint is exposed by this process.

Apply the backend migrations first. Owner-authenticated gateway routes under
`/gateway/sessions` provide snapshots, replay and command submission. The DEV
Console host workbench's **Shared sessions** tab attaches through a saved server
sign-in. A gateway message command can supply `roomId` to select a request-card
room; the server checks agent membership and chooses the channel. Cards use the
verified owner's linked platform identity for answers. Ordinary transcript items
are never sent through the card publisher.

Lease renewal failure stops the provider. Existing shared-session directories and
expired leases require explicit recovery; this entry point does not take over an
old execution or silently start a replacement. Local host resume remains separate.
Shared commands currently support queued text and request answers. SSH deployment
and production session routing remain outside this experimental path.

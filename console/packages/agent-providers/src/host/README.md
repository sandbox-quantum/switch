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

This host accepts local-only sessions. It rejects Switch identity credentials;
shared commands require the Switch server's lease, authorization and reservation
path. SSH deployment, the shared server transport and production session routing
are not implemented here yet. No tmux fallback is used by this host.

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

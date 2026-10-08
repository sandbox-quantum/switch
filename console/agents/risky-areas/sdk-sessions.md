# Risky Area: SDK Sessions

Main code: `src/main/core/sdk-host/`, `src/main/core/sessions/`, and
`packages/agent-providers/src/host/` (relative to the console workspace).

Preserve command identity, server-issued recovery epochs, host leases, and
process-group fencing. Never replay an uncertain action automatically. Reopen
transcripts without resending their initial prompt. Stop and archive must wait
for a confirmed server stop; unknown outcomes remain visible.

Local and SSH hosts use the same SDK protocol but not the same process tree: a
local host and its room watcher are owned by Console and stop with it, and only
an SSH host is deployed and detached. The one local exception is a managed agent
run by the embedded agents controller (`src/main/core/embedded-controller/`): its
watcher is detached like a remote one, keeps running when Console quits, and
reconnects when the controller is back. A Console agent moved to managed
(`src/main/core/agent-migration/`) is the same: Console leaves its watcher and
sessions alone until it is brought back, and a move edits only watcher roots
(placements, the stream position in `assignments.jsonl`), never a session's
state. Preserve shell quoting,
execution-host credentials, environment allowlists, and attachment integrity.
Run host recovery tests and desktop session tests. See
[SDK sessions](../../docs/sdk-sessions.md) for the full contract.

# Risky Area: SDK Sessions

Main code: `src/main/core/sdk-host/`, `src/main/core/sessions/`, and
`packages/agent-providers/src/host/` (relative to the console workspace).

Preserve command identity, server-issued recovery epochs, host leases, and
process-group fencing. Never replay an uncertain action automatically. Reopen
transcripts without resending their initial prompt. Stop and archive must wait
for a confirmed server stop; unknown outcomes remain visible.

Local and SSH hosts use the same SDK protocol but not the same process tree: a
local host and its room watcher are owned by Console and stop with it, and only
an SSH host is deployed and detached. Preserve shell quoting,
execution-host credentials, environment allowlists, and attachment integrity.
Run host recovery tests and desktop session tests. See
[SDK sessions](../../docs/sdk-sessions.md) for the full contract.

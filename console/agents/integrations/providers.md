# Providers

The supported provider IDs are `claude`, `codex`, `opencode`, `antigravity`, and
`cursor`. Every session runs through its adapter in `packages/agent-providers`.
Local and SSH locations use the same persistent SDK host.

## Source of truth

- `packages/agent-providers/src/` owns native SDK/protocol execution.
- `packages/plugins/src/agents/impl/<id>/` owns CLI detection, installation,
  native skills, MCP configuration and launch profiles.
- `src/shared/core/providers/agent-provider-registry.ts` owns supported IDs and
  display metadata. Unsupported stored IDs must fail explicitly.
- `src/main/core/sdk-host/` handles deployment and the desktop host client.
- `packages/agent-providers/src/host/` owns persistent execution and recovery.

## Native transports

Claude uses the Claude Agent SDK; Codex uses app-server JSON-RPC; OpenCode uses
its HTTP/SSE SDK; Antigravity and Cursor use ACP.
Cursor ACP is the native adapter transport. Native capability limits must be
reported explicitly rather than replaced with synthetic prompts.

## Changing providers

Keep the adapter, plugin metadata, desktop registry, and host environment in
sync. The desktop environment allowlist is `src/main/core/sdk-host/agent-env.ts`.
Keep MCP helpers shared when retained providers import them. Model catalogues
come from the provider on the execution host. Test both local and SSH setup;
credentials and native configuration belong to that host.

Run the affected package tests, workspace typechecks, and desktop lint. Follow
[SDK sessions](../../docs/sdk-sessions.md) for recovery and live-test constraints.

# Providers

The supported provider IDs are `claude`, `codex`, `opencode`, `antigravity`, and
`cursor`. Every session runs through its adapter in `packages/agent-providers`.
Local and SSH locations use the same persistent SDK host.

## Source of truth

- `packages/agent-providers/src/` owns native SDK/protocol execution.
  `src/providers/registry.ts` (`PROVIDER_RUNTIMES`) is the list of providers the
  execution host runs, with each one's adapter, sign-in check, login command and
  env passthrough. ACP CLIs run on the generic adapter in `src/acp/`, with a
  hooks file each.
- `packages/plugins/src/agents/impl/<id>/` owns display metadata, CLI detection,
  installation, native skills, MCP configuration and launch profiles; the
  registration list is `plugin-registry.ts`.
- `src/shared/core/providers/agent-provider-registry.ts` is the catalogue built
  from both at startup. Unsupported stored IDs must fail explicitly.
- Adding a provider: [Add an agent provider](../../docs/add-an-agent-provider.md).
- `src/main/core/sdk-host/` handles deployment and the desktop host client.
- `packages/agent-providers/src/host/` owns persistent execution and recovery.

## Native transports

Claude uses the Claude Agent SDK; Codex uses app-server JSON-RPC; OpenCode uses
its HTTP/SSE SDK; Antigravity and Cursor use ACP.
Cursor ACP is the native adapter transport. Native capability limits must be
reported explicitly rather than replaced with synthetic prompts.

## Changing providers

The plugin and runtime registrations must name the same providers; Console and
the agents controller refuse to start otherwise. The shared environment
allowlist is `packages/agent-providers/src/host/agent-env.ts`, plus each
runtime's `inheritEnv`, used by Console and the headless agents controller.
Keep MCP helpers shared when retained providers import them. Model catalogues
come from the provider on the execution host. Test both local and SSH setup;
credentials and native configuration belong to that host.

Run the affected package tests, workspace typechecks, and desktop lint. Follow
[SDK sessions](../../docs/sdk-sessions.md) for recovery and live-test constraints.

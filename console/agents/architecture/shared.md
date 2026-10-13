# Shared Modules

## Main Shared Areas

- Agent provider registry (ids, display metadata, and a descriptive argv mirror; behavior
  lives in `packages/plugins/src/agents/impl/<id>/index.ts`):
  - `src/shared/core/providers/agent-provider-registry.ts`
- IPC primitives:
  - `src/shared/lib/ipc/rpc.ts` — typed RPC router, controller, and client
  - `src/shared/lib/ipc/events.ts` — typed event emitter
- Typed event definitions:
  - `src/shared/events/` — `appEvents.ts`, `browserEvents.ts`, `resourceEvents.ts`,
    `updateEvents.ts`, `sidecarEvents.ts`, `switchSetupEvents.ts`,
    `localSwitchServerEvents.ts`, `remoteSwitchServerEvents.ts`
  - additional domain events colocated under `src/shared/core/` — e.g.
    `core/providers/agentEvents.ts`, `core/fs/fsEvents.ts`,
    `core/locations/locationEvents.ts`, `core/sessions/sessionEvents.ts`,
    `core/switch-rooms/switchRoomEvents.ts`, `core/ssh/sshEvents.ts`,
- Domain type modules (under `src/shared/core/`):
  - `agents/`, `fs/`, `location-settings/`, `locations/`, `managed-switch-server/`,
    `mcp/`, `providers/`, `remote-hosts/`, `sessions/`, `skills/`, `ssh/`,
    `switch-rooms/`, `switch-servers/`, `switch-setup/`, `terminals/`
- App settings types:
  - `src/shared/core/app-settings.ts`

Note the `agents/` vs `providers/` split here, which mirrors `src/main/core/`:
`core/agents/` is the Switch-agent concept, `core/providers/` is the CLI-provider
registry and payload types.

## Path Aliases

All aliases are defined in a single `tsconfig.json` and mirrored in `electron.vite.config.ts`:

| Alias | Resolves to |
| --- | --- |
| `@/*` | `src/*` |
| `@renderer/*` | `src/renderer/*` |
| `@main/*` | `src/main/*` |
| `@shared/*` | `src/shared/*` |
| `@root/*` | `./*` |

Aliases are resolved at build time by electron-vite. No runtime monkey-patching is needed.

## Provider Registry Rules

When adding a provider:

Follow [Add an agent provider](../../docs/add-an-agent-provider.md). In short:

1. add the plugin under `packages/plugins/src/agents/impl/<id>/` and register it in
   `packages/plugins/src/agents/plugin-registry.ts`
2. add the runtime to `PROVIDER_RUNTIMES` in `packages/agent-providers/src/providers/registry.ts`
   (for an ACP CLI, `acpProviderRuntime(<hooks>)`), including any env passthrough in its
   `inheritEnv`
3. add the provider to core's provider table
4. add the conformance suite and tests for non-standard spawn or detection behavior

`src/shared/core/providers/agent-provider-registry.ts` is a catalogue built at startup from
the plugins and runtimes; do not add ids or per-provider data to it.

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
    `core/pty/ptyEvents.ts`
- Domain type modules (under `src/shared/core/`):
  - `agents/`, `fs/`, `location-settings/`, `locations/`, `managed-switch-server/`,
    `mcp/`, `providers/`, `pty/`, `remote-hosts/`, `sessions/`, `skills/`, `ssh/`,
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

1. add the plugin under `packages/plugins/src/agents/impl/<id>/index.ts`
2. add the id to `AGENT_PROVIDER_IDS` and a display entry to `AGENT_PROVIDERS` in
   `src/shared/core/providers/agent-provider-registry.ts`
3. add any required env passthrough in `src/main/core/pty/pty-env.ts`
4. declare the provider's `hooks` capability in the plugin if it supports explicit events;
   `src/main/core/agent-hooks/` writes the config files from that declaration
5. update renderer surfaces that assume provider metadata
6. add tests for non-standard spawn or detection behavior

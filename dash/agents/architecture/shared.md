# Shared Modules

## Main Shared Areas

- Agent provider registry (ids, display metadata, and a descriptive argv mirror; behavior
  lives in `packages/plugins/src/agents/impl/<id>/index.ts`):
  - `src/shared/core/providers/agent-provider-registry.ts`
- IPC primitives:
  - `src/shared/ipc/rpc.ts` — typed RPC router, controller, and client
  - `src/shared/ipc/events.ts` — typed event emitter
- Typed event definitions:
  - `src/shared/events/` — `appEvents.ts`, `browserEvents.ts`, `resourceEvents.ts`, `updateEvents.ts`
  - additional domain events colocated under `src/shared/core/` — e.g.
    `core/agents/agentEvents.ts`, `core/conversations/conversationEvents.ts`,
    `core/fs/fsEvents.ts`, `core/projects/projectEvents.ts`, `core/sessions/sessionEvents.ts`
- Domain type modules (under `src/shared/core/`):
  - `agents/`, `conversations/`, `fs/`, `projects/`, `project-settings/`, `pty/`,
    `sessions/`, `terminals/`, `workspaces/`
- App settings types:
  - `src/shared/core/app-settings.ts`

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

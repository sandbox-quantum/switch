# Main Process

## Structure

The main process is organized into domain modules under `src/main/core/`. Each domain typically has a `controller.ts` (RPC handlers) and service/implementation files.

## Domain Modules (`src/main/core/`)

- **agent-hooks** — HTTP hook server for agent callbacks, event enrichment, OS notifications, hook/plugin config writer, workspace/trust services
- **agents** — Agent payload builder, plugin registry, plugin filesystem
- **app** — App lifecycle service and controller
- **conversations** — Conversation CRUD and session start
- **dependencies** — CLI agent detection, probing, install runner, version/update services
- **execution-context** — Execution context resolution for agent runs
- **fs** — Filesystem operations with provider pattern (`impl/local-fs.ts`)
- **projects** — Project management with provider pattern (`impl/local-project-provider.ts`), project settings, CRUD operations
- **prompt-library** — Prompt library service and controller
- **pty** — PTY lifecycle (`local-pty.ts`), session registry, env setup, spawn utilities
- **resource-monitor** — System resource monitoring
- **runtime** — Runtime service wiring
- **search** — Search service
- **secrets** — Encrypted app secret storage
- **sessions** — Session CRUD (create, delete, rename, provision)
- **settings** — App settings service and schema, provider settings (separate controller)
- **shared** — Shared main-process utilities
- **switch-agents** — Switch agent integration
- **terminal-shell** — Terminal shell availability and detection
- **terminals** — Terminal lifecycle with provider pattern (`impl/local-terminal-provider.ts`), lifecycle scripts
- **updates** — Auto-update service
- **utils** — Cross-domain main-process helpers
- **view-state** — Persisted view/UI state
- **workspaces** — Workspace (project-root working directory) management

## Other Main Process Areas

- `src/main/app/` — Menu, protocol handler, window creation
- `src/main/lib/` — Logger, events, result type, updater error
- `src/main/db/` — Database schema and initialization
- `src/main/utils/` — Shell environment, shell escaping, child process env, external links
- `src/main/core/agent-hooks/` — Hook server, event enrichment, OS notifications, hook/plugin config writer

## IPC / RPC Structure

- All domain controllers are assembled into a typed RPC router in `src/main/rpc.ts`.
- RPC primitives live in `src/shared/ipc/rpc.ts` (`createRPCRouter`, `createRPCController`, `createRPCClient`).
- Event primitives live in `src/shared/ipc/events.ts`.
- The preload bridge (`src/preload/index.ts`) exposes only `invoke`, `eventSend`, `eventOn`, and `getPathForFile`; there are no other manual IPC handlers.

## When Editing Here

- Check `agents/conventions/main-patterns.md` for controller, service, Result type, and event patterns.
- Check `agents/conventions/ipc.md` for the RPC controller pattern and typing rules.
- Check `agents/risky-areas/pty.md` before touching PTY or provider spawn behavior.
- Check `agents/risky-areas/database.md` before changing persistence or migrations.

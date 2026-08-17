# Main Process

## Structure

The main process is organized into domain modules under `src/main/core/`. Each domain typically has a `controller.ts` (RPC handlers) and service/implementation files.

## Domain Modules (`src/main/core/`)

Two names in this list are easy to misread, because one of them changed meaning:

- **agents** is the *Switch agent* domain — an agent identity bound to a provider. It is
  **not** the CLI-tool registry.
- **providers** is the CLI-tool registry (claude, codex, …). Upstream called that concept
  an "agent"; it was renamed to free the name for the Switch-agent concept above.

- **agent-hooks** — HTTP hook server for agent callbacks, event enrichment, OS notifications, hook config writer (`hook-config-service.ts`), per-tool trust services (`claude-trust-service.ts`, `cursor-trust-service.ts`, `dir-trust-service.ts`)
- **agent-runtime** — How a session is actually launched and supervised: launch profiles, the runtime supervisor, and `impl/` backends — `local-agent-runtime.ts` (local spawn) and `ssh-agent-runtime.ts` (remote), plus sidecar launch/HTTP and keystroke injection
- **agents** — The Switch-agent domain: create/rename/delete, directory detection (`detect.ts`), onboarding, remote agent discovery and reconciliation, Switch credential/settings files
- **app** — App lifecycle service and controller
- **dependencies** — CLI agent detection, probing, install runner, version/update services, and their remote counterparts (`remote-dependency-manager.ts`, `ssh-install-runner.ts`)
- **execution-context** — Where a command runs: `local-execution-context.ts` vs `ssh-execution-context.ts`
- **fs** — Filesystem operations with provider pattern (`impl/local-fs.ts`)
- **locations** — An agent's working directory on a host. Replaces the upstream project/workspace split; provider pattern plus lifecycle scripts
- **managed-switch-server** — A Switch Console-managed Switch server deployed via Docker Compose
- **prompt-library** — Prompt library service and controller
- **providers** — CLI-provider plugin registry (`plugin-registry.ts`), agent payload builder, plugin filesystem, argv parity test
- **pty** — PTY lifecycle (`local-pty.ts`), session registry, env setup, spawn utilities
- **remote-hosts** — SSH host records, reachability probing (`host-reachability-service.ts`), and host setup
- **resource-monitor** — System resource monitoring
- **search** — Search service
- **secrets** — Encrypted app secret storage
- **sessions** — Session CRUD (create, delete, rename, provision)
- **settings** — App settings service and schema, provider settings (separate controller)
- **shared** — Shared main-process utilities (OAuth flow)
- **sidecar** — Desktop-side view of the remote sidecar: diagnostics and health verdicts. The sidecar implementation itself is `src/sidecar/`
- **ssh** — SSH config, connection, lifecycle, and transport
- **switch-rooms** — Room connections, the auto-session watcher, prompt injection sinks, Switch credentials, notification polling
- **switch-servers** — Switch server records, gateway client, auth, room creation
- **switch-setup** — First-run Switch setup, local and remote (`remote-switch-setup.ts`)
- **telemetry** — The consent gate, the closed event catalogue, and the Amplitude sender (`telemetry-listeners.ts` is the only place the six reported events are subscribed)
- **terminal-shell** — Terminal shell availability and detection
- **terminals** — Terminal lifecycle with provider pattern (`impl/local-terminal-provider.ts`), lifecycle scripts
- **updates** — Auto-update service
- **utils** — Cross-domain main-process helpers (exec, TTL cache, compensation)
- **view-state** — Persisted view/UI state

## Other Main Process Areas

- `src/main/app/` — Menu, protocol handler, deeplinks, window creation, app identity
- `src/main/lib/` — Logger and file logger, log context (`AsyncLocalStorage`) and enrichment, events, rate limiter, retry, semver
- `src/main/db/` — Database schema, client, initialization, versioned columns
- `src/main/utils/` — Shell environment, shell escaping, child process env, external links
- `src/sidecar/` — The headless remote sidecar. Not part of `src/main/`, but it re-implements
  much of what the main process does for a session; see the sidecar section of `AGENTS.md`.

The `Result<T, E>` type is **not** in `src/main/lib/`. It lives in the `@switch-console/shared`
workspace package (`packages/shared/src/result.ts`) and is imported as
`import { ok, err, type Result } from '@switch-console/shared'`.

## IPC / RPC Structure

- All domain controllers are assembled into a typed RPC router in `src/main/rpc.ts`.
- RPC primitives live in `src/shared/lib/ipc/rpc.ts` (`createRPCRouter`, `createRPCController`, `createRPCClient`).
- Event primitives live in `src/shared/lib/ipc/events.ts`.
- The preload bridge (`src/preload/index.ts`) exposes only `invoke`, `eventSend`, `eventOn`, and `getPathForFile`; there are no other manual IPC handlers.

## When Editing Here

- Check `agents/conventions/main-patterns.md` for controller, service, Result type, and event patterns.
- Check `agents/conventions/ipc.md` for the RPC controller pattern and typing rules.
- Check `agents/risky-areas/pty.md` before touching PTY or provider spawn behavior.
- Check `agents/risky-areas/database.md` before changing persistence or migrations.

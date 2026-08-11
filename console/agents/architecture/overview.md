# Architecture Overview

All paths are relative to `apps/switch-console-desktop/`.

## Process Model

- `src/main/`: Electron main process — app lifecycle, RPC controllers, domain services, database, PTY orchestration, updater
- `src/preload/`: Electron preload bridge — exposes typed `invoke`, `eventSend`, `eventOn` to renderer
- `src/renderer/`: React UI — app shell (`app/`), feature areas (`features/`), shared infrastructure (`lib/`), typed RPC client
- `src/shared/`: Agent provider registry, IPC primitives (RPC + events), shared domain types under `src/shared/core/`
- `src/sidecar/`: The headless on-host sidecar that keeps a remote session running while Switch Console is closed. Not an Electron process — see `remote-execution.md`

## Boot Sequence

`src/main/index.ts` → app lifecycle → IPC/RPC registration → window creation → renderer

- `index.ts` — Loads `.env`, normalizes PATH, initializes database, registers all RPC controllers via `src/main/rpc.ts`, creates the main window.
- `src/main/rpc.ts` — Assembles the typed RPC router from domain controllers (`src/main/core/*/controller.ts`).
- `src/preload/index.ts` — Exposes `window.electronAPI` (`invoke`, `eventSend`, `eventOn`) via `contextBridge`.
- `src/renderer/lib/ipc.ts` — Creates the typed RPC client and event emitter used throughout the renderer.

## Build Tooling

- `electron.vite.config.ts` — electron-vite config for main, preload, and renderer builds.
- `vitest.config.ts` — Vitest config with five test projects: `node`, `main-db`, `fixtures`, `migrations`, and `browser` (Playwright-backed renderer tests).
- Single `tsconfig.json` (in `apps/switch-console-desktop/`) for all app targets.

## Read Next

- Main process details: `main-process.md`
- Renderer details: `renderer.md`
- Shared modules and provider registry: `shared.md`
- Remote hosts, reachability, and the sidecar: `remote-execution.md`
- Switch rooms and session binding: `switch-rooms.md`

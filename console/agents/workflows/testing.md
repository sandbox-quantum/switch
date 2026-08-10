# Testing And Validation

All paths are relative to `apps/switch-console-desktop/`.

## Core Local Gate

Run these before merging (from the repo root or `apps/switch-console-desktop/`):

```bash
pnpm run format
pnpm run lint
pnpm run typecheck
pnpm run test
```

## Test Layout

- main-process tests: colocated in `src/main/core/**/*.test.ts`
- renderer unit tests: `src/renderer/tests/`
- renderer browser tests: `src/renderer/tests/browser/` (run via Playwright)

## Current Setup

- Vitest config is in `vitest.config.ts` (separate from the build config in `electron.vite.config.ts`).
- Five test projects:
  - `node` — `src/**/*.test.ts` excluding `_*` dirs, browser tests, migration tests, and `*.db.test.ts` under `src/main/core/` and `src/main/db/`
  - `main-db` — `src/main/core/**/*.db.test.ts` and `src/main/db/**/*.db.test.ts` against real SQLite
  - `fixtures` — fixture generator, run via `pnpm run db:fixtures`
  - `migrations` — `src/main/db/tests/migrations/**`, run via `pnpm run test:migrations`
  - `browser` — `src/renderer/tests/browser/**/*.test.{ts,tsx}` via Playwright
- `pnpm run test` runs the `node`, `main-db`, `migrations`, and `browser` projects.
- Both project globs still mention `src/main/db/legacy-port/`, which no longer exists. The
  globs are harmless but match nothing — do not go looking for that directory.
- Tests use per-file `vi.mock()` setup.
- Integration-style tests create temporary project directories in `os.tmpdir()`.

## Pre-merge Checks

- Run these locally before merging:
  - `pnpm run format:check`
  - `pnpm run typecheck`
  - `pnpm run lint`
- Run the tests locally before merging as well.

## Focused Validation

- after IPC/RPC changes: rerun the affected Vitest file and confirm the controller is wired in `src/main/rpc.ts`
- after session or PTY changes: rerun the closest `src/main/core/` test files
- after schema changes: run `pnpm run db:fixtures` and `pnpm run test:migrations`

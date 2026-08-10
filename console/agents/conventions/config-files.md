# Config Files And Repo Rules

## Key Files

Repo root:

- `package.json` (aggregate workspace scripts)
- `pnpm-workspace.yaml`
- `.nvmrc`
- `.oxfmtrc.json`, `.oxlintrc.json`

In `apps/switch-console-desktop/`:

- `package.json` (app scripts and version)
- `electron.vite.config.ts`
- `vitest.config.ts`
- `tsconfig.json`
- `drizzle.config.ts`
- `flake.nix`

Per-project (user repos): `.switchdash.json`

## Repo Rules

- avoid editing `dist/`, `release/`, and `build/` unless the task is explicitly about packaging or signing
- update the narrowest relevant page in `agents/` instead of growing `AGENTS.md`

# Switch Gateway

The operator dashboard for [Agent Switch](../README.md) — a web frontend to
create and manage rooms, agents, and users, and watch what's happening across
the platform.

Built with Node/Vite and served via nginx. Development commands live in the
repository-root `justfile`: `just gateway-install` (deps, first time only),
`just gateway-dev` (dev server), `just gateway-build` (production build).

## Licence key

The data grid is `@mui/x-data-grid-pro`, which needs a MUI X Pro licence key.
Copy `.env.example` to `.env` and fill in `VITE_MUI_X_LICENSE_KEY`; without it
the grids render with a watermark. The key is injected into the bundle at build
time — pass it as the `VITE_MUI_X_LICENSE_KEY` build argument for container
builds, and store it as a secret in CI. Never commit it: this repository is the
source of the open-source release artifacts.

## Design system

The UI follows the Hoot design system. `src/theme/hoot.css` is vendored from
the Hoot source and is the single source of truth for token values; the MUI
theme in `src/theme/theme.ts` reads from it. MUI cannot parse the `oklch()`
colours the tokens are authored in, so `npm run gen:tokens` regenerates
`src/theme/hoot-tokens.ts` with sRGB equivalents — re-syncing Hoot upstream is
a copy of `hoot.css` plus that command. The formatting conventions Hoot is
prescriptive about (dates, numbers, empty values, identifiers) live in
`src/theme/hootFormat.ts`.

> **Note:** full documentation is coming as part of the docs effort.

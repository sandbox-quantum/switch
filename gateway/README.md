# Switch Gateway

The operator dashboard for [Agent Switch](../README.md) — a web frontend to
create and manage rooms, agents, and users, and watch what's happening across
the platform.

Built with Node/Vite and served via nginx. Development commands live in the
repository-root `justfile`: `just gateway-install` (deps, first time only),
`just gateway-dev` (dev server), `just gateway-build` (production build).

## Design system

The UI follows the Hoot design system. `src/theme/hoot.css` is vendored from
the Hoot source and is the single source of truth for token values; the MUI
theme in `src/theme/theme.ts` reads from it. MUI cannot parse the `oklch()`
colours the tokens are authored in, so `npm run gen:tokens` regenerates
`src/theme/hoot-tokens.ts` with sRGB equivalents — re-syncing Hoot upstream is
a copy of `hoot.css` plus that command. The formatting conventions Hoot is
prescriptive about (dates, numbers, empty values, identifiers) live in
`src/theme/hootFormat.ts`.

## Documentation

User-facing documentation for Switch is published at
[docs.flintai.dev](https://docs.flintai.dev/flintai/switch/getting-started).

# Switch Gateway

The operator dashboard for [Agent Switch](../README.md) — a web frontend to
create and manage rooms, agents, and users, and watch what's happening across
the platform.

Built with Node/Vite and served via nginx. Development commands live in the
repository-root `justfile`: `just gateway-install` (deps, first time only),
`just gateway-dev` (dev server), `just gateway-build` (production build).

## Dev-only tools

`src/dev/` holds tools for the dev server alone, such as the role switcher
that shows the dashboard as an operator, org admin, workspace admin or member
(seed its accounts with `just seed-dev-roles`; see
[LOCAL_DEVELOPMENT.md](../docs/old/LOCAL_DEVELOPMENT.md#viewing-the-dashboard-as-each-role)).
Import them only behind `import.meta.env.DEV`, as `src/layout/DevRoleSlot.tsx`
does: a production build then leaves them out, and `npm run build` fails if
one gets in anyway (`scripts/check-no-dev-tools.mjs`).

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
[docs.switchagents.ai](https://docs.switchagents.ai/switch-rooms/getting-started).

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

`src/theme/tokens.css` is the single source of truth for the design's token
values, copied from the design prototype; the MUI theme in
`src/theme/theme.ts` reads from it. MUI cannot parse the `oklch()` colours
the tokens are authored in, so `npm run gen:tokens` regenerates
`src/theme/tokens.ts` with sRGB equivalents — re-syncing the tokens is a copy
of `tokens.css` plus that command. The formatting conventions the design is
prescriptive about (dates, numbers, empty values, identifiers) live in
`src/theme/format.ts`.

## Pages and who may open them

Every page is a row of `src/routes/routeTable.tsx`, which the routes, their
guards, the rail and the settings menus are all built from. Who may open each
one, role by role and in each layout, is written down separately in
`src/routes/roleMatrix.ts`, from the target role matrix rather than from the
code. Adding a page, or building one that showed "isn't built yet", means
updating its row there in the same change: `roleMatrix.test.ts` holds the
route table to it, and the end-to-end browser lane (`just e2e-browser`,
`just e2e-browser-v2`) signs in as a real account in each role and opens every
page it lists.

## Documentation

User-facing documentation for Switch is published at
[docs.switchagents.ai](https://docs.switchagents.ai/switch-rooms/getting-started).

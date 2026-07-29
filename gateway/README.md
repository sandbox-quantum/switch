# Switch Gateway

The operator dashboard for [Agent Switch](../README.md) — a web frontend to
create and manage rooms, agents, and users, and watch what's happening across
the platform.

Built with Node/Vite and served via nginx. Development commands live in the
repository-root `justfile`: `just gateway-install` (deps, first time only),
`just gateway-dev` (dev server), `just gateway-build` (production build).

## Licence key

The tables use `@mui/x-data-grid-pro`, which needs a MUI X Pro licence key.
Without one they render with a "Missing license key" watermark.

A MUI licence cannot be redistributed, so the published gateway image ships
without a key and **every deployment supplies its own**. The key is read at
**runtime**, not baked into the bundle, so operators who pull the image or
install the Helm chart can configure it without rebuilding:

- **Helm** — set `gateway.muiLicenseKey.value`, or point
  `gateway.muiLicenseKey.existingSecret` at a Secret you manage. Changing it is
  a `helm upgrade`.
- **Docker / compose** — set `MUI_X_LICENSE_KEY` on the gateway container.
- **Local dev (`just gateway-dev`)** — Vite serves the bundle directly, so copy
  `.env.example` to `.env` (gitignored) and set `VITE_MUI_X_LICENSE_KEY`.

At container start `deploy/shared_resources/gateway-runtime-config.sh` writes
`config.js` from the environment; `index.html` loads it before the app. Add
further per-deployment settings to that script and to `src/runtimeConfig.ts`.
Never commit a key — this repository is the source of the open-source release
artifacts.

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

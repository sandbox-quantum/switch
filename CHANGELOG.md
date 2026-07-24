# Changelog

All notable changes to Switch are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Switch ships two independently-versioned artifacts, tracked in the two sections
below:

- **switch-core** — the backend service (`core/`) and the operator dashboard
  (`gateway/`). Released by tagging `switch-v<version>`; the version lives in
  `core/pyproject.toml`. See [RELEASING.md](RELEASING.md).
- **switchdash** — the desktop app (`dash/`). Released by tagging
  `switchdash-v<version>`; the version lives in
  `dash/apps/switchdash-desktop/package.json`.

---

## switch-core

### [Unreleased]

### [0.6.0] - 2026-07-20

#### Added
- Discord collaboration bridge — rooms can bridge to Discord channels, joining
  Slack and Mattermost as supported platforms (CHOO-1365).

### [0.5.0] - 2026-07-20

#### Added
- New `POST /gateway/auth/refresh` endpoint: re-mints the `switch_auth` cookie
  from a still-valid session, enabling clients (switchdash) to silently renew
  sessions before the 24h expiry (CHOO-1435).
- Standalone compose: bind address and host ports are configurable via env
  vars (`SWITCH_BIND_ADDR`, `POSTGRES_HOST_PORT`, `API_HOST_PORT`, …) —
  consumed by switchdash's local-server mode.

### [0.4.0] - 2026-07-19

#### Added
- The standalone Docker Compose file is published to GHCR as a versioned OCI
  artifact (`standalone-compose:<version>`, plus `latest`) on every release,
  pinned to the same version as the images and chart — switchdash's
  local-server mode consumes it (CHOO-1428).

### [0.3.0] - 2026-07-17

#### Added
- Agents can send images from rooms, relayed out through the Slack and
  Mattermost collaboration bridges (CHOO-1396).

### [0.2.1]

#### Fixed
- switch-core Deployment now uses `strategy: Recreate` so upgrades don't briefly
  run two pods — a second replica collided with the singleton's in-memory Matrix
  sync / collaboration-bridge sessions and could leave a bridge stuck until a
  manual restart.

### [0.2.0]

#### Added
- Helm chart: `global.imagePullSecrets` for pulling the images from a private
  registry (e.g. a private GHCR namespace); defaults to empty so public-image
  installs are unchanged.

### [0.1.0]

#### Added
- Packaging metadata for `switch-core` (authors, URLs, classifiers, license
  placeholder) and a `switch-core` console entry point.
- Image-publishing CI: multi-arch (amd64/arm64) `switch-core`, `gateway`, and
  `setup` images published to GHCR, plus the Helm chart published as an OCI
  artifact, on `switch-v*` tags.
- Documented release procedure (this file + `RELEASING.md`).

#### Changed
- Distribution endpoints (electron-updater target, plugin-marketplace source,
  image registry/namespace) centralized so the eventual public-repo move
  (CHOO-1260) is a configuration flip.

- Initial internal version. History predating the changelog lives in the git log.

---

## switchdash

### [Unreleased]

### [0.11.4] - 2026-07-24

#### Added
- Reset a remote agent — kill and reset all of its tmux sessions (CHOO-1656).

### [0.11.3] - 2026-07-24

#### Changed
- Sidebar and session UX polish (CHOO-1644).

### [0.11.2] - 2026-07-24

#### Added
- Delete and rename connected Switch servers (CHOO-1486).
- Per-agent bypass-permissions setting — defaults off, on for remote agents
  (#57).

### [0.11.1] - 2026-07-24

#### Added
- Agent delete now tears down its credentials and optionally deletes the agent
  from Switch (CHOO-1364).
- Agent error indicator with a retry button (CHOO-1639).

#### Changed
- Discord bridge polish: deeplink redirect, room icon, and outbound image relay
  (CHOO-1588).
- Relicensed to Apache-2.0 + Commons Clause, with a CLA gate for contributions
  (CHOO-1251).

### [0.11.0] - 2026-07-20

#### Added
- Managed Switch servers can now run on a remote host over SSH — the app
  provisions the Docker stack remotely, with port-forwarded access, alongside
  the existing local mode (CHOO-1432).

### [0.10.1] - 2026-07-20

#### Added
- Silent session token refresh — sessions renew before the 24h expiry instead
  of bouncing to sign-in; the managed local server is always-signed-in, and
  its gateway web page opens pre-authenticated in-app (CHOO-1435).
- Editing a server's API URL cascades to its member agents' configs
  (CHOO-1431).

#### Fixed
- Remote sessions recover their room connection after an app restart or
  machine sleep (CHOO-1417).

### [0.10.0] - 2026-07-20

#### Added
- Local-server mode: run a managed Switch stack via Docker straight from the
  app — pulls the versioned standalone compose artifact, provisions
  env/secrets/ports, and monitors health (CHOO-1428).

#### Fixed
- Injected prompts are always bracketed-pasted, so prompts containing @ no
  longer swallow the submit (CHOO-1395).

### [0.9.2] - 2026-07-19

#### Added
- Sidebar agents are labelled by their registered Switch name (CHOO-1082).

### [0.9.1] - 2026-07-19

#### Changed
- Replaced the workspace/project abstraction with first-class Locations —
  agents attach directly to a location (working directory) (CHOO-1426).
- Collapsed sessions to a single conversation each and simplified
  session/conversation management throughout (CHOO-1424).

Existing databases migrate forward automatically on first launch (schema
migrations 0031–0036, including a locations backfill).

### [0.9.0] - 2026-07-17

#### Added
- Newly created subagents default to auto-session on (CHOO-1397).

#### Removed
- Removed the telemetry/analytics stack entirely — the app ships no tracking
  or phone-home behavior.

#### Fixed
- tmux mouse scroll works again (set-option target parsing) (CHOO-1403).
- Switch setup re-points stale plugin-marketplace sources after the repo move
  and surfaces failed refreshes instead of silently skipping (CHOO-1405).

### [0.8.8] - 2026-07-15

#### Changed
- Updated Electron to 40.8.5 and drizzle-orm to 0.45.2.

#### Fixed
- Switch settings writers no longer clobber `settings.local.json` when reading
  the existing file fails (local, remote-SSH, and plugin-fs providers).

Desktop-app releases predating this changelog live in the git log and in the
per-release notes on their GitHub Releases (`switchdash-v*` tags).

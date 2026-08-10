# Changelog

All notable changes to Switch are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Switch ships several independently-versioned artifacts, each with its own
section below. Every artifact carries three-part semver (`MAJOR.MINOR.PATCH`)
and a changelog, without exception (CHOO-1865).

A version says **where an artifact is** — which release you are running. It says
nothing about what that release can talk to. Compatibility is carried separately
by the contract revisions in [`artifacts.yaml`](artifacts.yaml), which move
independently: a release that changes nothing on the wire bumps its version and
leaves its contracts alone.

- **switch-core** — the backend service (`core/`). Released by tagging
  `switch-v<version>`; the version lives in `core/pyproject.toml`. See
  [RELEASING.md](RELEASING.md).
- **switchdash** — the desktop app (`dash/`). Released by tagging
  `switchdash-v<version>`; the version lives in
  `dash/apps/switchdash-desktop/package.json`.
- **agent-runtime** — the Switch protocol client and MCP runtime
  (`dash/packages/switch-agent-runtime/`), published to a package registry.
- **sidecar** — the remote runtime switchdash deploys to an agent host
  (`dash/apps/switchdash-desktop/src/sidecar/`). Versioned in
  `sidecar-version.ts` and deployed by switchdash, not published separately.
- **switch-connector** / **switch-connector-codex** — the two connector plugins
  (`connectors/`), versioned in their respective plugin manifests.

Three things are **not** separately versioned, and ship under the switch-core
release so a single tag pins the whole stack: the **operator dashboard**
(`gateway/`), the **Helm chart**, and the **standalone compose artifact**. Their
versions are stamped at package time from the switch-core version; do not add a
version of their own to them without also giving them a release of their own.

---

## switch-core

### [Unreleased]

#### Fixed
- `read_context` seeks to a `before` window via the homeserver's
  `timestamp_to_event` rather than paging over everything newer to reach it,
  and falls back to a scan with its own page budget when the server cannot
  answer (CHOO-2034). Previously the walk shared the read budget, so a window
  deep in a busy room returned empty however small a `limit` was asked for.
- `read_context` now pages the homeserver instead of reading a single
  `/messages` page, so agents see the whole room rather than the last slice of
  it (CHOO-2034). `before` pages backwards into older history rather than
  filtering one page, and the response reports `truncated` and
  `oldest_timestamp` so a shortened read can never pass as a complete one. Room
  joins now appear in the timeline as `kind: "room_join"` entries. The
  `GET /agents/{id}/rooms/{id}/history` endpoint, which read the result as a
  flat message list when it has always been thread groups and so returned no
  events at all, is fixed with it.

#### Changed
- **Breaking (agent-facing):** `read_context` returns
  `{threads, truncated, oldest_timestamp}` rather than a bare list of thread
  groups, and every entry carries a `kind` (CHOO-2034). Both connector skills
  are updated.

### [0.12.4] - 2026-08-09

#### Added
- Cross-artifact version compatibility, part 1 — every artifact declares what it
  is and what it speaks (CHOO-1865). `artifacts.yaml` is the one authored
  registry of contract revisions; per-language modules are generated from it and
  CI fails if they are stale or hand-edited. switch-core reads its own release
  version, discloses it and its ranges on authenticated surfaces only (the
  `connection_state` frame, the 409 refusal body, the gateway session response,
  and an authenticated credential-scoped `GET /version`), and records what each
  client declared. **Nothing acts on the declarations yet** — a client that
  declares nothing connects exactly as before.
- The authentication surface is now **frozen**: never versioned, permanently
  backward-compatible, and excluded from `gateway-api`, so a client can always
  authenticate far enough to be told what is wrong (CHOO-1865).

#### Fixed
- The agent-protocol check no longer defaults a silent client to the server's own
  version. It defaulted to agreement, and since no shipped client ever sent
  `?protocol=`, the check had never once fired. Absent now records as unknown —
  and still connects (CHOO-1865).
- A protocol refusal names which side is behind. It always said "update the
  Switch agent runtime", which for a client ahead of the server sent the user to
  downgrade the side that was already right (CHOO-1865).
- The compatibility check is a range overlap rather than exact equality. The two
  numbers are equal today, so nothing changes yet (CHOO-1865).
- `SWITCH_VERSION` is required by the standalone compose instead of defaulting to
  `latest`, which silently floated the whole stack to whatever had most recently
  been published (CHOO-1865).
- The Helm chart no longer claims a version it has not been at for months. The
  real one is stamped at package time; the file now says `0.0.0-dev` (CHOO-1865).
- Refreshed the stale switch-core version in `uv.lock`, which the release
  procedure never re-locked (CHOO-1865).

#### Security
- Bump core Python dependencies (cryptography, aiohttp, starlette, mcp,
  pydantic-settings, joserfc, python-multipart) to current releases.

### [0.12.3] - 2026-08-07

#### Added
- Collaboration bridges expose a workspace/home deeplink so a client can open
  the messaging app's workspace from the gateway (CHOO-1784).

#### Security
- Admin-gate every collaboration-bridge write: updating and deleting a bridge
  were ungated, so any authenticated user could toggle agent greetings or delete
  a bridge (which cascades into deleting every room on it) — now admin-only
  (CHOO-1784).

### [0.12.2] - 2026-08-07

#### Changed
- The collaboration-bridge runtime indicator now follows the agent: it moves to
  the foot of the conversation and into the thread the triggering message belongs
  to (instead of staying where the turn opened), and the agent — not the bridge
  watching traffic — decides when it moves (new `anchor_event_id` on the
  runtime-state protocol), so it no longer jumps below a human's message before
  the agent has been handed it (CHOO-1104).

#### Fixed
- Runtime-indicator robustness: serialise refresh vs repositioning, and don't
  strand the indicator when a turn ends mid-move (CHOO-1104).
- Discord: delete an agent's messages through the same webhook that posted them
  (CHOO-1104).
- Agent bridge: clamp a resumed cursor to the in-memory buffer head on heartbeat,
  so a connection no longer silently skips events up to a stale cursor after a
  switch-core restart.
- Agent bridge: write the legacy room-binding row only for connectionless
  (MCP-transport) callers, so a connection-backed `connect_to_room` no longer
  leaves an unread, never-cleaned binding row behind.

### [0.12.1] - 2026-08-05

#### Security
- Retire the unauthenticated `/collab` bridge-admin API (CHOO-1251, H5, #120).
- Re-scan and bump dependency CVEs (CHOO-1251, M5, #123).
- Local stacks are secure by default: published ports bind to `127.0.0.1`
  (`SWITCH_BIND_ADDR=0.0.0.0` is now an explicit opt-in for network exposure),
  `.env.example` ships every secret blank, and `just init-env` generates strong
  random credentials — no more `admin/admin` reachable on `0.0.0.0` (CHOO-1251,
  M1, #122).

#### Fixed
- Enforce one session of an agent per room: `connect_to_room` now refuses with
  HTTP 409 when another session of the same agent already holds the room, and a
  takeover evicts and reports the displaced session — instead of silently
  stranding a session in a room whose events go elsewhere (CHOO-1419, #109).

### [0.12.0] - 2026-08-04

#### Added
- Codex registered as its own gateway known-agent (connector_type "Codex") with
  a Codex-flavored "no live session" command, instead of falling back to Claude's
  builder (CHOO-1436, #91).
- `cancel_task` agent operation — a requester can abandon a task it delegated,
  recording the reason and notifying the room; served on both the MCP server and
  the HTTP front door (CHOO-1436, #79).

#### Changed
- `list_participants` now includes each participant's `status` and `alias` (both
  null when unset) (CHOO-1436, #79).

### [0.11.0] - 2026-08-03

#### Added
- Agent bridge push transport (design + Stages A & B): a sequenced,
  non-destructive per-agent event buffer plus a push connection with SSE
  delivery (`GET /agents/{id}/events`, one `POST /connection/beat` for liveness
  and cursor), replacing long-poll's destroy-on-read queue; presence becomes a
  union of heartbeat and live connection, and connection status is derived from
  what a connection observes rather than a declared `connection_model`. Backward
  compatible — polling keeps working and old/new state are read together
  (CHOO-1857, #100).

### [0.10.0] - 2026-07-30

#### Added
- Full attachment support — any file type and multiple files per message, in both
  directions across Slack, Mattermost, and Discord. Non-image files are relayed
  instead of silently dropped, multi-file messages are coalesced into a single
  platform post, and the 20MB size cap is now enforced inbound too; oversize or
  failed files are disclosed in the room rather than dropped (CHOO-1802, #93).

### [0.9.0] - 2026-07-29

#### Added
- Every room now gets a collaboration bridge by default: a bridge can be marked
  default and is used when a room names none, with `internal_only` as the
  explicit opt-out; a bundled Mattermost is provisioned across compose and Helm
  (CHOO-1674, #84).

#### Changed
- Restyle the Switch Gateway web UI onto the Hoot design system — new light/dark
  theme, icon-rail shell, and consistent formatting conventions; nav
  destinations unchanged (CHOO-1782, #87).

### [0.8.1] - 2026-07-24

#### Fixed
- Prevent a duplicate Switch room from being created when provisioning a Slack
  channel (race on bridge channel provisioning) (CHOO-1660).

### [0.8.0] - 2026-07-24

#### Added
- Scoped agent-addressing permissions — control which agents and rooms an agent
  may address, enforced server-side (CHOO-1585).

### [0.7.0] - 2026-07-24

#### Added
- Microsoft Teams collaboration bridge — rooms can bridge to Teams channels,
  joining Slack, Mattermost, and Discord as supported platforms (CHOO-1281).
- Discord bridge polish: deeplink redirect, room icon, and outbound image relay
  (CHOO-1588).

#### Changed
- Relicensed to Apache-2.0 + Commons Clause, with a CLA gate for contributions
  (CHOO-1251).

#### Fixed
- Detach dependent rooms before removing a bridge, so bridge removal no longer
  leaves rooms in a broken state (#35).

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

#### Changed
- Bump the Codex session runtime pin (`SWITCH_AGENT_RUNTIME_VERSION`) to `0.1.6`
  so switchdash-launched Codex sessions run the published runtime. Ships in the
  next switchdash release.

### [0.19.3] - 2026-08-09

#### Added
- Declares its `sidecar-control` range in the sidecar's ready file, and reads
  back whatever a running sidecar declares. A sidecar that declares nothing
  records as unknown, never as agreement (CHOO-1865).

#### Fixed
- A gateway call to a managed server whose stack is **stopped** now fails with
  the lifecycle state, naming the server, instead of timing out and reporting
  `Could not reach http://localhost:<port>` — a local address that was never
  the problem. It is logged as the modeled state it is rather than as an RPC
  error, and the proactive session renewal no longer warns about the same
  absence a second time (CHOO-1780).
- A managed server whose deployed switch-core version **cannot be read** is now
  surfaced as such, in the banner and the sidebar. It previously reported "no
  drift" — the identical result a healthy, in-step stack gives — so a failed
  probe rendered as a green server and the user was told nothing (CHOO-1865).
- Starting a stack whose version cannot be compared to this build's pin now says
  so loudly. It passed in complete silence, in the same branch as a clean match,
  while carrying the same risk as a downgrade (CHOO-1865).
- CI verifies the bundled standalone compose is in step with the repo's copy.
  Nothing checked before — the two could drift with only a comment asking
  nicely, which is how the sync script once silently stopped running
  (CHOO-1865).
- The host-unreachable panel now also shows on a location that mounted while its
  host was up, not only one that never mounted. Such a location stayed `ready`
  and kept every control live over a dead SSH transport — the sidebar showed the
  trouble icon, the main pane did not; it restores itself when the host returns
  (CHOO-1682).

#### Security
- Bump bundled dependencies for two advisories — DOMPurify `SAFE_FOR_TEMPLATES`
  bypass in `RETURN_DOM` mode (GHSA-crv5-9vww-q3g8), and brace-expansion
  denial-of-service via exponential expansion (GHSA-3jxr-9vmj-r5cp).

### [0.19.2] - 2026-08-07

#### Added
- Connect a messaging app (Slack/Mattermost/Discord/Teams) to a server from
  within switchdash — per-platform setup-guide links and a Teams icon; open a
  messaging app's workspace from the server page (CHOO-1784).

#### Changed
- New macOS app icon (max.tam's mark); a dark mark for non-release (canary/dev)
  channels; dropped the leftover emdash DMG art/wordmark (CHOO-2004).
- Bump the bundled switch-core for local managed servers to `0.12.3`
  (`COMPATIBLE_SWITCH_VERSION`).

#### Fixed
- Restore sidebar drag-to-reorder for agents and rooms (CHOO-2007).
- Set `GATEWAY_PUBLIC_URL` so "Open in SwitchDash" links work; redact the
  credential key names configs actually use; vendor the real Teams logo
  (CHOO-1784).

### [0.19.1] - 2026-08-07

#### Changed
- switchdash sessions report their latest-message anchor so the
  collaboration-bridge runtime indicator can follow the agent to the foot of the
  conversation (CHOO-1104).
- Bump the bundled switch-core for local managed servers to `0.12.2`
  (`COMPATIBLE_SWITCH_VERSION`), so a fresh local stack pulls the latest
  switch-core and existing stacks flag the drift for a one-click update.

#### Fixed
- Fix an import cycle that could leave the view registry half-built — a renderer
  crash ("Cannot access 'remoteHostsView' before initialization"), deterministic
  in CI and load-order-dependent locally (CHOO-1104).

### [0.19.0] - 2026-08-07

#### Added
- Remote-host onboarding rewritten as per-host pages with a staged,
  one-click-per-prerequisite setup: install each prerequisite individually with
  live progress, inline GitHub CLI sign-in, and agent creation gated on host
  readiness (CHOO-1809).
- Surface and act on available updates on a remote host — detect Codex/CLI
  updates remotely, re-check one dependency at a time, and show which version an
  update brings, flagged in the sidebar (CHOO-1809).
- Discover and onboard already-configured agents on a shared remote host
  (CHOO-1937, #130).
- Detect switch-core drift on a managed stack and update it; flag drift on the
  sidebar server rows (CHOO-1736).
- Command palette now searches across your agents and rooms — not just
  navigation — labelling what each result is, jumping into another server's
  scope, and adding an "Add Switch Server" command (CHOO-1423, #140).

#### Changed
- Split an agent type into separate CLI and connector rows; drop the
  servers-sidebar text actions (CHOO-1809, CHOO-1953).
- Pin switch-core `0.12.1` for the managed stack (CHOO-1736).

#### Fixed
- Remote-host setup hardening: a host without the GitHub CLI no longer reports
  itself Ready; the readiness probe no longer races itself; host vs agent-type
  readiness are judged separately; stale plans rebuild; a failed update is no
  longer treated as a broken dependency; only CLI updates switchdash can
  actually perform are offered; agent creation refuses an unchecked type; the
  agent type clears when the run location changes; remote-host pages scroll; and
  a remote install no longer hangs on an unanswerable prompt (CHOO-1809).
- Dialogs opt out of the window drag region; the alert action no longer overlaps
  its text (CHOO-1953, CHOO-1736).
- Migration safety: register migration 0046 in the drizzle journal, fail loud
  when a migration isn't registered, and assert the migration runner's timestamp
  precondition (CHOO-1809).
- Command-palette matching: a hyphenated query is no longer split into separate
  terms, matches no longer land mid-word, results rank like the sidebar, and the
  search index no longer treats `item_type` as content (CHOO-1423, #140).

### [0.18.3] - 2026-08-06

#### Added
- The Codex connector plugin now ships the Switch MCP server itself
  (`mcpServers` + `env_vars` name-forwarding), so Codex can be used with Switch
  **outside switchdash** — previously the server was registered only by a
  switchdash-written profile, and a hand-run Codex session had the room-workflow
  skill but none of the tools it describes. The plugin also auto-approves the
  Switch tools, which no `approval_policy` setting could do: measured against
  codex-cli 0.146.0, that setting does not govern MCP tool calls at all
  (CHOO-1935).

  ⚠️ Codex upgrades a plugin only when a user clicks Update in Settings and
  caches each version separately, so an install still on an older connector has
  no Switch tools until it is upgraded.

#### Fixed
- Bypass permissions is applied to sessions again: the toggle is stored on the
  agent but every launch read a copy frozen into the session at creation, so
  changing it never affected an existing session — on restart or resume — while
  the settings copy promised the opposite (CHOO-1935).
- Codex runtime status reports tool calls ("Running tool …") instead of sitting
  on "Working on it…" for a whole turn; no tool hook was registered for Codex,
  so nothing could ever produce an activity update (CHOO-1935).
- In-app release links resolve again: the sidebar update indicator and the
  Settings Update card pointed at `.../releases/tag/v<version>`, which is not a
  real tag (the app is tagged `switchdash-v<version>`), so the user hit a 404;
  the release-notes fetch had the same broken tag and now also authenticates
  with the gh CLI token so it can read the private release feed instead of
  silently returning nothing (#134).

#### Changed
- The per-agent Codex profile carries only model, reasoning effort and
  instructions. An agent that sets none of them no longer gets a profile at all
  (CHOO-1935).

### [0.18.2] - 2026-08-05

#### Fixed
- Client side of one-session-per-room enforcement: a session whose room the
  server takes away (or refuses with HTTP 409 because another session of the
  agent holds it) is now reported as roomless and is not reconnected under a
  room it no longer attends — the remote-session reconciler and sidecar no
  longer strand two sessions in one room (CHOO-1419, #109).

### [0.18.1] - 2026-08-05

#### Changed
- Bundled Switch agent runtime bumped to 0.1.5 (#127).

#### Fixed
- A session's Switch connection id is now derived deterministically, so a
  supervisor/sidecar restart no longer strands a remote session with a stale
  connection id (CHOO-1931, #125).

### [0.18.0] - 2026-08-04

#### Added
- Codex is now a supported agent provider. Add a Codex agent from the add-agent
  modal (with a dedicated Codex config), connected to Switch via a new Codex
  connector plugin registered in the marketplace, running locally or on a remote
  host. `CODEX_SANDBOX_MODE` / `CODEX_APPROVAL_POLICY` drive Codex's sandbox and
  approval (validated — an unknown value fails rather than silently widening the
  sandbox); a Codex agent defaults to a `codex.<repo>.<user>` identity; and
  switchdash registers the Switch MCP runtime for Codex itself via a per-agent
  Codex profile (CHOO-1436, #91, #79).

#### Fixed
- Codex session correctness: per-agent Switch credentials are written to disk for
  providers without repo-agents (so Codex sessions actually receive `SWITCH_*`);
  Codex room tracking follows `connect_to_room` mid-session; and Codex hook
  payloads post correctly (local Codex sessions had been posting empty bodies to
  a portless URL) (CHOO-1436, #79).

### [0.17.2] - 2026-08-04

#### Added
- Status-aware "update available" UX: the sidebar indicator shows the target
  version when an update is available, live percentage + transfer rate while
  downloading, a restart prompt once ready, and a warning tint on failure — and
  opens a panel (current → new version, the right action, a link to the GitHub
  release) instead of just jumping to Settings. User-triggered failures are
  toasted and the real error message is shown (CHOO-1434, #107).

#### Fixed
- The onboarding/home page can drag the window again: the empty home surface is
  now a drag region (action buttons opted out), so the window is no longer stuck
  when Home is the active view (CHOO-1430, #106).

### [0.17.1] - 2026-08-04

#### Added
- Linux x64 desktop builds are shipped again (AppImage, deb, rpm), with a stable
  desktop-entry name so the launcher, icon and pinning behave; INSTALL docs and
  release notes now cover Linux (CHOO-1905, #104).

#### Changed
- Release builds macOS and Linux artifacts in parallel (the GitHub Release is
  created in its own job), cutting ~5 minutes off a release (CHOO-1905, #104).

#### Fixed
- A dropped-events "gap" no longer wakes an agent and spends a turn: switchdash
  defers the warning onto the next event it was already going to surface, instead
  of injecting an addressed prompt (CHOO-1906, #105).

### [0.17.0] - 2026-08-04

#### Added
- In-app Switch room creation: create a room from switchdash (name, description,
  messaging app, agents, optional instructions) instead of the operator web app —
  the picker offers only running bridges and every created room is bridged
  (CHOO-1875, #103).
- Room-centric sidebar: a room tree listing rooms by membership and ownership
  (not only rooms with a live session), showing each room's members, managing
  membership (add/remove agents), starting a session in a room with the agent
  pre-chosen, and opening the room in its messaging app when the gateway supplies
  a deeplink; rooms sort and filter on their own properties (CHOO-1875, #103).

#### Fixed
- Sessions launched for a room now declare that room when their connection opens
  — both sidebar-started and auto-spawned (messaging-app-addressed) sessions
  appear under the correct room immediately instead of sitting under
  "Unassigned" until the agent calls `connect_to_room` (CHOO-1875, #103).

### [0.16.1] - 2026-08-03

#### Added
- Local GitHub-auth detection in Switch setup: a requirement row reporting `gh`
  missing / not logged in / missing `read:packages`, with an inline device-flow
  login that requests the scope. Sessions that can't fetch the runtime now toast
  the reason instead of starting silently broken (CHOO-1873, #102).

#### Fixed
- GitHub auth changes now take effect without restarting: the updater no longer
  leaves a boot-time token in `GH_TOKEN` (which shadowed the keyring for `gh`),
  and the scope check judges the active account only (`gh auth status --active`)
  rather than any known account (CHOO-1873, #102).
- A dialog's own terminal now receives keystrokes (the `gh auth` prompt was
  silenced inside the Agent Settings modal); agent usage — not just install — is
  gated on GitHub access; managed servers pinned to switch-core `0.11.0` (was
  `0.8.1`) (CHOO-1873, #102).

### [0.16.0] - 2026-08-03

#### Added
- Move switchdash and the remote sidecar onto the agent-bridge push stream: one
  shared connection per session claims its room server-side instead of scraping
  it from a hook, backed by the new `@sandbox-quantum/switch-agent-runtime`
  shared protocol client used by both switchdash and the connector plugin
  (CHOO-1857, #100).

#### Removed
- First-run welcome page and residual Emdash artwork; first run now lands on the
  existing home empty state with an "Add Switch agent" action (CHOO-1398, #96).

### [0.15.3] - 2026-07-31

#### Fixed
- Unbreak remote hosts with `IdentitiesOnly` or restricted agent forwarding: the
  `IdentitiesOnly` key-filter now extends ssh2's `BaseAgent` so it's no longer
  silently discarded (which had broken auth for keychain-only keys and failed
  connects under `ForwardAgent yes`), and a host that refuses agent forwarding
  now degrades to "everything except forwarding" — with a warning — instead of
  failing every command (#98).

### [0.15.2] - 2026-07-30

#### Added
- Logging & diagnostics foundation across main, renderer, and the remote
  sidecar: structured, session-scoped entries with a per-launch run id; file
  logging defaulting to `info` (was `warn`); PII redacted only on export (not in
  the local log) so local logs are debuggable while exported logs stay as safe
  as before; on-demand sidecar log capture folded into bug reports; and
  boot/exit + enumerated error markers to pinpoint crashes and launch failures
  (CHOO-1683, #83).

#### Fixed
- Stop a destroyed managed server's agents from polling forever: resetting a
  managed server now deletes its agents (the cascade lives behind the reset in
  the main process), room connections are keyed per session with
  `ON DELETE CASCADE` so orphaned entries are unrepresentable, and the boot
  sweep refuses to restore sessions for orphaned agents instead of hammering a
  dead endpoint (CHOO-1802 follow-up, #95).

### [0.15.1] - 2026-07-30

#### Fixed
- Surface non-image attachments to dash-managed sessions: switchdash's own
  session-notification builder now downloads and annotates any file type (not
  just images) and names failed downloads, so agents running under switchdash
  are actually told about files posted in a room (CHOO-1802, #94).

### [0.15.0] - 2026-07-29

#### Added
- Built-in chat: switchdash renders each room's default bridge conversation
  inline (Mattermost) with per-room embed resolution, a chromeless guest view,
  theming, and link/deeplink routing; Slack rooms get a deeplink and agent-only
  rooms a stated reason (CHOO-1674, #84).

#### Fixed
- Gate remote managed servers on host reachability, so an unreachable host no
  longer shows a stale green "Running" card or a spinning sign-in — the server
  page shows a "host unreachable" state and disables actions until it recovers
  (CHOO-1780, #85).

### [0.14.3] - 2026-07-28

#### Fixed
- Model remote-host reachability as a first-class per-host state machine, so
  switchdash stops the unbounded reconnect/reconcile retries against an
  unreachable host (one bounded backoff probe per host), persists the state
  across restarts, and surfaces a clear "host unreachable — work paused" panel
  with a global Retry instead of raw SSH errors (CHOO-1682, #82).

### [0.14.2] - 2026-07-28

#### Fixed
- Key the remote session reconciler per-sidecar instead of per-location, so
  sessions from multiple agents sharing one working directory all get adopted
  into the sidebar (#81).

### [0.14.1] - 2026-07-27

#### Fixed
- Reap sidecars orphaned when their tmux session name changes across upgrades,
  instead of leaving duplicates running for the same agent directory (CHOO-1425).

### [0.14.0] - 2026-07-27

#### Added
- Remote sidecar now persists durable state and versioning, so running sessions
  survive sidecar restarts, upgrades, and token rotation (CHOO-1425).

#### Fixed
- Client no longer deletes healthy sessions when it briefly can't reach the
  sidecar; fixes cross-build kill loops and deaf clients after a sidecar restart
  (CHOO-1425).

### [0.13.1] - 2026-07-26

#### Fixed
- Fix slow boot caused by the agent-storage migration, and restore sessions that
  vanished after the 0.13.0 upgrade (CHOO-1440 follow-up).

### [0.13.0] - 2026-07-26

#### Changed
- Removed the subagent concept — agents are now flat and repository-defined;
  existing subagents migrate forward automatically on first launch (CHOO-1440).

#### Fixed
- Honor the bypass-permissions toggle for remote agents and clear a stale
  session guard (CHOO-1664).
- Skip the connection-status probe for a stopped managed server (CHOO-1657).

### [0.12.0] - 2026-07-24

#### Added
- Configure per-agent addressing policy from the app and gateway (CHOO-1585).

#### Fixed
- Data-entry modals no longer dismiss on outside-click, so in-progress input
  isn't lost (CHOO-1659).

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

---

## agent-runtime

The Switch protocol client and MCP runtime
(`dash/packages/switch-agent-runtime/`). Version lives in its `package.json`.

### [Unreleased]

### [0.1.6] - 2026-08-09

#### Added
- Declares its `agent-protocol` range, artifact name and release version on the
  event stream it already opens, so switch-core can record what is connecting
  (CHOO-1865).
- Logs the server's declaration from the `connection_state` frame, so which
  versions were actually talking to each other is answerable from a bug report
  rather than a guess (CHOO-1865).

#### Changed
- Reports a failing event stream on a curve — first failure, then powers of
  two, plus a line when it recovers — instead of once per reconnect. The
  reconnect itself is unchanged; only the reporting is rationed, so a stack
  that is simply stopped costs a handful of log lines rather than one per
  session per 30s, forever (CHOO-1780).

### [0.1.5]

Releases before this changelog existed are in the git log. They are not
reconstructed here: an invented history reads exactly like a real one.

---

## sidecar

The remote runtime switchdash deploys to an agent host. Versioned in
`dash/apps/switchdash-desktop/src/sidecar/sidecar-version.ts` and deployed by
switchdash rather than published on its own.

### [1.8.0]

#### Added
- Declares its `sidecar-control` range in the ready file switchdash already
  reads (CHOO-1865).

#### Changed
- Three-part semver: `1.7` becomes `1.8.0`. **The major stays at 1** — every
  switchdash already in the field judges compatibility on the major and parses
  two parts, so `1.7` and `1.8.0` order correctly and neither side
  replaces the other. `2.0.0` would have every existing install treat this
  sidecar as incompatible and replace it while a newer install replaces it back
  (CHOO-1937, CHOO-1865).
- The version no longer carries compatibility. It says which release is running;
  what the sidecar can speak is the `sidecar-control` range it now declares in
  its ready file (CHOO-1865).
- The version is declared in `artifacts.yaml` and generated into the code.
  Nothing else declares it — the sidecar is deployed by switchdash rather than
  published, so it has no packaging file of its own.

### [1.7]

Earlier versions used a two-part `x.y` scheme in which the major *was* the
compatibility signal. History for those is in the git log.

---

## switch-connector (Claude Code)

`connectors/claude-code-plugin/`. Version lives in
`.claude-plugin/plugin.json`.

### [Unreleased]

#### Changed
- Document `read_context`'s new response shape — `truncated` /
  `oldest_timestamp` and the per-entry `kind` — and tell the agent not to
  conclude anything from a truncated read (CHOO-2034).

### [0.7.9] - 2026-08-09

#### Changed
- Bump the pinned `@sandbox-quantum/switch-agent-runtime` to `0.1.6`, so sessions
  pick up its rationed stream-failure reporting and version declaration
  (CHOO-1780, CHOO-1865). The plugin version bumps with the pin so installs
  re-download it.

### [0.7.8]

Releases before this changelog existed are in the git log and in the plugin
manifest history.

---

## switch-connector-codex

`connectors/codex-plugin/`. Version lives in `.codex-plugin/plugin.json`.

### [Unreleased]

#### Changed
- Skill updated for `read_context`'s new response shape — `truncated` /
  `oldest_timestamp` and the per-entry `kind` (CHOO-2034).

### [0.2.1] - 2026-08-09

#### Changed
- Bump the pinned `@sandbox-quantum/switch-agent-runtime` to `0.1.6` (CHOO-1780,
  CHOO-1865). The plugin version bumps with the pin so installs re-download it.

### [0.2.0]

Releases before this changelog existed are in the git log and in the plugin
manifest history.

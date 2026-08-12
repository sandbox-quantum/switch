# Changelog

All notable changes to Switch are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Switch ships several independently-versioned artifacts, each with its own
section below. Every artifact carries three-part semver (`MAJOR.MINOR.PATCH`)
and a changelog, without exception.

A version says **where an artifact is** — which release you are running. It says
nothing about what that release can talk to. Compatibility is carried separately
by the contract revisions in [`artifacts.yaml`](artifacts.yaml), which move
independently: a release that changes nothing on the wire bumps its version and
leaves its contracts alone.

- **switch-core** — the backend service (`core/`). Released by tagging
  `switch-v<version>`; the version lives in `core/pyproject.toml`. See
  [RELEASING.md](RELEASING.md).
- **switch-console** — the desktop app (`dash/`). Released by tagging
  `switch-console-v<version>`; the version lives in
  `dash/apps/switch-console-desktop/package.json`.
- **agent-runtime** — the Switch protocol client and MCP runtime
  (`dash/packages/switch-agent-runtime/`), published to a package registry.
- **sidecar** — the remote runtime Switch Console deploys to an agent host
  (`dash/apps/switch-console-desktop/src/sidecar/`). Versioned in
  `sidecar-version.ts` and deployed by Switch Console, not published separately.
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

#### Added
- Telegram collaboration bridge, at parity with Slack, Mattermost and Discord
  (CHOO-1686). A single bot backs every agent — Telegram has no per-message
  identity override — so an agent is named at the head of its messages. Inbound
  arrives by long polling, so no public ingress is needed. Chats cannot be
  created by a bot, so `create_channel` fails with an actionable error and rooms
  are provisioned when the bot is added to a chat. Multi-file messages post as a
  single album, and outbound Markdown is converted to Telegram's HTML subset
  rather than its stricter MarkdownV2. See `docs/bridges/TELEGRAM_SETUP.md`.
- One-click install links for a bridge, offered on the operator dashboard and
  built by the adapter (`install_links`); empty for platforms installed through
  their own admin UI. Telegram supplies one, for groups: pick the group, confirm,
  done. It asks for **no permissions at all** — a bot posts and deletes its own
  messages in a group as an ordinary member — so adding the bot no longer means
  promoting it by hand. Setting a Telegram bridge up is now one BotFather setting
  (Group Privacy off, once per bot, before the bot is added anywhere) and then a
  link per group. Channels are added from their Administrators screen, and get no
  link: that would need Telegram's `admin=` parameter, which not every client
  implements, and the ones that do not open a chat with the bot instead — a link
  that works for some people is worse than a documented step that works for all
  of them. The dashboard's **Add to a chat** dialog says so: alongside the links,
  a bridge can supply an `install_note` naming the chats no link reaches and the
  route they take instead, so a missing button is never all the operator sees.
- A bridged chat is told what the bridge can see in it, and told again whenever
  that changes — so promoting the bot confirms itself and retracts the earlier
  warning, and a demotion does not pass unmentioned. Visibility is settled per
  chat rather than inferred from the bot's global privacy setting, which is what
  made an administrator bot report a fault it did not have. A chat the bridge can
  only see mentions in — no admin, privacy mode on — is a supported way to run
  and is disclosed as one: a notice in the chat, and a warning naming each such
  chat at startup. Where the answer rests on the global setting rather than on
  admin status it is taken on trust and logged as such: Telegram reads that
  setting when the bot joins and no API call reports which value a given chat
  got, so a bot that predates the change is still filtered and only a re-add or a
  promotion fixes it.

#### Fixed
- Bridge row action icons line up down the column again. A row carries one icon
  or two depending on whether its platform offers an install link, and the pair
  was not anchored to the same edge as the single, so the delete buttons sat at
  different positions on different rows.
- Telegram links are built from the username the Bot API reports rather than the
  one in the bridge's config. A configured name that is not the bot's resolves to
  whichever account does own it, so every link opened a chat with a stranger —
  and the mismatch was already detected and then ignored, with the wrong value
  used anyway. The bot's own name wins and the correction is logged.
- The "add to a Telegram group" link is withheld from a bot BotFather has barred
  from groups. Telegram answers such a link by opening a chat with the bot, which
  from the outside is indistinguishable from a link that does nothing; the reason
  is logged with the setting to change instead.
- The group install link no longer asks to be an administrator, which made it
  unusable for the groups most people have. Telegram builds that picker from
  groups the person already administers, excluding basic groups — promoting a
  bot in one converts it to a supergroup — so for anyone whose groups are all
  basic it offered nothing to pick and Telegram opened a chat with the bot
  instead, reading as a link that did nothing. Admin was only ever bought for
  the privacy-mode exemption, and turning Group Privacy off in BotFather buys
  the same thing once per bot rather than once per group. Promotion remains
  documented as the repair for a single chat that was added before that setting
  was changed, and the bot asks for it in the chat when it applies.
- A room follows its Telegram chat when the chat is reissued a new id, which
  Telegram does silently whenever a group becomes a supergroup. The room was
  left bound to the old id, so nothing anyone typed reached Switch again while
  sends kept working — Telegram forwards those — leaving a bridge that looked
  alive and was deaf. Adapters now report the change (`CollaborationAdapter`
  gains `set_channel_migration_handler`) and the room is re-pointed, or the
  refusal is logged with the id to re-point it at by hand.
- `read_context`'s own documentation no longer tells agents to page by passing
  `oldest_timestamp` back as `before`. The first is epoch milliseconds and the
  second is parsed as ISO-8601, so following it raised instead of paging.

### [0.13.1] - 2026-08-11

#### Fixed
- The first message bridged from a channel member is no longer dropped when that
  member's puppet had joined the room in an earlier run (#199). `wait_joined`
  only resolved on a join it observed live, so a puppet already in the room from
  a previous process never satisfied the wait and the send was skipped. It now
  checks current membership up front and returns immediately when the puppet is
  already joined.

### [0.13.0] - 2026-08-10

#### Added
- The Discord collaboration bridge registers native slash commands (`/…`) that
  map onto the same in-room command dispatcher as typed `!` commands, giving
  Discord the interaction surface Slack already had. One
  implementation, two entry points: a slash invocation is reassembled into the
  same positional `@token` string the `!` handlers already parse. Argument shapes
  come from a new shared `Command.args_spec` in the command registry — validated
  up front, so a malformed spec names the offending command and fails in CI
  rather than taking the bridge down at startup — and registration is
  guild-scoped. Requires the `applications.commands` OAuth2 scope: a bot invited
  without it runs but answers only `!`-prefixed commands.

#### Changed
- **Breaking (agent-facing):** `read_context` returns
  `{threads, truncated, oldest_timestamp}` rather than a bare list of thread
  groups, and every entry carries a `kind`. Both connector skills
  are updated.

#### Fixed
- `read_context` seeks to a `before` window via the homeserver's
  `timestamp_to_event` rather than paging over everything newer to reach it,
  and falls back to a scan with its own page budget when the server cannot
  answer. Previously the walk shared the read budget, so a window
  deep in a busy room returned empty however small a `limit` was asked for.
- `read_context` now pages the homeserver instead of reading a single
  `/messages` page, so agents see the whole room rather than the last slice of
  it. `before` pages backwards into older history rather than
  filtering one page, and the response reports `truncated` and
  `oldest_timestamp` so a shortened read can never pass as a complete one. Room
  joins now appear in the timeline as `kind: "room_join"` entries. The
  `GET /agents/{id}/rooms/{id}/history` endpoint, which read the result as a
  flat message list when it has always been thread groups and so returned no
  events at all, is fixed with it.
- Discord no longer silently drops outbound messages over its 2,000-character
  limit. Both send paths caught the 400, logged it, and returned
  `None`, so the message never reached the channel; text is now split on line (or
  word) boundaries, reopening a fenced code block across the break so a torn fence
  doesn't render the remainder as plain text. `help`, at 2,063 characters, had
  been failing to post as `!help` for as long as the command list has been this
  long.
- The "no agents in this channel" notice now gives each platform its own invite
  syntax instead of one Slack-shaped `/invite-agent @agent-name` line.
  Discord names the argument as a field (`/invite-agent agent:agent-name`), and
  Mattermost and Teams — which register no slash commands — no longer point at a
  command that does not exist.
- Outbound `@name` mentions on the Slack bridge resolve to real `<@U…>` mentions
  from the `external_users` table, primed at startup and topped up as puppets are
  created. The name→id map was previously filled only as a side effect
  of resolving an inbound sender, so it was empty after every restart and whether
  a person was actually notified depended on whether they happened to have posted
  since — otherwise the mention went out as plain text. Matching is now
  case-insensitive, and app/bot rows, whose `B…` id cannot form a valid user
  mention, are skipped.
- The first message from a channel member the room does not yet know is no longer
  dropped. Provisioning the sender's puppet only *invited* it; the
  join landed asynchronously from the puppet's own sync loop while the triggering
  message was relayed immediately, and a send issued before the join is rejected
  by the homeserver — a failure that was then swallowed.
  `_ensure_user_in_matrix_room` now blocks on a new `ClientBase.wait_joined()`
  (bounded by a 30s timeout) after inviting, and returns `None` rather than
  relaying into a room the sender is not in; inbound relay failures are logged as
  errors instead of silently skipped. This hit app/bot senders every time — they
  key on `bot_id` and are never pre-warmed by a join.

### [0.12.4] - 2026-08-09

#### Added
- Cross-artifact version compatibility, part 1 — every artifact declares what it
  is and what it speaks. `artifacts.yaml` is the one authored
  registry of contract revisions; per-language modules are generated from it and
  CI fails if they are stale or hand-edited. switch-core reads its own release
  version, discloses it and its ranges on authenticated surfaces only (the
  `connection_state` frame, the 409 refusal body, the gateway session response,
  and an authenticated credential-scoped `GET /version`), and records what each
  client declared. **Nothing acts on the declarations yet** — a client that
  declares nothing connects exactly as before.
- The authentication surface is now **frozen**: never versioned, permanently
  backward-compatible, and excluded from `gateway-api`, so a client can always
  authenticate far enough to be told what is wrong.

#### Fixed
- The agent-protocol check no longer defaults a silent client to the server's own
  version. It defaulted to agreement, and since no shipped client ever sent
  `?protocol=`, the check had never once fired. Absent now records as unknown —
  and still connects.
- A protocol refusal names which side is behind. It always said "update the
  Switch agent runtime", which for a client ahead of the server sent the user to
  downgrade the side that was already right.
- The compatibility check is a range overlap rather than exact equality. The two
  numbers are equal today, so nothing changes yet.
- `SWITCH_VERSION` is required by the standalone compose instead of defaulting to
  `latest`, which silently floated the whole stack to whatever had most recently
  been published.
- The Helm chart no longer claims a version it has not been at for months. The
  real one is stamped at package time; the file now says `0.0.0-dev`.
- Refreshed the stale switch-core version in `uv.lock`, which the release
  procedure never re-locked.

#### Security
- Bump core Python dependencies (cryptography, aiohttp, starlette, mcp,
  pydantic-settings, joserfc, python-multipart) to current releases.

### [0.12.3] - 2026-08-07

#### Added
- Collaboration bridges expose a workspace/home deeplink so a client can open
  the messaging app's workspace from the gateway.

#### Security
- Admin-gate every collaboration-bridge write: updating and deleting a bridge
  were ungated, so any authenticated user could toggle agent greetings or delete
  a bridge (which cascades into deleting every room on it) — now admin-only
.

### [0.12.2] - 2026-08-07

#### Changed
- The collaboration-bridge runtime indicator now follows the agent: it moves to
  the foot of the conversation and into the thread the triggering message belongs
  to (instead of staying where the turn opened), and the agent — not the bridge
  watching traffic — decides when it moves (new `anchor_event_id` on the
  runtime-state protocol), so it no longer jumps below a human's message before
  the agent has been handed it.

#### Fixed
- Runtime-indicator robustness: serialise refresh vs repositioning, and don't
  strand the indicator when a turn ends mid-move.
- Discord: delete an agent's messages through the same webhook that posted them
.
- Agent bridge: clamp a resumed cursor to the in-memory buffer head on heartbeat,
  so a connection no longer silently skips events up to a stale cursor after a
  switch-core restart.
- Agent bridge: write the legacy room-binding row only for connectionless
  (MCP-transport) callers, so a connection-backed `connect_to_room` no longer
  leaves an unread, never-cleaned binding row behind.

### [0.12.1] - 2026-08-05

#### Security
- Retire the unauthenticated `/collab` bridge-admin API (#120).
- Re-scan and bump dependency CVEs (#123).
- Local stacks are secure by default: published ports bind to `127.0.0.1`
  (`SWITCH_BIND_ADDR=0.0.0.0` is now an explicit opt-in for network exposure),
  `.env.example` ships every secret blank, and `just init-env` generates strong
  random credentials — no more `admin/admin` reachable on `0.0.0.0` (#122).

#### Fixed
- Enforce one session of an agent per room: `connect_to_room` now refuses with
  HTTP 409 when another session of the same agent already holds the room, and a
  takeover evicts and reports the displaced session — instead of silently
  stranding a session in a room whose events go elsewhere (#109).

### [0.12.0] - 2026-08-04

#### Added
- Codex registered as its own gateway known-agent (connector_type "Codex") with
  a Codex-flavored "no live session" command, instead of falling back to Claude's
  builder (#91).
- `cancel_task` agent operation — a requester can abandon a task it delegated,
  recording the reason and notifying the room; served on both the MCP server and
  the HTTP front door (#79).

#### Changed
- `list_participants` now includes each participant's `status` and `alias` (both
  null when unset) (#79).

### [0.11.0] - 2026-08-03

#### Added
- Agent bridge push transport (design + Stages A & B): a sequenced,
  non-destructive per-agent event buffer plus a push connection with SSE
  delivery (`GET /agents/{id}/events`, one `POST /connection/beat` for liveness
  and cursor), replacing long-poll's destroy-on-read queue; presence becomes a
  union of heartbeat and live connection, and connection status is derived from
  what a connection observes rather than a declared `connection_model`. Backward
  compatible — polling keeps working and old/new state are read together
 (#100).

### [0.10.0] - 2026-07-30

#### Added
- Full attachment support — any file type and multiple files per message, in both
  directions across Slack, Mattermost, and Discord. Non-image files are relayed
  instead of silently dropped, multi-file messages are coalesced into a single
  platform post, and the 20MB size cap is now enforced inbound too; oversize or
  failed files are disclosed in the room rather than dropped (#93).

### [0.9.0] - 2026-07-29

#### Added
- Every room now gets a collaboration bridge by default: a bridge can be marked
  default and is used when a room names none, with `internal_only` as the
  explicit opt-out; a bundled Mattermost is provisioned across compose and Helm
 (#84).

#### Changed
- Restyle the Switch Gateway web UI onto the Hoot design system — new light/dark
  theme, icon-rail shell, and consistent formatting conventions; nav
  destinations unchanged (#87).

### [0.8.1] - 2026-07-24

#### Fixed
- Prevent a duplicate Switch room from being created when provisioning a Slack
  channel (race on bridge channel provisioning).

### [0.8.0] - 2026-07-24

#### Added
- Scoped agent-addressing permissions — control which agents and rooms an agent
  may address, enforced server-side.

### [0.7.0] - 2026-07-24

#### Added
- Microsoft Teams collaboration bridge — rooms can bridge to Teams channels,
  joining Slack, Mattermost, and Discord as supported platforms.
- Discord bridge polish: deeplink redirect, room icon, and outbound image relay
.

#### Changed
- Relicensed to Apache-2.0 + Commons Clause, with a CLA gate for contributions
.

#### Fixed
- Detach dependent rooms before removing a bridge, so bridge removal no longer
  leaves rooms in a broken state (#35).

### [0.6.0] - 2026-07-20

#### Added
- Discord collaboration bridge — rooms can bridge to Discord channels, joining
  Slack and Mattermost as supported platforms.

### [0.5.0] - 2026-07-20

#### Added
- New `POST /gateway/auth/refresh` endpoint: re-mints the `switch_auth` cookie
  from a still-valid session, enabling clients (switchdash) to silently renew
  sessions before the 24h expiry.
- Standalone compose: bind address and host ports are configurable via env
  vars (`SWITCH_BIND_ADDR`, `POSTGRES_HOST_PORT`, `API_HOST_PORT`, …) —
  consumed by switchdash's local-server mode.

### [0.4.0] - 2026-07-19

#### Added
- The standalone Docker Compose file is published to GHCR as a versioned OCI
  artifact (`standalone-compose:<version>`, plus `latest`) on every release,
  pinned to the same version as the images and chart — switchdash's
  local-server mode consumes it.

### [0.3.0] - 2026-07-17

#### Added
- Agents can send images from rooms, relayed out through the Slack and
  Mattermost collaboration bridges.

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
 is a configuration flip.

- Initial internal version. History predating the changelog lives in the git log.

---

## switch-console

### [Unreleased]

#### Added
- Telegram brand icon, platform label and setup-guide link, so Telegram-bridged
  rooms show the "open channel" button and the attach form links the right guide
  (CHOO-1686). Telegram bot tokens are also redacted from the diagnostic logs.

#### Fixed
- Opening a room from a deeplink expands the sidebar groups hiding it
  (CHOO-1686). The reveal ran once, before the room a session belongs to had
  loaded, and never again — so the view routed correctly to a row that stayed
  collapsed. Affects any bridge, not only Telegram.
- The unread tally injected into a session no longer claims to count "since
  your last read_context". Nothing here can observe a session reading, so the
  tally is cleared per delivered line; it now says so, rather than inviting an
  agent to read its absence as proof it is caught up.

### [0.22.0] - 2026-08-12

#### Added
- Linux **arm64** desktop artifacts are now built and published alongside x64 —
  AppImage, deb, and rpm (#202).
- **Windows x64** releases are now built and published (unsigned) (CHOO-1468).

#### Changed
- The Codex session runtime version is now derived from the artifact registry
  rather than a hand-maintained `SWITCH_AGENT_RUNTIME_VERSION` constant; the
  constant and its parity test are removed (#198).

### [0.21.0] - 2026-08-11

#### Changed
- The private-repo machinery is gone now that the repository and its packages are
  public (CHOO-2023). The updater no longer gates on a `gh` token or a private
  feed, so every user receives updates and the `auth-required` state is removed;
  managed-server image pulls drop `docker login ghcr.io` and the remote
  `.ghcr-token` forwarding; remote-host setup drops its interactive `gh:auth`
  step (a persisted plan still carrying a `gh-auth` step drops it on read); agent
  onboarding no longer withholds every agent type when `gh` cannot reach a
  registry; and Switch no longer installs, probes, or forwards credentials to
  `gh` on a remote host at all.
- Local-server mode now bundles and pulls **switch-core `0.13.1`** (was
  `0.13.0`): the bundle pin / `COMPATIBLE_SWITCH_VERSION` is raised to the
  current core release.
- Codex sessions launched by Switch Console now run
  `@sandboxaq/switch-agent-runtime@0.3.0` (`SWITCH_AGENT_RUNTIME_VERSION`, was
  `0.1.6`), matching the runtime's move to public npmjs.

### [0.20.0] - 2026-08-10

#### Added
- The bundled Mattermost row on the server page now has a "Sign-in details"
  disclosure — server URL, username and password, each with copy-to-clipboard —
  so signing in to a managed deployment's bundled chat no longer means finding the
  generated `.env` on disk. The password is masked until revealed, and can be
  copied without revealing it. Values are read from what the deployment actually
  runs (the host port Switch Console chose and the password from the encrypted
  app-secrets store), fetched only on expand so the secret does not cross into the
  renderer for everyone who opens the page. When a value cannot be read the card
  names which one is missing rather than showing a placeholder that could be
  mistaken for a real password.
- A per-host cap on how many remote terminals stay attached at once
  (`remote.maxAttachedSessionsPerHost`, default 4), exposed as an Interface
  setting. Beyond the cap the least-recently-viewed session on that host is
  detached — its agent keeps running in its tmux pane and still reports status,
  so only the on-screen terminal goes away.

#### Changed
- The app is now called **Switch Console** (formerly "switchdash") everywhere a
  user reads it: the window and menus, the home-screen wordmark, the server/agent
  dialogs, the auto-session / auto-approve / sidecar settings, the version-drift
  warning, the command palette, remote-host setup, and the "Open in Switch
  Console" deeplink the bridges post into Slack and Mattermost. Storage and OS
  identity deliberately keep the `switchdash` name (app id, userData directory,
  `switchdash://` scheme, npm packages, `SWITCHDASH_*` env vars) so an existing
  install updates in place rather than being stranded. The source tree moved from
  `dash/` to `console/` and the release tag prefix is now `switch-console-v*`
.
- Local-server mode now bundles and pulls **switch-core `0.13.0`** (was
  `0.12.3`): the app's bundle pin / `COMPATIBLE_SWITCH_VERSION` is raised so a
  managed local stack runs the current core release.
- Bump the Codex session runtime pin (`SWITCH_AGENT_RUNTIME_VERSION`) to `0.1.6`
  so Switch Console-launched Codex sessions run the published runtime.
- Remote terminals now attach on demand instead of on provision. Opening a
  session on a remote host is what brings up its terminal, driven by which session
  is in focus (debounced so arrowing through the sidebar doesn't ask a slow host
  for a terminal at every step), with least-recently-viewed eviction under the
  per-host cap. Previously every known session on a host wanted a terminal the
  moment it was provisioned — on one host that was 51 terminals opened at launch.
  The agent runs on its VM regardless; sidebar status, room badges and deep links
  are unaffected because they come from hook events and the session poll, not from
  a PTY.
- Search no longer returns filesystem results, and the per-location file indexer
  behind them is removed. File hits were appended after the relevance
  cut and the 30-item slice, so up to 20 irrelevant rows survived regardless of
  ranking; the row navigated to the session, not a file. Removing search's only
  reader of the index also drops the crawl it ran on every location and the
  debounced re-crawl on every file-watch event; an existing database sheds the
  now-unused index tables.

#### Fixed
- Clicking a session on a busy remote host no longer freezes, and opening a remote
  session no longer lands on an empty pane or a "Terminal not attached" message
  that Attach could not clear. On one host, 51 sessions sharing a single SSH
  transport re-attached in the same instant whenever the transport recovered,
  re-saturating the tunnel on a ~16-minute wedge cycle; separately, a runtime
  reaching the attachment path at provision time knew neither its session nor that
  it was attachable, so every attach quietly did nothing. Remote attachment is now
  serialised per host, sidecar event relays are shared one-per-sidecar instead of
  one-per-session, provisioned sessions are made attachable, and a failed attach
  throws a real error instead of leaving a silent empty pane. A detached remote
  session now shows that its agent is still running rather than an indefinite
  spinner.
- The sidebar's staleness banner no longer warns about servers you are not looking
  at. Room state was loaded and reported across every server at once while the
  sidebar only ever shows one, so a healthy selected server could be buried under
  warnings about unrelated ones. Room state is now scoped to the server on screen
  (cross-server search still loads every server, but only when opened).
- The sidebar no longer presents unknown room state as fact. A server that could
  not be read kept its last-known rooms with no hint they were stale; a room whose
  name had not loaded showed a short id styled like a name; an agent whose
  membership lookup failed vanished from its rooms. These are now disclosed
  distinctly ("asked and failed" vs "not connected, never asked"), an unloaded name
  renders as provisional, and a retry is offered. A room's member count, list and
  invite picker are now one read so they can't disagree.
- A server you are not signed into now prompts you to sign in instead of reporting
  "couldn't reach" it with a Retry that cannot work. Signed-out, dormant, and
  genuinely-unreachable are now distinguished, and only a real failure offers
  Retry. Agent names are also read from the local database instead of fetched
  per-row from the gateway, which could silently render a plausible wrong name on
  failure.
- Selecting a session, agent or room from outside the sidebar (keyboard, command
  palette, notifications, menu, modals, deep links, or the view restored at
  startup) now scrolls the highlighted row into view, expanding whatever group
  hides it. Previously only the deeplink handler scrolled, and only for session
  rows. It scrolls only when the row is off-screen, never while dragging, and keys
  on the selection so a reorder can't yank the viewport.
- The per-room channel icon, the room pane's "Open in …" button and the Slack
  bridge card's Open button now open bridged channels even without the native
  desktop app installed. They handed the OS a native
  `mattermost://` / `slack://` deeplink, which nothing answers when no desktop app
  is registered, so the click did nothing. Links are now translated to the
  channel's web address, which works either way. Opens now also report a failure
  to the person who clicked instead of discarding it.
- The bundled chat's sign-in prompt no longer offers to sign in "on your phone".
  The managed stack publishes onto `127.0.0.1` and the URL shown is a `localhost`
  one, which no other device can reach, so it now says "on this computer"
.
- The server page no longer sits on _"Checking sign-in options…"_ forever after
  connectivity returns. Which login methods a server offers was read once when
  the page mounted, and a read that failed was never retried, so a blip left the
  sign-in form unrendered until you navigated away or restarted. It now recovers
  on the signals connection status already used — the page's Refresh button,
  returning to the app window, and a remote host becoming reachable again. The
  Refresh button in particular re-checked only the connection status, so the one
  control a user would reach for did nothing visible.
- A server whose gateway cannot be reached now says so in one line and retries
  on its own, instead of stacking three surfaces that each described the same
  failure differently: a red banner quoting a raw internal error
  (`Error invoking remote method 'switchServers.getAuthConfig': …`), a
  "Not signed in" row, and a sign-in panel that claimed to be checking options
  it would never receive. There is nothing to sign into while the gateway is
  down, so the sign-in form no longer appears at all. The underlying error goes
  to the console.
- The sidebar no longer offers "Sign in" on a server it cannot reach, which was
  an action that could not work. Unreachable is now modelled apart from
  signed-out, so the rooms list also stops reporting an unreachable server as
  merely needing sign-in. A server whose data is unavailable shows a red dot
  rather than amber, for both causes: neither is a transitional state
.
- A directory that already holds agents for one Switch server can now onboard its
  agents to another. "Already onboarded" was judged per directory rather than per
  server, so every candidate was filtered out as a duplicate and the modal offered
  an empty list — of agents that existed, on a server that did not have them
.
- The sidebar no longer draws a directory's agents under a server they do not
  belong to. A directory resolved to a single server — whichever of its agents was
  returned first — and then every agent in it was rendered under that one, so
  onboarding a single agent to a second server appeared to drag the rest across
  with it. Nothing had been onboarded; each agent is now drawn under its own
  server, and a shared directory shows under all of them.
- Onboarding an agent whose credentials belong to **another** Switch server no
  longer overwrites those credentials. The import path looked the existing
  identity up on the target server, did not find it, and fell back to minting a
  fresh one — writing it back over the same `.switch/agents/<name>.json` and
  silently breaking the agent the other server was still running. It now refuses
  and names the server the identity belongs to. Such agents are listed in the
  Add Agent modal but not selectable, with the reason shown; a plain definition
  carrying no Switch identity is still adopted as before.
- The Add Agent modal no longer offers a permanently disabled button over a list
  it will not submit. A directory carrying another server's leftover
  `.claude/settings.local.json` took the detected-agent branch, verified that
  foreign agent against the current server, failed, and disabled the only button
  on screen — with the onboardable agents listed above it. The onboard action now
  takes precedence, and a detected agent belonging to another server says so
.
- The Add Agent modal no longer shows the create form, or the existing-agents
  list, before an agent type is picked. Both depend on the type — it decides
  which agents can be brought in and how a new one runs — so the form asked for a
  name, a description and a config, then ended at a button that could not be
  pressed. Everything below the directory now waits for the type, and the modal
  asks for it instead.

### [0.19.3] - 2026-08-09

#### Added
- Declares its `sidecar-control` range in the sidecar's ready file, and reads
  back whatever a running sidecar declares. A sidecar that declares nothing
  records as unknown, never as agreement.

#### Fixed
- A gateway call to a managed server whose stack is **stopped** now fails with
  the lifecycle state, naming the server, instead of timing out and reporting
  `Could not reach http://localhost:<port>` — a local address that was never
  the problem. It is logged as the modeled state it is rather than as an RPC
  error, and the proactive session renewal no longer warns about the same
  absence a second time.
- A managed server whose deployed switch-core version **cannot be read** is now
  surfaced as such, in the banner and the sidebar. It previously reported "no
  drift" — the identical result a healthy, in-step stack gives — so a failed
  probe rendered as a green server and the user was told nothing.
- Starting a stack whose version cannot be compared to this build's pin now says
  so loudly. It passed in complete silence, in the same branch as a clean match,
  while carrying the same risk as a downgrade.
- CI verifies the bundled standalone compose is in step with the repo's copy.
  Nothing checked before — the two could drift with only a comment asking
  nicely, which is how the sync script once silently stopped running
.
- The host-unreachable panel now also shows on a location that mounted while its
  host was up, not only one that never mounted. Such a location stayed `ready`
  and kept every control live over a dead SSH transport — the sidebar showed the
  trouble icon, the main pane did not; it restores itself when the host returns
.

#### Security
- Bump bundled dependencies for two advisories — DOMPurify `SAFE_FOR_TEMPLATES`
  bypass in `RETURN_DOM` mode (GHSA-crv5-9vww-q3g8), and brace-expansion
  denial-of-service via exponential expansion (GHSA-3jxr-9vmj-r5cp).

### [0.19.2] - 2026-08-07

#### Added
- Connect a messaging app (Slack/Mattermost/Discord/Teams) to a server from
  within switchdash — per-platform setup-guide links and a Teams icon; open a
  messaging app's workspace from the server page.

#### Changed
- New macOS app icon (max.tam's mark); a dark mark for non-release (canary/dev)
  channels; dropped the leftover emdash DMG art/wordmark.
- Bump the bundled switch-core for local managed servers to `0.12.3`
  (`COMPATIBLE_SWITCH_VERSION`).

#### Fixed
- Restore sidebar drag-to-reorder for agents and rooms.
- Set `GATEWAY_PUBLIC_URL` so "Open in SwitchDash" links work; redact the
  credential key names configs actually use; vendor the real Teams logo
.

### [0.19.1] - 2026-08-07

#### Changed
- switchdash sessions report their latest-message anchor so the
  collaboration-bridge runtime indicator can follow the agent to the foot of the
  conversation.
- Bump the bundled switch-core for local managed servers to `0.12.2`
  (`COMPATIBLE_SWITCH_VERSION`), so a fresh local stack pulls the latest
  switch-core and existing stacks flag the drift for a one-click update.

#### Fixed
- Fix an import cycle that could leave the view registry half-built — a renderer
  crash ("Cannot access 'remoteHostsView' before initialization"), deterministic
  in CI and load-order-dependent locally.

### [0.19.0] - 2026-08-07

#### Added
- Remote-host onboarding rewritten as per-host pages with a staged,
  one-click-per-prerequisite setup: install each prerequisite individually with
  live progress, inline GitHub CLI sign-in, and agent creation gated on host
  readiness.
- Surface and act on available updates on a remote host — detect Codex/CLI
  updates remotely, re-check one dependency at a time, and show which version an
  update brings, flagged in the sidebar.
- Discover and onboard already-configured agents on a shared remote host
 (#130).
- Detect switch-core drift on a managed stack and update it; flag drift on the
  sidebar server rows.
- Command palette now searches across your agents and rooms — not just
  navigation — labelling what each result is, jumping into another server's
  scope, and adding an "Add Switch Server" command (#140).

#### Changed
- Split an agent type into separate CLI and connector rows; drop the
  servers-sidebar text actions.
- Pin switch-core `0.12.1` for the managed stack.

#### Fixed
- Remote-host setup hardening: a host without the GitHub CLI no longer reports
  itself Ready; the readiness probe no longer races itself; host vs agent-type
  readiness are judged separately; stale plans rebuild; a failed update is no
  longer treated as a broken dependency; only CLI updates switchdash can
  actually perform are offered; agent creation refuses an unchecked type; the
  agent type clears when the run location changes; remote-host pages scroll; and
  a remote install no longer hangs on an unanswerable prompt.
- Dialogs opt out of the window drag region; the alert action no longer overlaps
  its text.
- Migration safety: register migration 0046 in the drizzle journal, fail loud
  when a migration isn't registered, and assert the migration runner's timestamp
  precondition.
- Command-palette matching: a hyphenated query is no longer split into separate
  terms, matches no longer land mid-word, results rank like the sidebar, and the
  search index no longer treats `item_type` as content (#140).

### [0.18.3] - 2026-08-06

#### Added
- The Codex connector plugin now ships the Switch MCP server itself
  (`mcpServers` + `env_vars` name-forwarding), so Codex can be used with Switch
  **outside switchdash** — previously the server was registered only by a
  switchdash-written profile, and a hand-run Codex session had the room-workflow
  skill but none of the tools it describes. The plugin also auto-approves the
  Switch tools, which no `approval_policy` setting could do: measured against
  codex-cli 0.146.0, that setting does not govern MCP tool calls at all
.

  ⚠️ Codex upgrades a plugin only when a user clicks Update in Settings and
  caches each version separately, so an install still on an older connector has
  no Switch tools until it is upgraded.

#### Fixed
- Bypass permissions is applied to sessions again: the toggle is stored on the
  agent but every launch read a copy frozen into the session at creation, so
  changing it never affected an existing session — on restart or resume — while
  the settings copy promised the opposite.
- Codex runtime status reports tool calls ("Running tool …") instead of sitting
  on "Working on it…" for a whole turn; no tool hook was registered for Codex,
  so nothing could ever produce an activity update.
- In-app release links resolve again: the sidebar update indicator and the
  Settings Update card pointed at `.../releases/tag/v<version>`, which is not a
  real tag (the app is tagged `switch-console-v<version>`), so the user hit a 404;
  the release-notes fetch had the same broken tag and now also authenticates
  with the gh CLI token so it can read the private release feed instead of
  silently returning nothing (#134).

#### Changed
- The per-agent Codex profile carries only model, reasoning effort and
  instructions. An agent that sets none of them no longer gets a profile at all
.

### [0.18.2] - 2026-08-05

#### Fixed
- Client side of one-session-per-room enforcement: a session whose room the
  server takes away (or refuses with HTTP 409 because another session of the
  agent holds it) is now reported as roomless and is not reconnected under a
  room it no longer attends — the remote-session reconciler and sidecar no
  longer strand two sessions in one room (#109).

### [0.18.1] - 2026-08-05

#### Changed
- Bundled Switch agent runtime bumped to 0.1.5 (#127).

#### Fixed
- A session's Switch connection id is now derived deterministically, so a
  supervisor/sidecar restart no longer strands a remote session with a stale
  connection id (#125).

### [0.18.0] - 2026-08-04

#### Added
- Codex is now a supported agent provider. Add a Codex agent from the add-agent
  modal (with a dedicated Codex config), connected to Switch via a new Codex
  connector plugin registered in the marketplace, running locally or on a remote
  host. `CODEX_SANDBOX_MODE` / `CODEX_APPROVAL_POLICY` drive Codex's sandbox and
  approval (validated — an unknown value fails rather than silently widening the
  sandbox); a Codex agent defaults to a `codex.<repo>.<user>` identity; and
  switchdash registers the Switch MCP runtime for Codex itself via a per-agent
  Codex profile (#91, #79).

#### Fixed
- Codex session correctness: per-agent Switch credentials are written to disk for
  providers without repo-agents (so Codex sessions actually receive `SWITCH_*`);
  Codex room tracking follows `connect_to_room` mid-session; and Codex hook
  payloads post correctly (local Codex sessions had been posting empty bodies to
  a portless URL) (#79).

### [0.17.2] - 2026-08-04

#### Added
- Status-aware "update available" UX: the sidebar indicator shows the target
  version when an update is available, live percentage + transfer rate while
  downloading, a restart prompt once ready, and a warning tint on failure — and
  opens a panel (current → new version, the right action, a link to the GitHub
  release) instead of just jumping to Settings. User-triggered failures are
  toasted and the real error message is shown (#107).

#### Fixed
- The onboarding/home page can drag the window again: the empty home surface is
  now a drag region (action buttons opted out), so the window is no longer stuck
  when Home is the active view (#106).

### [0.17.1] - 2026-08-04

#### Added
- Linux x64 desktop builds are shipped again (AppImage, deb, rpm), with a stable
  desktop-entry name so the launcher, icon and pinning behave; INSTALL docs and
  release notes now cover Linux (#104).

#### Changed
- Release builds macOS and Linux artifacts in parallel (the GitHub Release is
  created in its own job), cutting ~5 minutes off a release (#104).

#### Fixed
- A dropped-events "gap" no longer wakes an agent and spends a turn: switchdash
  defers the warning onto the next event it was already going to surface, instead
  of injecting an addressed prompt (#105).

### [0.17.0] - 2026-08-04

#### Added
- In-app Switch room creation: create a room from switchdash (name, description,
  messaging app, agents, optional instructions) instead of the operator web app —
  the picker offers only running bridges and every created room is bridged
 (#103).
- Room-centric sidebar: a room tree listing rooms by membership and ownership
  (not only rooms with a live session), showing each room's members, managing
  membership (add/remove agents), starting a session in a room with the agent
  pre-chosen, and opening the room in its messaging app when the gateway supplies
  a deeplink; rooms sort and filter on their own properties (#103).

#### Fixed
- Sessions launched for a room now declare that room when their connection opens
  — both sidebar-started and auto-spawned (messaging-app-addressed) sessions
  appear under the correct room immediately instead of sitting under
  "Unassigned" until the agent calls `connect_to_room` (#103).

### [0.16.1] - 2026-08-03

#### Added
- Local GitHub-auth detection in Switch setup: a requirement row reporting `gh`
  missing / not logged in / missing `read:packages`, with an inline device-flow
  login that requests the scope. Sessions that can't fetch the runtime now toast
  the reason instead of starting silently broken (#102).

#### Fixed
- GitHub auth changes now take effect without restarting: the updater no longer
  leaves a boot-time token in `GH_TOKEN` (which shadowed the keyring for `gh`),
  and the scope check judges the active account only (`gh auth status --active`)
  rather than any known account (#102).
- A dialog's own terminal now receives keystrokes (the `gh auth` prompt was
  silenced inside the Agent Settings modal); agent usage — not just install — is
  gated on GitHub access; managed servers pinned to switch-core `0.11.0` (was
  `0.8.1`) (#102).

### [0.16.0] - 2026-08-03

#### Added
- Move switchdash and the remote sidecar onto the agent-bridge push stream: one
  shared connection per session claims its room server-side instead of scraping
  it from a hook, backed by the new `@sandbox-quantum/switch-agent-runtime`
  shared protocol client used by both switchdash and the connector plugin
 (#100).

#### Removed
- First-run welcome page and residual Emdash artwork; first run now lands on the
  existing home empty state with an "Add Switch agent" action (#96).

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
 (#83).

#### Fixed
- Stop a destroyed managed server's agents from polling forever: resetting a
  managed server now deletes its agents (the cascade lives behind the reset in
  the main process), room connections are keyed per session with
  `ON DELETE CASCADE` so orphaned entries are unrepresentable, and the boot
  sweep refuses to restore sessions for orphaned agents instead of hammering a
  dead endpoint (#95).

### [0.15.1] - 2026-07-30

#### Fixed
- Surface non-image attachments to dash-managed sessions: switchdash's own
  session-notification builder now downloads and annotates any file type (not
  just images) and names failed downloads, so agents running under switchdash
  are actually told about files posted in a room (#94).

### [0.15.0] - 2026-07-29

#### Added
- Built-in chat: switchdash renders each room's default bridge conversation
  inline (Mattermost) with per-room embed resolution, a chromeless guest view,
  theming, and link/deeplink routing; Slack rooms get a deeplink and agent-only
  rooms a stated reason (#84).

#### Fixed
- Gate remote managed servers on host reachability, so an unreachable host no
  longer shows a stale green "Running" card or a spinning sign-in — the server
  page shows a "host unreachable" state and disables actions until it recovers
 (#85).

### [0.14.3] - 2026-07-28

#### Fixed
- Model remote-host reachability as a first-class per-host state machine, so
  switchdash stops the unbounded reconnect/reconcile retries against an
  unreachable host (one bounded backoff probe per host), persists the state
  across restarts, and surfaces a clear "host unreachable — work paused" panel
  with a global Retry instead of raw SSH errors (#82).

### [0.14.2] - 2026-07-28

#### Fixed
- Key the remote session reconciler per-sidecar instead of per-location, so
  sessions from multiple agents sharing one working directory all get adopted
  into the sidebar (#81).

### [0.14.1] - 2026-07-27

#### Fixed
- Reap sidecars orphaned when their tmux session name changes across upgrades,
  instead of leaving duplicates running for the same agent directory.

### [0.14.0] - 2026-07-27

#### Added
- Remote sidecar now persists durable state and versioning, so running sessions
  survive sidecar restarts, upgrades, and token rotation.

#### Fixed
- Client no longer deletes healthy sessions when it briefly can't reach the
  sidecar; fixes cross-build kill loops and deaf clients after a sidecar restart
.

### [0.13.1] - 2026-07-26

#### Fixed
- Fix slow boot caused by the agent-storage migration, and restore sessions that
  vanished after the 0.13.0 upgrade.

### [0.13.0] - 2026-07-26

#### Changed
- Removed the subagent concept — agents are now flat and repository-defined;
  existing subagents migrate forward automatically on first launch.

#### Fixed
- Honor the bypass-permissions toggle for remote agents and clear a stale
  session guard.
- Skip the connection-status probe for a stopped managed server.

### [0.12.0] - 2026-07-24

#### Added
- Configure per-agent addressing policy from the app and gateway.

#### Fixed
- Data-entry modals no longer dismiss on outside-click, so in-progress input
  isn't lost.

### [0.11.4] - 2026-07-24

#### Added
- Reset a remote agent — kill and reset all of its tmux sessions.

### [0.11.3] - 2026-07-24

#### Changed
- Sidebar and session UX polish.

### [0.11.2] - 2026-07-24

#### Added
- Delete and rename connected Switch servers.
- Per-agent bypass-permissions setting — defaults off, on for remote agents
  (#57).

### [0.11.1] - 2026-07-24

#### Added
- Agent delete now tears down its credentials and optionally deletes the agent
  from Switch.
- Agent error indicator with a retry button.

#### Changed
- Discord bridge polish: deeplink redirect, room icon, and outbound image relay
.
- Relicensed to Apache-2.0 + Commons Clause, with a CLA gate for contributions
.

### [0.11.0] - 2026-07-20

#### Added
- Managed Switch servers can now run on a remote host over SSH — the app
  provisions the Docker stack remotely, with port-forwarded access, alongside
  the existing local mode.

### [0.10.1] - 2026-07-20

#### Added
- Silent session token refresh — sessions renew before the 24h expiry instead
  of bouncing to sign-in; the managed local server is always-signed-in, and
  its gateway web page opens pre-authenticated in-app.
- Editing a server's API URL cascades to its member agents' configs
.

#### Fixed
- Remote sessions recover their room connection after an app restart or
  machine sleep.

### [0.10.0] - 2026-07-20

#### Added
- Local-server mode: run a managed Switch stack via Docker straight from the
  app — pulls the versioned standalone compose artifact, provisions
  env/secrets/ports, and monitors health.

#### Fixed
- Injected prompts are always bracketed-pasted, so prompts containing @ no
  longer swallow the submit.

### [0.9.2] - 2026-07-19

#### Added
- Sidebar agents are labelled by their registered Switch name.

### [0.9.1] - 2026-07-19

#### Changed
- Replaced the workspace/project abstraction with first-class Locations —
  agents attach directly to a location (working directory).
- Collapsed sessions to a single conversation each and simplified
  session/conversation management throughout.

Existing databases migrate forward automatically on first launch (schema
migrations 0031–0036, including a locations backfill).

### [0.9.0] - 2026-07-17

#### Added
- Newly created subagents default to auto-session on.

#### Removed
- Removed the telemetry/analytics stack entirely — the app ships no tracking
  or phone-home behavior.

#### Fixed
- tmux mouse scroll works again (set-option target parsing).
- Switch setup re-points stale plugin-marketplace sources after the repo move
  and surfaces failed refreshes instead of silently skipping.

### [0.8.8] - 2026-07-15

#### Changed
- Updated Electron to 40.8.5 and drizzle-orm to 0.45.2.

#### Fixed
- Switch settings writers no longer clobber `settings.local.json` when reading
  the existing file fails (local, remote-SSH, and plugin-fs providers).

Desktop-app releases predating this changelog live in the git log and in the
per-release notes on their GitHub Releases (`switch-console-v*` tags).

---

## agent-runtime

The Switch protocol client and MCP runtime
(`console/packages/switch-agent-runtime/`). Version lives in its `package.json`.

### [Unreleased]

#### Changed
- The MCP server instructions no longer tell the agent to `read_context` on
  every message event, or to connect before every call. Reading is now
  conditional on a signal that the agent is actually behind — an unread count
  above zero, a gap warning, an unfamiliar thread, a long silence — and the
  connection is described as holding for the session rather than as a
  precondition to re-establish per call.

### [0.3.0] - 2026-08-11

#### Changed
- Published to **npmjs.com** under the **`@sandboxaq`** scope (was
  `@sandbox-quantum` on GitHub Packages), so `npx` fetches it with no login and
  nothing on disk — anyone, inside or outside SandboxAQ, can run the connector
  plugins. GitHub Packages required a `read:packages` token even for public
  packages, which `gh auth login` does not grant, so external consumers hit a
  404 naming neither the registry nor the missing credential.
- Publishing now authenticates by **npm trusted publishing (OIDC)** and runs in
  the `release` environment, so a pushed tag queues the publish for approval;
  builds carry `--provenance` and no npm token is stored.

The package name (`switch-agent-runtime`) and the runtime's behavior are
unchanged — only where and under what scope it ships. Version `0.2.x` was
skipped to `0.3.0` by request.

### [0.2.0] - 2026-08-10

#### Added
- Resolves its own Switch identity and credentials from the local agent store
  (`./.switch/agents/`), not only from the environment — so a connector-plugin
  session that is handed the server but no identity can start standalone instead
  of exiting before the handshake.
- `select_agent` tool: when the store names several agents on one server,
  identity is left open and `select_agent` binds it; the event stream and
  heartbeat start on bind rather than at boot.
- Degraded startup: on a resolution failure — no credentials, an ambiguous
  multi-server store, or an unreachable Switch — the runtime starts anyway and
  serves a single `switch_unavailable` tool whose result is the diagnostic,
  instead of vanishing so Switch tools read as silently missing.

#### Changed
- An unexpanded `${SWITCH_*}` placeholder now counts as absent rather than as a
  value, so a Claude connector session falls through to the store instead of
  dying on its own placeholder. Half a set of vars still refuses to start
.

### [0.1.6] - 2026-08-09

#### Added
- Declares its `agent-protocol` range, artifact name and release version on the
  event stream it already opens, so switch-core can record what is connecting
.
- Logs the server's declaration from the `connection_state` frame, so which
  versions were actually talking to each other is answerable from a bug report
  rather than a guess.

#### Changed
- Reports a failing event stream on a curve — first failure, then powers of
  two, plus a line when it recovers — instead of once per reconnect. The
  reconnect itself is unchanged; only the reporting is rationed, so a stack
  that is simply stopped costs a handful of log lines rather than one per
  session per 30s, forever.

### [0.1.5]

Releases before this changelog existed are in the git log. They are not
reconstructed here: an invented history reads exactly like a real one.

---

## sidecar

The remote runtime Switch Console deploys to an agent host. Versioned in
`console/apps/switch-console-desktop/src/sidecar/sidecar-version.ts` and deployed
by Switch Console rather than published on its own.

### [1.9.0]

#### Changed
- Dropped the npm-registry-auth machinery (`npm-registry-auth.ts`): now that the
  agent runtime is published to public npmjs (CHOO-2021, CHOO-2023), the sidecar
  no longer needs a token to `npx` it. Behavior change only — the
  client↔sidecar wire (ready line, endpoints, on-disk layout) is unchanged, so
  the major stays at `1`.

### [1.8.0]

#### Added
- Declares its `sidecar-control` range in the ready file switchdash already
  reads.

#### Changed
- Three-part semver: `1.7` becomes `1.8.0`. **The major stays at 1** — every
  switchdash already in the field judges compatibility on the major and parses
  two parts, so `1.7` and `1.8.0` order correctly and neither side
  replaces the other. `2.0.0` would have every existing install treat this
  sidecar as incompatible and replace it while a newer install replaces it back
.
- The version no longer carries compatibility. It says which release is running;
  what the sidecar can speak is the `sidecar-control` range it now declares in
  its ready file.
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

#### Fixed
- The channel's unread tally now resets when the agent reads the room. The
  `PostToolUse` matcher never included `read_context`, so the reset the hook
  already implemented was unreachable and the count only ever climbed from the
  moment a session connected.

#### Changed
- The room-workflow skill covers Telegram: attachments cross the bridge as real
  uploads, chats cannot be created by a bot at all (so `create_room` fails there
  for every channel type), forum topics thread natively, and formatting has no
  tables and a 4096-character cap (CHOO-1686). It also warns that a Telegram
  room may be mention-only, where unaddressed talk never reaches Switch at all
  and `read_context` cannot recover it — the one place the skill's "pull the
  rest with `read_context`" promise does not hold. The slash-command and
  attachment platform lists now also name Discord, which had been left out of
  both.
- Skill: document the room-document and room-admin tools it had never
  mentioned — `load_internal_documents` (without which an agent cannot read a
  document attached to its own room), `list_references`, the
  `create`/`update`/`delete_room_document` trio, `add_users_to_room`, and
  `archive_room` / `unarchive_room`.
- The skill is state-aware: it loads once for a session instead of before every
  tool call, and no longer makes an agent reconnect and re-read the room to say
  one thing. The `description` still directs the agent to load the skill — a
  passive rewording stopped it loading at all in live runs — but says to load it
  once, and drops the 40-name tool inventory; a new "steady state" section says the connection holds for the
  session; and the unconditional "always read / always connect" instructions
  are replaced by triggers that fire on an actual signal.
- Skill: correct the paging instruction. It told agents to pass
  `oldest_timestamp` straight back as `before`, but the first is epoch
  milliseconds and the second is parsed as an ISO-8601 string, so the call
  raised instead of paging.

### [0.8.1] - 2026-08-11

#### Changed
- Pin `@sandboxaq/switch-agent-runtime@0.3.0` — the runtime moved to public
  npmjs under the `@sandboxaq` scope (CHOO-2021), so `npx` no longer needs a
  GitHub token. The scope change had shipped without a plugin version bump and so
  never reached installs; this release carries it and bumps the plugin version so
  installs re-download.
- Skill: document `read_context`'s new response shape — `truncated` /
  `oldest_timestamp` and the per-entry `kind` — and tell the agent not to
  conclude anything from a truncated read.

#### Removed
- Dropped the bundled `configure` skill as part of removing the private-repo /
  `gh` setup machinery now that the repository is public (CHOO-2023).

### [0.7.9] - 2026-08-09

#### Changed
- Bump the pinned `@sandbox-quantum/switch-agent-runtime` to `0.1.6`, so sessions
  pick up its rationed stream-failure reporting and version declaration
. The plugin version bumps with the pin so installs
  re-download it.

### [0.7.8]

Releases before this changelog existed are in the git log and in the plugin
manifest history.

---

## switch-connector-codex

`connectors/codex-plugin/`. Version lives in `.codex-plugin/plugin.json`.

### [Unreleased]

#### Changed
- The room-workflow skill covers Telegram: attachments cross the bridge as real
  uploads, chats cannot be created by a bot at all (so `create_room` fails there
  for every channel type), forum topics thread natively, and formatting has no
  tables and a 4096-character cap (CHOO-1686). It also warns that a Telegram
  room may be mention-only, where unaddressed talk never reaches Switch at all
  and `read_context` cannot recover it — the one place the skill's "pull the
  rest with `read_context`" promise does not hold. The slash-command and
  attachment platform lists now also name Discord, which had been left out of
  both.
- Skill: document the room-document and room-admin tools it had never
  mentioned — `load_internal_documents` (without which an agent cannot read a
  document attached to its own room), `list_references`, the
  `create`/`update`/`delete_room_document` trio, `add_users_to_room`, and
  `archive_room` / `unarchive_room`.
- The skill is state-aware: it loads once for a session instead of before every
  tool call, and no longer makes an agent reconnect and re-read the room to say
  one thing. The `description` is a trigger rather than a 40-name tool
  inventory — which also keeps it clear of Codex's skill-description budget,
  which silently truncates an overlong one; a new "steady state" section says
  the connection holds for the session; and the unconditional "always read /
  always connect" instructions are replaced by triggers that fire on an actual
  signal.
- Skill: an unread count is documented as proof you are behind, but its absence
  is no longer documented as proof you are current — Switch Console resets the
  tally on every line it delivers, not when the session reads.
- Skill: correct the paging instruction. It told agents to pass
  `oldest_timestamp` straight back as `before`, but the first is epoch
  milliseconds and the second is parsed as an ISO-8601 string, so the call
  raised instead of paging.

### [0.2.3] - 2026-08-11

#### Changed
- Pin `@sandboxaq/switch-agent-runtime@0.3.0` — the runtime moved to public
  npmjs under the `@sandboxaq` scope (CHOO-2021); the scope change had shipped
  without a plugin version bump and never reached installs, so this release
  carries it and bumps the plugin version to force re-download.
- Drop `SWITCHDASH_GITHUB_TOKEN` and `npm_config_userconfig` from the forwarded
  `env_vars` in `.mcp.json` — `npx` no longer needs a GitHub token now that the
  runtime is on public npmjs (CHOO-2023).
- Skill updated for `read_context`'s new response shape — `truncated` /
  `oldest_timestamp` and the per-entry `kind`.

### [0.2.1] - 2026-08-09

#### Changed
- Bump the pinned `@sandbox-quantum/switch-agent-runtime` to `0.1.6`. The plugin version bumps with the pin so installs re-download it.

### [0.2.0]

Releases before this changelog existed are in the git log and in the plugin
manifest history.

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
- **switch-connector** / **switch-connector-codex** / **switch-connector-opencode**
  — the three connectors (`connectors/`), versioned in their respective
  manifests. The first two are installed from the plugin marketplace; the
  OpenCode one is written by Switch Console, which has no marketplace to install
  from, so its version identifies the source rather than an install.

Three things are **not** separately versioned, and ship under the switch-core
release so a single tag pins the whole stack: the **operator dashboard**
(`gateway/`), the **Helm chart**, and the **standalone compose artifact**. Their
versions are stamped at package time from the switch-core version; do not add a
version of their own to them without also giving them a release of their own.

---

## switch-core

### [Unreleased]

### [0.17.2] - 2026-08-18

#### Fixed

- The collaboration-bridge runtime status is delivered where the reply is. When
  an agent was addressed at channel level its reply opened a thread on the
  triggering message while the status line stayed at the channel root, so the
  two landed in different places. Adapters can now opt into anchoring the status
  on the triggering message; Mattermost takes it — where a thread is a side
  panel, a status left at the root is the one nobody opens. The typing indicator
  is reported against the trigger's actual location (channel vs thread) rather
  than the status's, so it shows where the person who addressed the agent is
  watching (CHOO-2173).

### [0.17.1] - 2026-08-16

#### Fixed

- Agent avatars no longer show a bright square on Slack's dark message list. A
  generated avatar is a transparent DiceBear PNG and Slack composites it onto
  white; newly generated icon URLs now name Slack's resting dark surface as the
  background instead. Only newly generated URLs change — an icon already stored
  keeps its URL (#239).

### [0.17.0] - 2026-08-16

#### Added

- Agents can carry a custom icon. Switch stores a per-agent `icon_url` — a link,
  never image bytes — accepted at registration and set, changed or cleared
  through a dedicated `set_agent_icon` operation and `PUT /agents/{id}/icon`; it
  is reported on the agent summary and detail. The Mattermost bridge fetches the
  icon and re-uploads it as the bot avatar. Because Switch itself dereferences
  the URL, it is validated to an absolute `https` address with no embedded
  credentials and refused when it names a local, private, loopback or
  link-local host (CHOO-2171).

#### Fixed

- An agent joining a room greets it again. The greeting fires when an agent
  notices its own arrival, and since 0.9.0 it never did: auto-accepting the
  invite began recording the room as joined a moment before the join arrived
  over sync, so the arrival was read as one already handled. Every room an
  agent is invited to went ungreeted, on every connection, regardless of the
  per-connection greeting toggle. Whether the arrival has been announced is now
  tracked separately from membership, which the bridge needs recorded as early
  as possible. Departing a room resets it, so being added back greets again.
- `just test-integration` runs again. Its wiring had drifted behind
  `RoomService`, `ProtocolService` and `AgentClient`, so every test errored
  during setup — unnoticed, because the suite is excluded from the default run
  and from CI. It is the suite that would have caught the greeting regression.
- The bundled-stack **setup image** links the seeded Mattermost admin to its
  owner, so a freshly seeded managed deployment comes up already knowing which
  chat account the owner is — owner-only addressing then works without the owner
  linking an account by hand first (CHOO-2172).

### [0.16.0] - 2026-08-15

#### Added

- A Switch user can claim their messaging-app account as their own, linking a
  Slack / Mattermost / Teams / Discord identity to their Switch login
  (`external_user_claims`). Claiming searches the platform's own user
  directory, so someone can be recognised before they have ever posted —
  previously Switch only learned of a person when they first spoke, which left
  a freshly connected workspace with nobody to pick. Each platform is searched
  in its own way: Slack filters a paged listing, Mattermost and Discord have
  server-side search, and Teams queries the directory through Graph. Telegram
  has no directory a bot may search at all, so there the list falls back to the
  accounts Switch has already seen and says why it is narrower — a smaller
  answer rather than a refusal, since refusing would leave owner-only
  addressing unusable on the platform for people Switch already knows. Claims
  are not exclusive: several Switch users may claim the same account, so nobody
  can keep the real person from being recognised by claiming it first
  (CHOO-2137).
- An addressing rule can name the agent's **owner**, or **any agent that owner
  runs**, rather than a list of identities. Both resolve when the message
  arrives, so they survive connecting a new workspace, recreating a bridge,
  registering another agent, or the agent changing hands. The second is what
  lets one person's manager agent keep dispatching their own workers under an
  owner-scoped policy — that is the owner acting through a program, where
  someone else's agent is not (CHOO-2137).
- `GET /agents` reports each agent's `addressing_policy`, which until now was
  only on `GET /agents/{id}`. So "which of these agents answers only its owner"
  is one list read rather than a read per agent — the shape a client needs to
  ask that at all, instead of a request storm (CHOO-2137).

#### Changed

- A messaging app declares **whether its user directory can be searched**
  (`directory_search_supported`, beside `channel_creation_supported`). False
  for Telegram, where a bot can only name people who have messaged it. Read
  from the adapter class, so it is answerable before a connection of that type
  exists — which is when a client has to decide whether asking someone to pick
  themselves out of a directory is a question worth putting (CHOO-2137).
- **Disconnecting a messaging app now removes the identities Switch made for
  it** — the app's own Matrix client and the puppet behind every person Switch
  saw on it. They were left behind, and the app's own client is not merely
  untidy: its Matrix name was derived from the app's type and display name, so
  disconnecting an app and connecting one named the same failed outright on the
  leftover (`duplicate key value violates unique constraint
  "clients_matrix_user_id_key"`). The name now carries a random tail as well,
  because deleting the row is necessary but not sufficient: the homeserver has
  no call for removing an account, so the old Matrix user is still there, and
  adopting it would mean logging in with a password Switch no longer holds —
  shared-secret registration reports an existing user as success without
  applying the new one, which reads as a working connection that can never
  connect. Abandoned homeserver accounts are logged on removal rather than
  passed over in silence (CHOO-2137).
- **An agent pings its owner, not a handle typed into its config.** The
  per-agent `notify_user` option is gone; who to @-mention when an agent needs
  input is now the agent's owner, resolved through the messaging account that
  person has claimed on the platform the room is bridged to. A handle only ever
  means something on one platform — the same person is one name on Slack and
  another on Telegram — so a single configured string was at best right in one
  room, and on Discord and Teams it went out as plain text that notified nobody
  while looking like it had. An agent with no owner, or an owner who has linked
  no account there, now **says so in the nudge** instead of posting a line with
  the mention silently missing: a ping that reaches no one and an agent that
  never asked look identical otherwise. Existing `notify_user` values are
  ignored rather than migrated, and drop out of an agent's options the next
  time they are written (CHOO-2137).
- **Newly created agents are owner-only by default**: only their owner may
  address them, from any room, and no agent unless the owner says so. The
  default is applied where every registration path converges, so it holds
  for Switch Console, the gateway, the agent bridge, the configure skill and
  bulk subagent registration alike. Existing agents are left open — the default
  is not applied retroactively, since that would mute every agent whose owner
  has not yet claimed an identity. Server-side connector agents opt out: they
  are services a deployment offers everyone, not one person's assistant
  (CHOO-2137).
- In-room commands are subject to the addressing policy, not just messages —
  `!reset`, `!interrupt` and `!compact` drive an agent as surely as a mention
  does, and previously reached a restricted agent from anyone in the room. A
  command naming the agent draws the same one-line refusal; a room-wide command
  is declined quietly rather than producing a refusal from every restricted
  agent present (CHOO-2137).
- `send_targeted_message` reports a target whose policy forbids the sender as
  `not_permitted`, rather than as "live" for a message that will never move it.
  The message is still sent and the target still declines it in the room: a
  refusal belongs where the request was made, not only in the sender's account
  of it, and the same request should not succeed or fail depending on which
  tool carried it — a plain `@name` was never blocked. `delegate_task` remains
  the exception and fails at the sender, because a task is a row somebody is
  expected to work rather than something a room can decline (CHOO-2137).
- An agent that refuses a sender because its owner cannot be identified says
  so, and points at linking the account in Switch Console — rather than giving
  the owner the generic refusal from their own agent (CHOO-2137).

### [0.15.0] - 2026-08-14

#### Added
- Telegram collaboration bridge, at parity with Slack, Mattermost and Discord
  (CHOO-1686). A single bot backs every agent — Telegram has no per-message
  identity override — so an agent is named at the head of its messages, beside a
  stable colour derived from that name, which is the closest thing to a
  per-agent avatar Telegram allows. Inbound arrives by long polling, so no
  public ingress is needed. Chats cannot be created by a bot, so a Telegram
  connection declares that up front and rooms are provisioned when the bot is
  added to a chat. Multi-file messages post as a
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

- Whether a messaging-app connection may create channels is now declared rather
  than discovered by failing, in two parts: what the platform can do at all
  (Telegram cannot — the Bot API has no call for it) and what an operator
  permits this connection to do, set when the app is registered and changeable
  afterwards. The second can only narrow the first. A deployment can therefore
  withhold channel creation from Slack or Teams as well, for a bot that holds no
  such permission or an organisation that would rather channels were made by
  people. The answer reaches everyone who acts on it: the room forms in the
  dashboard and Switch Console stop offering the option and say which reason
  applies, `list_bridges` carries `can_create_channels` so an agent can choose a
  bridge that works, and a refused create is a `400` naming what to do instead.

#### Fixed
- Creating a room on a bridge that cannot make channels returned "Internal
  Server Error". The adapter's explanation — make the chat on the platform, add
  the app, Switch adopts it — was thrown away at four of the six doors into room
  creation, because `NotImplementedError` subclasses `RuntimeError` and every
  caller catches only `ValueError`. It is now a `ValueError` subclass, so the
  message survives to the caller as a 4xx. Opening a DM is governed the same way.
- Telegram admin notices reached the chat as Markdown source, `**` and backticks
  included. They are written in Switch Markdown like every other body but were
  handed to the API without the conversion, and everything goes out with
  parse_mode HTML. Two notices were also written with single-asterisk emphasis,
  which no platform's converter recognises — Slack bolded them by accident and
  Telegram italicised them.
- The "Open in Switch Console" link on Telegram no longer disappears, and can no
  longer take its message with it. It is a `switchdash://` URL and Telegram
  renders only `http(s)`/`tg:`: the client dropped the link and kept the label,
  or the API rejected the whole message. An unsupported scheme is now posted as
  tap-to-copy text, and the bridge warns at startup when a platform that only
  renders web links is running without `GATEWAY_PUBLIC_URL` — which is what
  makes the link real, in the Telegram app and on Telegram Web alike.
- A Telegram message Telegram rejects is retried unformatted whatever the
  reason. The retry only fired when the error contained "parse", so a rejection
  worded any other way — "unsupported URL protocol" among them — lost the entire
  message to a single log line.
- A Telegram command that needs an argument is usable from the `/` menu.
  Telegram sends a command the instant it is tapped, with no chance to type one
  and no way for a bot to declare that one is wanted, so `/invite_agent` always
  arrived bare — and answering with its usage line left retyping the whole
  command by hand as the only way through, which is what the menu was for. The
  bot now asks for what is missing, with Telegram's own reply prompt so the
  composer opens ready, and runs the command when you answer. Giving the
  argument up front skips it; the prompt is one-shot, so talk that continues
  under it stays ordinary chat.
- The no-agents notice advertises `/invite_agent` on Telegram, the only spelling
  Telegram will register and therefore the only one its command menu offers. It
  named the hyphenated form, which the client will not autocomplete. All three
  forms are now listed.
- The Telegram brand icon renders correctly in Switch Console's dark theme. The
  plane was a hole punched through the disc rather than a white shape, so it
  showed the background through it and came out black.
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

### [0.14.0] - 2026-08-14

#### Added

- `opencode` is a registerable known agent type, alongside `claude-code` and
  `codex`. It carries its own option set — auto-session, working directory and
  notify-user — rather than borrowing another type's, and the start-session
  command it shows in a room passes the prompt as a flag, since OpenCode reads
  its first positional argument as a directory to open.

#### Fixed

- The OpenCode server-side connector no longer hangs when the OpenCode server
  raises a tool permission request. The connector's event loop ignored
  `permission.updated`, so no reply was ever sent, the session never went idle,
  and the response stream blocked forever. Permission requests are now answered
  automatically — this connector reports tool calls after the fact and performs
  no pre-invocation mediation, so there is nothing for a prompt to gate.
- The Mattermost bridge no longer litters a channel with "(message deleted)"
  placeholders while an agent works. Mattermost's web client shows that
  placeholder for any message removed while it is on screen — a permanent
  delete looks no different to it, and no server setting turns it off — so the
  agent's status line is now retired by editing it into a "✓ Done · 2m14s"
  marker rather than being deleted, and it no longer moves down the channel to
  follow the conversation (each move was a delete of its own). The marker
  carries nothing else: it stays in the channel permanently, so it is kept to
  the fact that the turn finished and how long it took.

### [0.13.2] - 2026-08-12

#### Fixed
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

#### Fixed

- **Sign-in details** for a managed server's bundled chat now stays open. The
  dialog was rendered inside the messaging app's dropdown menu, so the same
  click that opened it closed the menu — and the menu took the dialog with it,
  before anyone could read a credential off it.
- Deleting a Switch server no longer leaves the app pointed at it. The deleted
  server's id survived in the saved page state, so the app could return to a
  page for a server that no longer exists and keep asking its gateway for a
  sign-in configuration nothing could answer. The page now falls back to home
  and the dead id is discarded.

### [0.27.2] - 2026-08-18

#### Added

- Switch Console now asks, the first time you open it, whether you are happy to
  share anonymous usage data, and states plainly what that would and would not
  include. The choice is saved per install and can be changed at any time from
  **Settings → General** (CHOO-1955).
- The app still sends nothing: there is no telemetry to consent to yet. What
  this adds is the control and the contract — a single gate that any future
  collection must ask before sending, which fails closed, so a fresh install
  that has not reached the prompt sends nothing regardless of how the toggle
  reads. Because the toggle defaults to on, `console/AGENTS.md` now pins what a
  payload may ever contain: anonymous counters, and no identifier of any kind.
- A signed, notarized **Intel (x86_64) macOS build**. macOS now builds per-arch
  on native runners, so an Intel Mac has an installer again after the app went
  Apple-silicon-only; the auto-update channel manifest is written per arch so
  the two builds no longer overwrite each other's update feed (CHOO-2195).

#### Changed

- **Windows builds are now signed** with Azure Trusted Signing, so the installer
  and app no longer trip SmartScreen's unknown-publisher warning (CHOO-1468).
- Local-server mode now bundles and pulls **switch-core `0.17.2`** (was
  `0.17.1`): the bundle pin / `COMPATIBLE_SWITCH_VERSION` is raised to the
  current core release.
- The add-agent addressing control is renamed **"Who can talk to your agent"**,
  and its Settings section now unfolds itself when the owner-only default would
  reach nobody, so the warning that the agent will answer no one on that
  messaging app is visible instead of hidden in the fold (CHOO-2173).

#### Fixed

- A directory configured by the connector's `configure` skill is recognised as
  an agent again. Detection read the identity only out of
  `.claude/settings.local.json`, which the skill deliberately no longer writes
  into — writing two of the three `SWITCH_*` values there is what broke
  standalone sessions. It now falls back to the credentials store, and names no
  agent when the store holds several, since choosing between them is
  `select_agent`'s job and not detection's.
- An auto-started session now receives the message it was started for. Its room
  connection opens before the terminal is spawned, so the replayed trigger had
  nowhere to go and — unlike the other wait paths — never retried: the agent
  booted, greeted, and never answered. It now retries until the connection
  closes, and a pty accepts injected input only once the runtime has delivered
  the session's opening prompt, so the trigger can't be appended to that prompt
  and sent as one (CHOO-2173).
- The agent tree no longer highlights every copy of an open room, and the
  titlebar breadcrumb shows the agent's own icon rather than its provider logo
  (CHOO-2173).
- User-facing error messages across the app were audited and rewritten to say
  what happened and what to do, rather than surfacing raw internal errors
  (CHOO-2060).
- Two Switch Console installs sharing a host no longer destroy each other's
  agents. Per-agent credentials live at `.switch/agents/<name>.json`, keyed by
  name alone, and each install's uniqueness check only sees its own database —
  so an agent created with a name another install had already used in that
  directory overwrote its credentials file. Because the write merged into what
  was there, the result was one file carrying the new agent's identity and the
  old one's remaining keys: the displaced agent's sessions authenticated as the
  new agent rather than failing, and its API token, issued once, was gone.
  Creating, provisioning and renaming an agent now refuse a name whose
  credentials in that directory belong to a different Switch server, and say
  which one. Refusal happens before the identity is minted, so nothing is left
  stranded on the server.

### [0.27.1] - 2026-08-17

#### Changed

- Local-server mode now bundles and pulls **switch-core `0.17.1`** (was
  `0.17.0`): the bundle pin / `COMPATIBLE_SWITCH_VERSION` is raised to the
  current core release, so a managed stack picks up the Slack avatar-background
  fix (#239).

### [0.27.0] - 2026-08-16

#### Added

- Give an agent a custom icon. The add-agent dialog and an agent's settings
  carry an icon picker — set, change, or clear it; cleared means an icon
  generated from the agent's name. Icons render in the sidebar, the agent pages
  and dialogs, and existing agents are backfilled on first run (CHOO-2171).

#### Changed

- Local-server mode now bundles and pulls **switch-core `0.17.0`** (was
  `0.16.0`): the bundle pin / `COMPATIBLE_SWITCH_VERSION` is raised to the
  current core release.

#### Fixed

- **Collapse all** collapses again. It cleared state the redesigned sidebar no
  longer reads, so nothing moved; it now names the rows to collapse. Clearing
  that state had also been dropping Next/Previous Session's list of visible
  sessions, which stops (CHOO-2173).
- A sidebar session row's **actions menu acts** — Delete and Archive ran but the
  row's own click handler reopened the session on top of them, so they looked
  inert (right-click was unaffected because it is a sibling of the row). The
  guard now lives in the shared popup (CHOO-2173).

### [0.26.0] - 2026-08-16

#### Changed

- **A visual design pass across the shell.** The window is now one graded
  material surface with the sidebar sitting on it and the main panel floating
  above as an inset card with a hairline and a soft shadow, using the design
  spec's surface/material tokens and corner radii. Home is deliberately left for
  a later pass (CHOO-2164).
- **A server is now a workspace, and you switch between them.** The list of
  servers that sat in the sidebar has been replaced by a switcher at the top,
  showing the one you are in and opening onto the rest — each with where it
  runs and whether it is reachable. Everything below it already belonged to
  that server; now the sidebar says so. Under the switcher is that server's
  Home, which is the page you used to reach by clicking the server in the
  list, and the titlebar names the path to it (CHOO-2158).
- The session list is a section of its own, headed **Sessions**, with the
  grouping control labelled as what it is — group by **By Agent** or **By
  Room** — rather than sitting alone at the top of the tree where it read as
  the sidebar's whole navigation (CHOO-2158).
- The welcome screen is reachable from the switcher as **About Switch**, as
  well as from the Switch mark at the bottom of the sidebar. With no servers
  added, the sidebar is just **Add a server** over the setup checklist
  (CHOO-2158).
- **A server's Home page reads as a dashboard rather than a stack of cards.**
  It opens with the server, where it runs and who you are signed in as, then
  how many agents, rooms and messaging apps are on it, and gives the rest of
  the page over to the things you act on (CHOO-2158).
- **Messaging apps are a table.** Which account is you, whether Switch may
  create channels there, and the app's actions are columns you can read down
  rather than facts to be opened one row at a time. Turning channel creation on
  or off is now in the row instead of behind its menu, and a platform that
  cannot create channels at all says so rather than showing the switch off.
  Unlinking stays in the menu — it is irreversible, and the row is where you
  press to *change* an account (CHOO-2158).
- The managed stack has a section of its own with a **Restart**, and shows its
  live output, which until now was only visible while adding a server. An
  available switch-core update is announced at the top of the page rather than
  inside that section, and **Reset** sits alone at the bottom, away from Start
  and Stop (CHOO-2158).
- The Mattermost sign-in details Switch Console generates open in a dialog from
  the app's row, rather than expanding underneath it (CHOO-2158).
- **A server's agents and rooms each have a page.** Under the switcher, next to
  Home, **Your Agents** lists every agent registered on the server with the
  provider it runs, where that is, and how many of the server's rooms it is in;
  **Your Rooms** lists the rooms with the messaging app each is bridged to and
  how many agents are in it. Both start a session or add a member from the row,
  and carry the same actions the sidebar rows do. Until now the only way to see
  either as a list was to scroll the sidebar tree (CHOO-2158).
- **An agent's page opens with the agent.** Its mark, its name, the server it is
  registered on and what it runs, with **Create Session** alongside — where the
  page used to begin at a list of sessions, with the agent named only in the
  titlebar. Sessions are framed as a list, each saying which room it is talking
  in, or that it is in none (CHOO-2158).
- **The titlebar says where you are, in full.** A session now reads
  agent / room / session rather than naming its directory and itself, and a room
  is its own heading with its messaging app's mark. An agent's page carries the
  same connection status and actions menu its server's pages do (CHOO-2158).
- Agents are described by their provider's name — **Claude Code**, **Codex** —
  rather than the `claude` and `codex` they are keyed by (CHOO-2158).
- **Every session in the sidebar has an actions button.** Pin, rename, archive
  and delete were reachable only by right-clicking, which nothing in the
  interface said you could do; they are now on a menu in the row as well. Both
  menus are built from one list, so an action cannot arrive on one and be
  missing from the other (CHOO-2158).
- **Expanding a row in the sidebar is now the chevron's job alone**, and the
  chevron has moved to the end of the row, appearing on hover with that row's
  other actions. Opening an agent or a room no longer unfolds it, so reading one
  thing does not rearrange the tree around it, and the agent's provider mark
  stays visible instead of turning into a chevron under the pointer. A row with
  nothing beneath it has no chevron at all (CHOO-2158).
- **A room in the sidebar no longer counts its agents.** The pair of numbers on
  the row — agents this computer runs, agents it does not — sat where the expand
  control now goes and told you little. The sidebar lists the agents it can
  actually open; a room's full membership is a column on **Your Rooms**, which
  is the page for reading rooms as a list (CHOO-2158).
- **Anything you can click now says so under the pointer.** Buttons, sidebar
  rows, menu entries and tabs show the hand cursor; Tailwind's reset had left
  them all on the arrow (CHOO-2158).

#### Fixed

- **Adding your first server left the app with no workspace selected.** Nothing
  chose it, so the sidebar stayed on "Add a server" until the next launch
  (CHOO-2158).
- **Removing the server you were in could leave the app with no workspace at
  all** — no switcher, no destinations, no sidebar tree — because the remembered
  server was still named as the active one. A remembered server that no longer
  exists now counts as no choice, and the app picks one (CHOO-2158).
- Removing an agent from its own page removed the first agent in that directory,
  which is a different agent whenever a directory holds more than one
  (CHOO-2158).
- The empty session list offered to "spawn a claude session" whatever the agent
  actually runs (CHOO-2158).

### [0.25.0] - 2026-08-15

#### Added

- **You can tell Switch which messaging-app account is yours.** A new dialog
  searches the workspace's own user directory — Slack, Mattermost — and links
  the account you pick to your Switch login. It searches the platform rather
  than Switch's record of who has spoken, so you can find yourself in a
  workspace you have never posted in, and it shows the display name, handle and
  email so you can tell two similar accounts apart. An account someone else has
  already linked says who — linking is not exclusive, so that is information
  about who else is recognised on it rather than a lock — and one you have
  linked yourself offers to unlink instead of linking it twice. A platform with
  no searchable directory says so — and says a message has to arrive first —
  instead of showing an empty list (CHOO-2137).
- The dialog is offered as step 2 of connecting a messaging app, straight after
  the connection succeeds, because that is the one moment the workspace is on
  your mind — **except on an app whose directory cannot be searched**, where it
  is not offered at all. On Telegram, Switch can only name people who have
  messaged it, and nobody has messaged a connection made a second ago: the
  search was guaranteed to come back empty, which reads as "you are not in your
  own workspace" rather than "not yet". Linking waits for the server page,
  where the warning that you own an agent nobody can reach is what prompts it,
  and by then someone has messaged the app and there is a name to pick. The
  search prompt no longer promises a "workspace directory" on a platform that
  has neither. It is skippable, and linking lives on the server page for later:
  **Messaging apps** lists one row per app — the app, the account on it that is
  you, and what you can do with it — where your handle is the button that
  changes it and a Link button stands in when there is none, opening the
  dialog already pointed at that app. So you can see at a glance where you
  are recognised and where you are not, without a separate list to reconcile
  against. Linking is not an admin action: a member of the server sees the same
  card and can link on any app in it, and only the Connect button is withheld.
- **Each messaging app carries its own menu**, holding the actions that are rare
  or destructive: unlinking your account, whether the app may create channels,
  and disconnecting it. The row itself is left saying one thing — which account
  here is you — in one control whether or not there is one. Unlinking in
  particular is off the row: it used to be a bare cross sitting beside the
  handle, one mis-click from the button you press to *change* an account, with
  no confirmation between. The **Default** badge also sits against the app's
  name now rather than drifting into the middle of a wide row.
- **The server page warns when an owner-only agent cannot recognise you**, and
  only then. One line at the top of **Messaging apps** names the apps you have
  not linked — shown when you own an agent on that server whose rule admits its
  owner, and never otherwise. Link everywhere, or own no such agent, and there
  is nothing to see: a warning shown to everybody teaches people to ignore it.
- **A new agent now answers only its owner.** Agents used to be created open to
  everyone in every room; the add-agent dialog now defaults to *Only me*. The
  rule names the owner rather than a list of identities, so it survives
  connecting a new workspace or the agent changing hands. *Only me and my
  agents* is one step away when an agent of yours has to hand this one work.
  Existing agents are untouched.
- **A messaging app can be disconnected from the server page**, by an admin, on
  the same **Messaging apps** row that connects one. It is not a pause: the
  server deletes every Switch room on that app before removing it, so the rooms
  and their conversations go with it, and an app another admin has already
  removed says so rather than reporting a disconnect that never happened
  (CHOO-2137).

#### Changed

- **Who can send instructions to an agent is one question with four answers** —
  *Only me (default)*, *Only me and my agents*, *Anyone*, or *Custom rules* —
  rather than an open / restricted switch above a rule builder. The two
  owner-scoped answers differ in one thing: whether agents you own may hand this
  one work. Anyone drops the policy entirely; Custom rules opens the rule
  editor, seeded from whichever answer the agent was on, so nothing has to be
  rebuilt to add one exception. Rules built by hand are kept while the chooser
  is on a shortcut, and a policy too specific for any of them reads back as
  Custom rules rather than being flattened into one. The same control is on the
  add-agent dialog and on the agent's Settings tab, so a policy is changed the
  way it was set. The box shows the answer that was picked, rather than the
  word stored behind it.
- **The add-agent dialog offered "Advanced configuration" twice** for Claude
  Code. A provider keeps its per-agent settings in one place — a repo-agent
  definition or a launch profile — and the agent's Settings tab picks between
  them by asking which; the creation form rendered both sections instead, and
  the launch-profile one reads a "the fields, from wherever they live" call
  that falls back to the definition fields. So the same settings appeared in
  two identical boxes writing to two different places. It now picks the same
  way the Settings tab does.
- An agent's Settings tab no longer boxes **Advanced configuration** and **Who
  can send instructions** in borders of their own. Every section on the page is
  already a section; drawing two of them again was one frame too many.

- **You and your agents appear in the rule editor's own pickers**, as *Me* in
  the Users list and *My agents* in the Agents list, rather than as a checkbox
  off to the side. They read as what they are — two more senders to admit —
  and they compose: "me and Alice" is one rule. Setting either list to *Any* or
  *None* clears the matching entry, so a rule cannot say "no humans" and "the
  owner may" at once.
- An owner rule can only recognise an owner who has linked their messaging
  account, so the addressing editor warns — with a button into the linking
  dialog — when the signed-in user has linked none. A privacy control that
  silently admits nobody is the failure this exists to prevent.
- The linking dialog is opened on one workspace rather than asking which. It is
  titled for the platform it is linking on — "Link your Discord user account" —
  and its search names the workspace, not the platform, since two workspaces on
  the same platform can be connected and only the name tells them apart.

#### Removed

- The "Give Feedback" feature — modal, Help menu entry, command-palette command
  and its event — along with the hardcoded third-party Discord webhook it posted
  to. The webhook arrived with the initial emdash import and is already revoked
  upstream. **Help → Report Issue** remains the way to send us something; it
  opens an issue on this repository (CHOO-2040).

#### Fixed

- **A session on a remote agent now opens at the size of the pane it opens
  into**, instead of a fraction of it that only corrected itself when the window
  was resized or the session was switched away from and back (CHOO-2066). A
  remote session opens its terminal over SSH, and the renderer mounts and
  measures its pane partway through that: the measurement arrived after the
  spawn size had been read and before there was a PTY to resize, so it was
  discarded and the session kept the 80x24 it was spawned with. Measured
  dimensions are now kept whether or not a PTY is live yet, and applied to the
  PTY when it registers.

### [0.24.0] - 2026-08-14

#### Added

- **An OpenCode agent can be configured like a Codex one.** Its model,
  reasoning variant, temperature, top-p, step limit, web search and
  instructions can be set when the agent is created and changed afterwards from
  its Settings tab, and a change applies to the next session — or to a running
  one with Restart, which resumes the conversation.

  OpenCode's settings are not Codex's, so the per-agent configuration an agent
  stores is now keyed by what its own provider offers rather than by a fixed
  list. Existing Codex agents keep their settings; nothing needs re-entering.

  Its instructions are added to OpenCode's own, the way an `AGENTS.md` is,
  rather than replacing them.

- **You can pick a model instead of remembering it.** Switch Console asks the
  machine an OpenCode agent runs on which models it offers and lists them as you
  type, grouped by provider and annotated with the reasoning variants each
  accepts. Typing something not on the list still works — it is a shortcut, not
  a restriction.

- **The model and reasoning fields check themselves against the agent's own
  host.** A model name that host does not have is flagged as you type, and
  the reasoning variant becomes a menu of what the chosen model actually
  accepts — greyed out, with a reason, for a model that has none, as local
  models generally do. Both were places OpenCode would otherwise accept a value
  and silently never apply it.

  The check warns rather than blocks, since the list is a snapshot and a model
  can appear a moment later. If the host cannot be reached, or OpenCode is not
  installed on it, the fields say so and go back to plain text rather than
  flagging everything as wrong.

  An OpenCode agent can also be pointed at a **local model** — define the
  provider once in your OpenCode config and set the agent's model to it. The new
  utility-model setting is worth setting too if the point is to keep everything
  on one machine: it is what OpenCode uses for background work like naming a
  conversation, which otherwise goes wherever your own config sends it.
- Telegram brand icon, platform label and setup-guide link, so Telegram-bridged
  rooms show the "open channel" button and the attach form links the right guide
  (CHOO-1686). Telegram bot tokens are also redacted from the diagnostic logs.

#### Fixed
- Opening a room from a deeplink expands the sidebar groups hiding it
  (CHOO-1686). The reveal ran once, before the room a session belongs to had
  loaded, and never again — so the view routed correctly to a row that stayed
  collapsed. Affects any bridge, not only Telegram.
- Two Switch Console installs sharing an agent host no longer trade the sidecar
  back and forth when they are on the *same* release but carry different builds
  — the everyday case for dev builds, and the half of the shared-host problem
  that version ordering could not reach. Each install now mints a deployer
  identity and stamps it on whatever sidecar it deploys, so an install can tell
  its own build from another's without relying on the version string. When the
  versions are equal and the builds differ, the install that got there first
  keeps the sidecar.
- The agent's Settings tab says so: the sidecar reads **Another install's
  build**, names who deployed the running one, and offers Restart — a
  deliberate takeover — instead of an Update that both sides would keep
  clicking at each other. Replacement is otherwise unchanged: an older sidecar
  is still replaced whoever deployed it, and a rebuild of your own is still
  picked up.
- Search results no longer read as though agents, sessions and commands were
  servers. Those three had no heading of their own, so they were drawn after the
  last group on screen — usually "Servers" — and appeared to belong to it. Every
  result now sits under a heading that names it.
- The server running on this computer shows a laptop everywhere — the sidebar
  and search as well as the dialog that adds it. The sidebar and search each
  chose the icon themselves; they now share one rule, so the next change lands
  in all three at once.
- The local server's setup log now fills as the work happens rather than all at
  once at the end. Every line Docker printed was applied to the screen on its
  own, and a pull narrates faster than the UI can redraw — so the renderer spent
  the whole install rebuilding the list instead of painting it. Lines are
  applied in batches now. The same fix covers a remote host's setup.
- Setting up the local server no longer looks stalled before Docker says
  anything. The output panel appeared only once the first line arrived, so the
  seconds Docker spends resolving the registry showed as an empty dialog; the
  panel is now there from the start and says what it is waiting for.
- The command palette no longer opens onto a "Notifications" list of sessions
  and rooms. It is a search field; the first thing under it should be what you
  searched for.
- Creating a room offers only the agents this Switch Console registered. The
  server answers with everyone on it, including agents belonging to another
  install — which this app cannot show under a room or drive.
- Creating a room switches the sidebar to its Rooms list and selects the new
  room. It was already opened in the main panel, but the sidebar stayed on
  Agents, which does not list rooms — so the room you had just made was nowhere
  in it.
- Installing a Switch connector now finishes the onboarding step it belongs to.
  The list of agent types you can onboard is cached separately from the agent's
  own status, and the install refreshed everything but that — so the step stayed
  unticked, and because the checklist locks each step behind the one above it,
  the rest of onboarding stayed greyed out with nothing explaining why.

#### Changed
- An update to an agent's own CLI is no longer reported as though something were
  wrong. It never gated anything, but an amber badge ahead of "Installed" read
  like a fault on an agent that worked, and it was the nearest explanation for
  onboarding appearing stuck. A newer CLI is now mentioned only on the agent's
  own page, in plain text with the command that installs it.
- The Switch connector's own updates keep their badge and gain a name —
  "Connector update" rather than "Update available". That one is worth acting
  on, and the two used to share a badge that could not say which was behind.

### [0.23.0] - 2026-08-14

#### Added
- **OpenCode is now a supported Switch agent type**, locally and on remote
  hosts. An OpenCode session can be onboarded as a Switch agent, join rooms,
  take injected prompts, and be reset, compacted or interrupted from a room.
  It reports working and completed rather than sitting on "awaiting input" for
  its whole life, and names the tool it is running on the bridged message.

  OpenCode has no plugin marketplace to install a connector from, so Switch
  Console writes one: the Switch MCP server is registered in OpenCode's global
  config as a local server, which lets the runtime inherit its credentials from
  the session environment rather than having a token written to disk, and the
  room-workflow skill is written to OpenCode's global skill directory beside
  it, so a session gets the instructions along with the tools. Install,
  update and uninstall are on the agent's card in Settings → Agents, and on a
  remote host in that host's setup, exactly as for the other agent types.

  OpenCode agents previously registered as Claude Code, so an operator asked to
  start one by hand was told to run `claude`. They now register as themselves.
- A Codex agent's configuration can now be changed after the agent is created,
  from the **Advanced configuration** section in its Settings tab — the same
  section Claude agents already had. Model, reasoning effort and instructions
  were previously write-once in the add-agent dialog, with no way to edit them
  (CHOO-1985); **verbosity**, **reasoning summary** and **web search** are newly
  exposed, and reasoning effort gains `none`. Each option was checked against the
  Codex binary's own config validation rather than assumed.
- Leaving one of those fields blank is not the same as choosing its default:
  blank omits the setting entirely, so your own `~/.codex/config.toml` still
  decides. That is why the on/off settings offer Default/On/Off rather than a
  checkbox, which has no way to say "leave it alone".
- Codex reads these values only when a session starts, so a save applies to the
  next session. A session already running is named in the section, with a
  Restart that resumes it on the new configuration. Clearing every field removes
  the agent's launch profile rather than leaving it orphaned.

#### Changed
- Advanced configuration is one editor for every provider rather than one per
  storage mechanism. Providers keep these settings in different places — a
  repo-agent definition for Claude Code, the launch profile for Codex — and the
  main process now routes the read and the write, so the difference is no longer
  visible as the shape of the Settings page.
- **Remote hosts** are a tab of Settings again rather than an entry in the left
  sidebar. Older saved navigation state, and the host page's way back, both land
  on the tab.
- The setup checklist on the welcome screen can now be dismissed. It shares the
  sidebar checklist's setting, so it goes away in both places at once and comes
  back from Settings → General.
- Settings descriptions for an agent's own options are cut back to a line, with
  the detail behind the ⓘ beside each one.
- The agent providers list no longer separates out a "recommended" group; each
  filter is a single list.
- The sidebar's ＋ opens a menu offering both "Add an agent" and "Create a
  room", instead of the single action matching the list you were looking at.
- The remote hosts page explains what a host is for, and links out to the
  cloud-hosting documentation.

#### Removed
- A batch of interface settings, along with the toggles for creating a branch
  and worktree, including issue context, and OS notifications. Each was already
  on by default and is now simply always on, so nothing changes for anyone who
  had not turned one off. Several of them — the left-sidebar line-change and
  PR-status toggles, the context bar, and confirm-on-tab-close — turned out to
  control nothing at all: no code read them.
- Keyboard shortcuts are no longer rebindable from Settings, and open-in tools
  can no longer be hidden. The shortcuts themselves are unchanged.

#### Fixed
- Add Agent no longer stalls with an unset agent type once more than one Switch
  connector is installed. The form auto-selected a type only when exactly one
  was available, so a second connector left it blank — and since the directory
  scan, the onboard-existing list and every submit button are gated on a chosen
  type, the rest of the dialog stayed inert behind a control that did not read
  as required. It now selects the only usable type, or the configured default
  agent when that is usable on the machine being targeted, and otherwise leaves
  the choice explicit. The rule no longer depends on how many agent types exist.
- The unread tally injected into a session no longer claims to count "since
  your last read_context". Nothing here can observe a session reading, so the
  tally is cleared per delivered line; it now says so, rather than inviting an
  agent to read its absence as proof it is caught up.
- The OpenCode icon no longer dwarfs the other agent icons. Its artwork is
  full-bleed and 4:5 where the others are glyphs on a square, and it carried its
  own `width`/`height` — which an inline SVG applies in preference to the size
  of the box it sits in. It is now square, unsized, and inset to the margin the
  others have.
- A file-based Switch connector reports the version its own directory declares
  rather than the app's. The OpenCode connector is versioned and released as its
  own artifact, so a card reading `0.22.0` beside two connectors reading `0.9.1`
  and `0.3.1` named nothing the connector declares. It also means an app release
  that leaves the connector alone no longer offers an update that would rewrite
  identical bytes.
- A session that fails to be created no longer marks its agent with a failure
  badge that cannot be cleared. The failed session exists only in the app — the
  server rejected the create — and nothing removed it: reloading only adds
  sessions, deleting one asks the server first and restores it when that fails,
  and the sidebar never listed it in the first place, so the badge pointed at a
  session there was no way to reach. It is now dismissed by clicking the badge.

### [0.22.1] - 2026-08-12

#### Changed
- Local-server mode now bundles and pulls **switch-core `0.13.2`** (was
  `0.13.1`): the bundle pin / `COMPATIBLE_SWITCH_VERSION` is raised to the
  current core release.

#### Fixed
- Windows builds now actually work — path handling, process spawning, the PTY,
  executable resolution, and Docker / managed-server invocation are corrected for
  Windows, so the x64 build introduced in `0.22.0` is functional rather than
  nominal (#207).
- Settings is reachable again. A retired Settings tab left in the view registry
  could be selected and then render nothing, stranding the whole Settings page;
  the retired tab is now handled and navigation falls back to a valid tab
  (CHOO-2106).

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

#### Fixed
- An environment naming an agent but carrying no token now resolves against the
  local agent store instead of refusing to start. Any partial `SWITCH_*`
  environment was treated as a broken config, but that is the exact shape a host
  settings file produces when the credential is deliberately kept out of the
  working tree — and Claude Code exports its settings `env` block into the
  process, MCP subprocesses included. Switch Console writes exactly that shape for its own
  agents, so a session started by hand in a directory it set up degraded to
  `switch_unavailable` with a perfectly good store on disk beside it. The
  `configure` skill used to write it too; it no longer does, so this is a safety
  net for the Switch Console case rather than how the standalone path works.

  The agent id makes the lookup exact, so nothing is guessed: an id that matches
  no store entry, one belonging to a different server, or one claimed by two
  entries at once all still refuse. A token missing either of the others also
  still refuses — inferring where to send a credential is a different order of
  risk from inferring which one to send.
- Refuses a *partly* expanded environment instead of filling the gap from disk.
  Some `${SWITCH_*}` still literal while others resolved means a substitution
  step did not finish, which is not the same as a value deliberately omitted —
  and silently completing it from the store would authenticate as whatever is on
  disk without saying so. All three unexpanded is still the host's ordinary
  pre-expansion spawn.
- `normalizeEndpoint` folds scheme and host case. It went from grouping
  endpoints for display to gating whether an identity binds, and a
  differently-cased host is the same server.

### [0.3.1] - 2026-08-12

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

### [Unreleased]

### [1.9.3]

#### Added
- The ready file carries a `deployer` field: the identity of the Switch Console
  install that started this sidecar, echoed from the environment it was
  launched with. It is the one thing on the host that says *whose* build is
  running — the content hash says only which. Purely additive, so no contract
  revision moves: an older client ignores the field, and a client reading a
  sidecar that omits it must treat that as unknown rather than as its own.
- Writes an agent's launch profile on the VM and completes the home-directory
  placeholder in its environment, so a provider that names a config file by
  absolute path (OpenCode's `OPENCODE_CONFIG`) launches correctly on a remote
  host. Additive — the client↔sidecar wire is unchanged, so the major stays `1`.

### [1.9.2]

#### Changed
- The remote session spawner now installs a provider's hooks whether they are
  delivered as config files or as a dropped plugin (OpenCode), mirroring the
  desktop side. A plugin-delivered provider previously launched on the VM with
  nothing installed and never reported that it stopped (#203). Behavior change
  only — the client↔sidecar wire (ready line, endpoints, on-disk layout) is
  unchanged, so the major stays at `1`.

### [1.9.1]

#### Changed
- Windows-compatible path and process handling in the session spawner, matching
  the desktop app's Windows fixes (#207). Behavior change only — the
  client↔sidecar wire (ready line, endpoints, on-disk layout) is unchanged, so
  the major stays at `1`.

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
- **The `configure` skill no longer breaks the standalone path it exists to set
  up.** It wrote `SWITCH_API_ENDPOINT` and `SWITCH_AGENT_ID` into
  `.claude/settings.local.json`, and Claude Code turns that `env` block into real
  environment variables for everything it spawns — so every session it configured
  started with two of the three values set. The runtime takes a complete
  environment or none at all and refuses anything in between, deliberately, so
  those sessions got no Switch tools whatsoever while the token sat unread in
  `.switch/agents/<name>.json` beside them. The skill now writes the store and
  nothing else, which is the mode the runtime already supports on every published
  version; Step 1 strips any `SWITCH_*` an earlier run left in either settings
  file, and Step 9 writes `permissions.allow` alone.
- The hook no longer skips mediation on a standalone install. It read its
  credentials from the environment only, and the `configure` skill deliberately
  keeps the token out of there, so it reported itself unconfigured and returned
  without reporting or mediating anything — silently, on every tool call. It now
  falls back to the same `.switch/agents/*.json` store the runtime reads, keyed
  on the agent id the session recorded when it joined a room, and names the
  cause on stderr when it cannot resolve one instead of skipping quietly.
- The runtime resolves an agent id carrying no token against the store rather
  than refusing outright. The skill no longer produces that state, but Switch
  Console writes the same two keys for its own agents, so a session started by
  hand in a directory Switch Console set up hit the identical dead end.
- The `configure` skill read a `401` from the health probe as the wrong server
  and sent the user off to find a different URL. The bridge authenticates
  everything but a few public routes, so a path left on the end of an otherwise
  correct base URL answers 401 rather than 404 — the host was right and only
  needed stripping back.
- The hook resolves an identity the same way the runtime does in three more
  cases, each of which let a session run while its governance quietly did not.
  It folds endpoint case, as the runtime does, so a differently-cased host no
  longer binds in one and matches nothing in the other. It refuses a partly
  unexpanded `${SWITCH_*}` environment instead of completing it from disk. And
  it refuses a token that is missing either of the other two, rather than
  substituting a different credential from the store while the session itself
  refuses to start — a test had asserted that substitution as correct.
- A failed mediation check says so. Any error reaching the bridge — a revoked
  token, an unreachable server, a timeout — was swallowed and the tool call
  proceeded with nothing printed, which is indistinguishable from approval. The
  call still proceeds, because a bridge outage must not wedge a session, but it
  now says on stderr that it was not checked.
- The `configure` skill no longer overwrites a credentials file that belongs to
  another Switch setup. Its script writes `.switch/agents/<name>.json` by name
  alone and truncated whatever was there, which in a directory shared with a
  Switch Console install (or an earlier run against a different server) destroyed
  a token that is issued once and stored nowhere else. It now stops before
  registering if that file names a different Switch server, and reports which —
  the same guard the Codex skill and Switch Console's own write paths got. The
  subagent step gets it too, over
  `.claude/switch-subagents/<name>.settings.json`: that path is Claude-only, so
  it was outside that sweep, and it is checked across the whole batch before the
  bulk registration, since refusing afterwards would strand every agent in it.

#### Changed
- The `configure` skill is rebuilt on the standalone shape the Codex connector
  uses: registering and writing the credentials are separate steps that still run
  as one command (the API key is returned once), the env-var expansion pitfall
  sits beside the request it applies to rather than after the script that trips
  on it, the heredoc wrapper is shown rather than described, and the server URL is
  probed before anything depends on it. It also writes `permissions.allow` for the
  connector's tools, which Switch Console always did and a skill-configured
  install went without — so every room action stopped for an approval prompt.
- The per-project vs global scope choice is gone. Global wrote the identity
  machine-wide, but credentials are only ever read from the session's working
  directory, so it behaved as per-project with extra steps.
- The skill no longer asks for or sends `notify_user`, which left the platform
  when owner-linked addressing arrived. It had survived here as a step collecting
  a value the server no longer reads.
- Both room-workflow skills list the full set of reasons `switch_unavailable`
  can be the only tool, and both now point at the `configure` skill as the remedy
  for the ones it can fix.

### [0.9.5] - 2026-08-18

#### Changed

- The room-workflow skill no longer teaches the task protocol as an interaction
  mode: the lifecycle section is replaced by a short note that the protocol
  exists, is registered on the server, and must not be called yet, and the
  guidance to delegate rather than message is removed. The scoped-addressing
  material moves to its own section. Documentation only — the MCP/HTTP tool
  surface is unchanged (CHOO-1418).

### [0.9.4] - 2026-08-15

#### Changed

- The room-workflow skill describes owner-only addressing — the new default for
  agents created in Switch Console — and states that `send_targeted_message`
  now fails outright for a disallowed sender, and that in-room commands are
  covered by the policy too (CHOO-2137).

### [0.9.3] - 2026-08-14

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
- The room workflow adds a Mattermost-only rule: post at the root there unless
  you were asked in a thread. Mattermost shows a threaded reply as a reply count
  under the original post rather than in the channel, so a first-time reader can
  take it for no answer. Threading is unchanged everywhere else.

### [0.9.2] - 2026-08-14
#### Changed
- The room-workflow skill lists `opencode` alongside `codex` and `claude-code`
  wherever it enumerates known agent types — the `list_agents` filter and the
  per-type options of `update_agent_detail` (#203). The plugin version bumps so
  installs re-download.

### [0.9.1] - 2026-08-12

#### Changed
- Pin `@sandboxaq/switch-agent-runtime@0.3.1` (was `0.3.0`) — picks up the
  runtime's conditional-read MCP instructions; the plugin version bumps so
  installs re-download.
- Skill: how to write in a room — answer first, plain words, a few sentences, one
  point per message — and post a one-line heads-up before going quiet for a long
  task, then return with the result in the same thread (#210).
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

#### Fixed
- The channel's unread tally now resets when the agent reads the room. The
  `PostToolUse` matcher never included `read_context`, so the reset the hook
  already implemented was unreachable and the count only ever climbed from the
  moment a session connected.

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
- Dropped the `configure` skill's Step 0, which installed the private-repo /
  `gh` setup machinery, now that the repository is public. The skill itself
  stays; an earlier version of this entry said it had been removed wholesale,
  which it had not.

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

### [0.3.6] - 2026-08-18

#### Changed

- The room-workflow skill no longer teaches the task protocol as an interaction
  mode: the lifecycle section is replaced by a short note that the protocol
  exists, is registered on the server, and must not be called yet, and the
  guidance to delegate rather than message is removed. The scoped-addressing
  material moves to its own section. Documentation only — the MCP/HTTP tool
  surface is unchanged (CHOO-1418).

#### Fixed

- The `configure` skill no longer overwrites a credentials file that belongs to
  another Switch setup. Its script writes `.switch/agents/<name>.json` by name
  alone and truncated whatever was there, which in a directory shared with a
  Switch Console install (or an earlier run against a different server) destroyed
  a token that is issued once and stored nowhere else. It now stops before
  registering if that file names a different Switch server, and reports which.

#### Changed
- Skill: list the full set of reasons `switch_unavailable` can be the only tool.
  The runtime is shared, so the identity failures added there apply here too;
  three of the six were missing.
- Skill: point at the `configure` skill as the remedy for the causes it can fix,
  rather than saying the state is unfixable from inside the session — the Codex
  `configure` skill shipped in 0.3.2, so the remedy now exists on both hosts.

### [0.3.5] - 2026-08-15

#### Changed

- The room-workflow skill describes owner-only addressing — the new default for
  agents created in Switch Console — and states that `send_targeted_message`
  now fails outright for a disallowed sender, and that in-room commands are
  covered by the policy too (CHOO-2137).

### [0.3.4] - 2026-08-14

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
- The room workflow adds a Mattermost-only rule: post at the root there unless
  you were asked in a thread. Mattermost shows a threaded reply as a reply count
  under the original post rather than in the channel, so a first-time reader can
  take it for no answer. Threading is unchanged everywhere else.

### [0.3.3] - 2026-08-14

#### Changed
- The room-workflow skill lists `opencode` alongside `codex` and `claude-code`
  wherever it enumerates known agent types — the `list_agents` filter and the
  per-type options of `update_agent_detail` (#203). The plugin version bumps so
  installs re-download.

### [0.3.2] - 2026-08-12

#### Added
- A `configure` skill: the standalone setup path. Registers this Codex instance
  as a Switch agent and writes `.switch/agents/<name>.json` in the working
  directory, so `codex` reaches Switch with no Switch Console involved
  (CHOO-1936). It writes no MCP config — the plugin's `.mcp.json` stays the
  single server definition and the runtime resolves its own identity from the
  store (`switch-agent-runtime` 0.2.0+).

### [0.3.1] - 2026-08-12

#### Changed
- Pin `@sandboxaq/switch-agent-runtime@0.3.1` (was `0.3.0`) — picks up the
  runtime's conditional-read MCP instructions; the plugin version bumps so
  installs re-download.
- Skill: how to write in a room — answer first, plain words, a few sentences, one
  point per message — and post a one-line heads-up before going quiet for a long
  task, then return with the result in the same thread (#210).
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

---

## switch-connector-opencode

`connectors/opencode-plugin/`. Version lives in `package.json`.

Unlike the other two connectors, nothing installs this one from a marketplace —
OpenCode has none. Switch Console writes its files directly, so the version is
for humans reading a diff rather than for an installer, and an install reports
the app version that wrote it rather than a version of its own.

### [Unreleased]

### [0.1.3] - 2026-08-18

#### Changed

- The room-workflow skill no longer teaches the task protocol as an interaction
  mode: the lifecycle section is replaced by a short note that the protocol
  exists, is registered on the server, and must not be called yet, and the
  guidance to delegate rather than message is removed. The scoped-addressing
  material moves to its own section. Documentation only — the MCP/HTTP tool
  surface is unchanged (CHOO-1418).

### [0.1.2] - 2026-08-15

#### Changed

- The room-workflow skill describes owner-only addressing — the new default for
  agents created in Switch Console — and states that `send_targeted_message`
  now fails outright for a disallowed sender, and that in-room commands are
  covered by the policy too (CHOO-2137).

### [0.1.1] - 2026-08-14

#### Changed
- The room-workflow skill covers Telegram: attachments cross the bridge as real
  uploads, chats cannot be created by a bot at all (so `create_room` fails there
  for every channel type), forum topics thread natively, and formatting has no
  tables and a 4096-character cap (CHOO-1686). It also warns that a Telegram
  room may be mention-only, where unaddressed talk never reaches Switch at all
  and `read_context` cannot recover it. The slash-command and attachment
  platform lists now also name Discord.
- The room workflow adds a Mattermost-only rule: post at the root there unless
  you were asked in a thread. Mattermost shows a threaded reply as a reply count
  under the original post rather than in the channel, so a first-time reader can
  take it for no answer. Threading is unchanged everywhere else.

### [0.1.0] - 2026-08-14

First release. Ships the Switch room-workflow skill, registers the Switch MCP
server in OpenCode's global config as a local server — so the runtime takes its
credentials from the session environment and none is written to disk — and
carries a reporting plugin that gives OpenCode sessions real working and
completed states, naming the tool a turn is currently running.

# Collaboration bridge setup

A **collaboration bridge** is a two-way relay between an external chat platform
(Slack, Mattermost, Microsoft Teams, Discord, Telegram) and Switch's internal Matrix
rooms. Humans talk in their normal chat client; Switch agents see those messages
as room events and reply back into the same channel. Each external channel maps
to a Switch room, and each Switch agent is presented in the channel under its own
name and avatar.

This directory documents how to set up each bridge. Read this page first for the
shared onboarding model, then the per-platform guide:

| Platform | Guide | Identity model | Inbound transport | Public ingress |
| --- | --- | --- | --- | --- |
| Slack | [`SLACK_SETUP.md`](SLACK_SETUP.md) | single bot app | Socket Mode (outbound WS) | not required |
| Mattermost | [`MATTERMOST_SETUP.md`](MATTERMOST_SETUP.md) | one bot account per agent | WebSocket (outbound) | not required |
| Microsoft Teams | [`TEAMS_SETUP.md`](TEAMS_SETUP.md) | single Azure bot app | HTTP push (Bot Framework + Graph) | **required** |
| Discord | [`DISCORD_SETUP.md`](DISCORD_SETUP.md) | single bot app | Gateway WebSocket (outbound) | not required |
| Telegram | [`TELEGRAM_SETUP.md`](TELEGRAM_SETUP.md) | single bot, name in the message body | long polling (outbound) | not required |

## The onboarding model (same for every bridge)

A bridge is an **unowned, workspace-wide integration** that holds platform
credentials. Registering one is therefore an **admin-only** action. All
credentials live per-bridge in the bridge's stored `connection_config` (a JSONB
column) — **never** in global environment/config. Onboarding one platform never
touches another.

Onboard a bridge from the **operator dashboard**: **Messaging Apps → Register
messaging app**, pick the platform, and fill in the form. The form is rendered
from the bridge type's config schema, so it always asks for exactly the fields
that type needs — the per-platform guides below describe those fields in prose
so you know what to gather beforehand.

On save the bridge is created, its platform client starts, and identities are
provisioned lazily as channels are used. The dashboard also lists existing
bridges and lets you edit or remove them.

**Adding the app to a chat.** Where the platform can express that as a single
URL that works everywhere, the bridge's row offers an **Add to a chat** link:
pick the chat, confirm, done. Telegram has one, for groups; the other platforms
show nothing, and their app is installed through the platform's own admin UI as
their guide describes. The links are built by the running bridge, so they appear
only while it is up, and only for an admin.

### Registered bridge types

`slack`, `mattermost`, `teams`, `discord`, `telegram`. The dashboard's registration
form lists the live set and the fields each one requires.

## Once a bridge is live

- **Rooms.** Depending on the platform, a Switch room is created for a channel
  either when the bot is added to it (Slack, Mattermost, Teams, Telegram) or
  lazily on the first bridged message (Discord — it has no "app added to channel"
  signal). Existing Switch rooms can also be bound to a channel at room-creation
  time. See **Channel creation** below for the other direction — Switch making
  the channel — which not every connection can or may do.
- **Addressing agents.** Users `@mention` an agent by name in the channel to
  address it; unaddressed chatter is bridged as context. In-room commands (e.g.
  `!invite-agent`) work on every platform. Slack, Discord and Telegram
  additionally expose them as **native slash commands** (`/invite-agent`) routed
  into the same handler — declared in the app manifest on Slack, registered
  automatically per guild on Discord, and accepted alongside `!` on Telegram,
  where `/` is the platform's own convention.
- **"Open in Switch Console" links.** Agents surface a `switchdash://…` deeplink with
  their runtime status. Platforms that only render `http(s)` links (Discord and
  Telegram) need `GATEWAY_PUBLIC_URL` set so Switch can rewrite it to a clickable
  `https://<switch-api-host>/deeplink/session?…` redirect; the bridge logs a
  warning at startup when one of those platforms is running without it. Unset,
  the address is posted as tap-to-copy text rather than as a link the platform
  would silently discard. See the Discord or Telegram guide.

### Channel creation

Creating a Switch room normally creates the channel to go with it. Whether a
connection will do that has two halves, and both must be true:

- **Can the platform?** A fixed fact about the platform, not a setting.
  Telegram is the one that cannot: the Bot API has no call to create a chat, so
  a Telegram chat is always made in a Telegram client and adopted. Every other
  platform can.
- **May this connection?** A per-connection switch, set when you register a
  messaging app and changeable afterwards on its row in **Messaging Apps**.
  It defaults on. Turn it off where the bot holds no such permission on the
  platform, or where channels are meant to be made by people rather than
  appearing from Switch. It can only ever narrow the first half — a connection
  cannot be granted an ability its platform does not have, and trying is
  refused rather than stored.

The answer reaches everyone who acts on it. The dashboard and Switch Console do
not offer "create a new channel" for a connection that will not, and say which
of the two reasons applies. `list_bridges` carries `can_create_channels`, so an
agent can pick a bridge that works rather than discovering it by failing. And a
create that is refused is a `400` explaining what to do instead — make the
channel on the platform, add the app to it, and Switch adopts it as a room.

## Deployment knobs

Most bridge configuration is per-bridge (in `connection_config`). A few things
are deployment-level environment config on switch-core:

- **`GATEWAY_PUBLIC_URL`** — the Switch API's public origin (scheme + host only,
  no path): the same host Switch Console reports as its `server`, and distinct from
  the operator UI. Used to build the clickable deeplink redirect, which is served
  at `/deeplink/session` on the API root (the agent-bridge app), **not** under the
  `/gateway` mount — so front it with a proxy that routes the API root, not only
  `/gateway/*`. Leave unset to post the raw `switchdash://` deeplink (the
  disclosed fallback). Applies to every platform, and is **required** on
  Discord, Telegram and Teams, which render only http(s) links — Teams goes
  further and strips a link on any other scheme entirely, label included, so
  without this the deeplink renders as empty brackets.
- **Teams** additionally needs public HTTPS ingress to the bridge's listener, on
  its own port — it is the only bridge Switch does not reach outbound. See
  [`TEAMS_SETUP.md`](TEAMS_SETUP.md) for the bridge side, and the Helm chart's
  [README](../../deploy/remote/helm/switch/README.md) for which Switch surfaces
  have to be reachable from where.

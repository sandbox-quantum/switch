# Microsoft Teams collaboration bridge

Integrates Switch with Microsoft Teams alongside Slack and Mattermost, following
the same adapter contract (`../adapter.py`). This note covers the Teams-specific
architecture, the ops prerequisites, and the per-bridge configuration. A Teams
workspace is connected **per bridge through the gateway** — all credentials live
in the bridge's stored `connection_config`, never in global/env config.

> For the operator-facing **setup walkthrough** (Azure prerequisites, onboarding
> request, and how Teams fits alongside the other bridges), see
> [`docs/bridges/TEAMS_SETUP.md`](../../../../../docs/bridges/TEAMS_SETUP.md).
> This note focuses on the adapter's internal architecture.

## Architecture

Teams has no persistent bot socket (unlike Slack Socket Mode / Mattermost
WebSocket), so the adapter uses two Microsoft APIs and hosts its own HTTP
listener:

- **Bot Framework** (outbound + partial inbound). Outbound messages post via the
  Bot Connector REST API at the per-tenant `serviceUrl`. Inbound activities (1:1
  and group chats in full; channel messages only when the bot is @mentioned;
  conversation/member updates) arrive at `POST /api/messages`, where the JWT the
  Bot Connector attaches is verified before the activity is trusted.
- **Microsoft Graph change notifications** (full channel capture). To see *every*
  channel message — not just @mentions — the adapter subscribes to
  `teams/{team}/channels/{channel}/messages` per channel. Graph delivers
  encrypted resource data to `POST /api/teams/notifications`; the adapter
  verifies `clientState`, decrypts, and renews subscriptions before their
  ~60-minute expiry.

**Identity model:** a single Azure bot backs every Switch agent (like Slack).
Each agent's messages render as an **Adaptive Card** headed with the agent's name
and avatar. Human users map to Matrix puppets keyed on their AAD object id. Both
inbound paths funnel through one delivery + de-duplication path (keyed on the
Teams message id); the bot's own posts are dropped to prevent loops.

**Threading** depends on the channel's Graph `layoutType`, read once per channel
by the same call that resolves its display name. A `chat`-layout channel is a
stream and gets the ordinary policy every other adapter uses: no thread named
means the channel root. A `post`-layout channel is a list of conversations, so
an untied outbound message is steered into the post the channel was last seen
speaking in — otherwise an answer starts a new conversation instead of landing
under the question. The Bot Framework activity carries nothing about layout,
and listing a team's channels reports `layoutType` as null for all of them, so
the per-channel read is the only route; an unreadable layout is treated as
`post`, Graph's own default.

**Runtime status** is retired differently per layout, for the same reason.
Teams substitutes *"This message has been deleted."* for a deleted message in a
`post`-layout channel and keeps it in the post, so there the status card is
never deleted: it is edited into a `✓ Done · <elapsed>` marker, and it is not
repositioned either (a move is a repost plus a delete). A `chat`-layout channel
deletes cleanly and keeps the ordinary behaviour. Mattermost does the same
thing for the same reason — see `_apply_runtime_state` there.

## Security note

Graph resource-data encryption proves message **integrity, not origin** (the
wrapping key is the public certificate, which anyone can encrypt to). The
`clientState` shared secret is therefore the only control that authenticates a
notification's origin, so it is **required** and validated on every notification —
data and lifecycle events alike. Inbound Bot Framework activities are separately
authenticated by verifying the Bot Connector JWT.

## Ops prerequisites (must exist before onboarding)

**This is a checklist of what must exist, not instructions for producing it.**
For the steps —  which portal blade, which button, in what order — follow
[`docs/bridges/TEAMS_SETUP.md`](../../../../../docs/bridges/TEAMS_SETUP.md),
whose Part 1 covers these one for one.

Environment/tenant setup owned by an administrator — track as a separate ops task.

1. **Azure AD app registration** providing the bot's `app_id` (client id), a
   client secret (`app_password`), and the `tenant_id`.
2. **Azure Bot resource** against that app, with the **messaging endpoint** set
   to `https://<public-host>/api/messages` and the **Microsoft Teams channel**
   enabled.
3. **Teams app package** (manifest plus its two icons) including the bot,
   installed into the target team so it can be added to channels and post
   proactively. A ready-made one ships at
   [`docs/bridges/teams-app/`](../../../../../docs/bridges/teams-app/).
4. **Graph API permissions** with admin consent, for channel capture +
   provisioning: `ChannelMessage.Read.Group` (RSC, preferred) *or* tenant-wide
   `ChannelMessage.Read.All`; plus `Channel.Create`, `Channel.ReadBasic.All`,
   `User.ReadBasic.All`, and `TeamMember.ReadWrite.All` /
   `ChannelMember.ReadWrite.All`. Resource-data subscriptions count against a
   shared per-tenant Teams subscription quota.
5. *(nothing to do)* The X.509 keypair Graph resource data is encrypted to is
   generated on bridge creation. Listed only so its absence is not mistaken for
   an omission; a supplied set still wins if all three fields are given.
6. **Public HTTPS ingress** routing `https://<public-host>/api/messages` and
   `/api/teams/notifications` to the bridge's listener. Graph requires valid TLS
   and a response to its validation handshake within 10 seconds.

## Per-bridge configuration (`TeamsConnectionConfig`)

Onboard through the gateway (collaboration bridge create). Admin-supplied fields:

- **`app_id`**, **`app_password`**, **`tenant_id`** — Azure AD app registration.
- **`team_id`** — the AAD team (group) id outbound-created channels go into.
- **`public_base_url`** — the public HTTPS base the listener is reachable at (used
  to build the `/api/teams/notifications` URL given to Graph).

Generated on creation, and hidden from the form: **`client_state`** (the shared
secret validated on every notification — see Security note) and the encryption
trio **`encryption_certificate_id`**, **`encryption_public_certificate`**,
**`encryption_private_key`**. A supplied set still wins, but all three or none;
a partial set is rejected.

Switch-internal fields are **not** admin inputs and are hidden too: the listener
bind (`listen_host`/`listen_port`, default `0.0.0.0:3978`) is a deployment
detail Switch owns, and `service_url` is learned at runtime and persisted
automatically. An operator can still override the bind via the stored
`connection_config` when running more than one Teams bridge on a host.

A bridge created before Switch generated this material may hold no encryption
material at all. It still runs — outbound, chats and @mention capture work —
but per-channel Graph subscriptions are skipped and an error is logged.

## Known limitations / follow-ups

- **Switch-initiated DM rooms** are user-initiated (as on Mattermost);
  bootstrapping one bot-side needs proactive app installation via Graph.
- **Attachments** (inbound media and outbound files) are currently **disclosed,
  not relayed**: the message text bridges and a note names the un-relayed media.
  Native relay is a tenant-validated follow-up.
- **An outbound @mention is real only for someone Switch can address** — a
  person who has linked their Teams account, whose AAD object id Switch
  therefore holds. Everyone else, and every agent, bridges as plain `@name`
  text.
- **In a posts-layout channel, an untied reply lands in the post the channel
  last spoke in** (see Threading above) — wrong when two conversations run in
  one channel at once. Teams offers nothing better to key on.
- **Private and shared channels** need a manifest at v1.25 or later declaring
  `supportsChannelFeatures: tier1` before the app can be added to them, and
  Graph refuses message subscriptions on them for RSC-consented apps.
- **One Teams bridge per listener port** — run multiple Teams bridges on distinct
  ports (and ingress routes) if needed.

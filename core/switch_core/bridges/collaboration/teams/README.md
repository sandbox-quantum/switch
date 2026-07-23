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

## Security note

Graph resource-data encryption proves message **integrity, not origin** (the
wrapping key is the public certificate, which anyone can encrypt to). The
`clientState` shared secret is therefore the only control that authenticates a
notification's origin, so it is **required** and validated on every notification —
data and lifecycle events alike. Inbound Bot Framework activities are separately
authenticated by verifying the Bot Connector JWT.

## Ops prerequisites (must exist before onboarding)

Environment/tenant setup owned by an administrator — track as a separate ops task.

1. **Azure AD app registration** providing the bot's `app_id` (client id), a
   client secret (`app_password`), and the `tenant_id`.
2. **Azure Bot resource** against that app, with the **messaging endpoint** set
   to `https://<public-host>/api/messages` and the **Microsoft Teams channel**
   enabled.
3. **Teams app package** (manifest) including the bot, installed into the target
   team so it can be added to channels and post proactively.
4. **Graph API permissions** with admin consent, for channel capture +
   provisioning: `ChannelMessage.Read.Group` (RSC, preferred) *or* tenant-wide
   `ChannelMessage.Read.All`; plus `Channel.Create` and
   `TeamMember.ReadWrite.All` / `ChannelMember.ReadWrite.All`. Resource-data
   subscriptions count against a shared per-tenant Teams subscription quota.
5. **Encryption certificate** for Graph resource data: an X.509 cert whose public
   certificate is handed to Graph and whose private key the bridge holds to
   decrypt message bodies. Give it a stable id.
6. **Public HTTPS ingress** routing `https://<public-host>/api/messages` and
   `/api/teams/notifications` to the bridge's listener. Graph requires valid TLS
   and a response to its validation handshake within 10 seconds.

## Per-bridge configuration (`TeamsConnectionConfig`)

Onboard through the gateway (collaboration bridge create). Admin-supplied fields:

- **`app_id`**, **`app_password`**, **`tenant_id`** — Azure AD app registration.
- **`team_id`** — the AAD team (group) id outbound-created channels go into.
- **`public_base_url`** — the public HTTPS base the listener is reachable at (used
  to build the `/api/teams/notifications` URL given to Graph).
- **`client_state`** — required shared secret (see Security note).
- **`encryption_certificate_id`**, **`encryption_public_certificate`** (PEM),
  **`encryption_private_key`** (PEM) — required for channel-message capture.

Switch-internal fields are **not** admin inputs and are hidden from the gateway
form: the listener bind (`listen_host`/`listen_port`, default `0.0.0.0:3978`) is a
deployment detail Switch owns, and `service_url` is learned at runtime and
persisted automatically. An operator can still override the bind via the stored
`connection_config` when running more than one Teams bridge on a host.

Without the encryption fields the bridge still runs (outbound, chats, and
@mention capture work), but per-channel Graph subscriptions are skipped and an
error is logged — full channel capture is disabled until they are supplied.

## Known limitations / follow-ups

- **Switch-initiated DM rooms** are user-initiated (as on Mattermost);
  bootstrapping one bot-side needs proactive app installation via Graph.
- **Attachments** (inbound media and outbound files) are currently **disclosed,
  not relayed**: the message text bridges and a note names the un-relayed media.
  Native relay is a tenant-validated follow-up.
- **Real outbound @mentions** are not yet emitted (needs a display-name → AAD id
  directory); mention text bridges as plain `@name`.
- **One Teams bridge per listener port** — run multiple Teams bridges on distinct
  ports (and ingress routes) if needed.

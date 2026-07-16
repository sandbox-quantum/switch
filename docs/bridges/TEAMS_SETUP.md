# Microsoft Teams collaboration bridge — setup & operations

The Teams bridge integrates Switch with Microsoft Teams as a collaboration
bridge, alongside Slack and Mattermost. It follows the same adapter contract
(`switch_core/bridges/collaboration/adapter.py`); this document covers the
Teams-specific architecture, the **ops prerequisites** that must exist before a
bridge can be onboarded, and the per-bridge configuration.

## Architecture

Teams has no persistent bot socket (unlike Slack Socket Mode / Mattermost
WebSocket), so the adapter uses two Microsoft APIs and hosts its own HTTP
listener:

- **Bot Framework** (outbound + partial inbound). Outbound messages are posted
  via the Bot Connector REST API at the per-tenant `serviceUrl`. Inbound Bot
  Framework activities (1:1 and group chats in full; channel messages only when
  the bot is @mentioned; conversation/member updates) arrive at `POST
  /api/messages`.
- **Microsoft Graph change notifications** (full channel capture). To see
  *every* channel message — not just @mentions — the adapter subscribes to
  `teams/{team}/channels/{channel}/messages` per channel (option A: scoped to
  channels the bot is in). Graph delivers encrypted resource data to `POST
  /api/teams/notifications`; the adapter decrypts it and renews the
  subscriptions before their ~60-minute expiry.

**Identity model:** a single Azure bot backs every Switch agent (like Slack, not
Mattermost). Each agent's messages are rendered as an **Adaptive Card** whose
header carries the agent's name and avatar. Human users are mapped to Matrix
puppets keyed on their AAD object id, as with the other bridges.

Both inbound paths funnel through one delivery + de-duplication path (keyed on
the Teams message id), and the bot's own posts are dropped to prevent loops.

## Ops prerequisites (must exist before onboarding)

These are environment/tenant setup steps owned by an administrator — the bridge
code assumes they are in place. **Track these as a separate ops task.**

1. **Azure AD app registration** (single- or multi-tenant) providing the bot's
   `app_id` (client id), a client secret (`app_password`), and the `tenant_id`.
2. **Azure Bot resource** registered against that app, with the **messaging
   endpoint** set to `https://<public-host>/api/messages` and the **Microsoft
   Teams channel** enabled.
3. **Teams app package** (manifest) that includes the bot, installed into the
   target team so the bot can be added to channels and post proactively.
4. **Graph API permissions** with admin consent, for channel-message capture:
   - `ChannelMessage.Read.Group` (RSC, resource-specific consent) *or* the
     tenant-wide `ChannelMessage.Read.All` — RSC is preferred (narrower).
   - `Channel.Create`, `TeamMember.ReadWrite.All` / `ChannelMember.ReadWrite.All`
     for provisioning channels and membership.
   - Subscriptions with resource data count against a shared per-tenant Teams
     subscription quota.
5. **Encryption certificate** for Graph resource data: an X.509 cert whose
   **public** certificate is handed to Graph (`encryption_public_certificate`)
   and whose **private key** (`encryption_private_key`) the bridge holds to
   decrypt message bodies. Give it a stable id (`encryption_certificate_id`).
6. **Public HTTPS ingress** routing `https://<public-host>/api/messages` and
   `/api/teams/notifications` to the bridge's listener (`listen_host` /
   `listen_port`, default `:3978`). Graph requires a valid TLS cert and a
   response to its validation handshake within 10 seconds.

## Per-bridge configuration

Onboard via the collaboration bridge REST surface (`POST /collab/bridges`,
`type: "teams"`). The `connection_config` is validated against
`TeamsConnectionConfig`:

- **`app_id`**, **`app_password`**, **`tenant_id`** — Azure AD app registration.
- **`team_id`** — the AAD team (group) id that outbound-created channels are
  provisioned into.
- **`public_base_url`** — the public HTTPS base the listener is reachable at
  (used to build the `/api/teams/notifications` URL given to Graph).
- **`listen_host`** / **`listen_port`** — local bind for the listener (default
  `0.0.0.0:3978`).
- **`encryption_certificate_id`**, **`encryption_public_certificate`** (PEM),
  **`encryption_private_key`** (PEM) — required for channel-message capture.
- **`client_state`** — shared secret echoed in every change notification and
  validated on receipt.
- **`public_url`** — optional user-facing deeplink base.

Without the encryption fields the bridge still runs (outbound, chats, and
@mention capture work), but per-channel Graph subscriptions are skipped and a
warning is logged — full channel capture is disabled until they are supplied.

## Known limitations / follow-ups

- **Switch-initiated DM rooms.** Inbound 1:1 chats work (the bot replies in
  DMs). Creating a brand-new DM *from Switch* is currently user-initiated (as on
  Mattermost); bootstrapping one bot-side needs proactive app installation via
  Graph — tracked as a follow-up.
- **Inbound image attachments.** Teams delivers channel images as Graph
  `hostedContents` needing separate authenticated fetches; attachment ingestion
  is a follow-up.
- **One Teams bridge per listener port.** Each bridge binds its own
  `listen_port`; run multiple Teams bridges on distinct ports (and ingress
  routes) if needed.

# Microsoft Teams collaboration bridge setup

Connects a Microsoft Teams tenant to Switch. A **single Azure bot app** backs
every Switch agent (like Slack); each agent's messages render as an **Adaptive
Card** headed with the agent's name and avatar.

Teams is the only bridge that **requires public HTTPS ingress**: it has no
persistent bot socket, so the adapter hosts its own HTTP listener and Microsoft
pushes events to it.

> This guide is the operator-facing setup walkthrough. The in-package note at
> [`core/switch_core/bridges/collaboration/teams/README.md`](../../core/switch_core/bridges/collaboration/teams/README.md)
> covers the adapter's internal architecture (Bot Framework + Graph capture,
> encryption, de-duplication) in more depth.

## Architecture in brief

Two Microsoft APIs feed the bridge, both landing on the adapter's own listener:

- **Bot Framework** — outbound messages post via the Bot Connector REST API at
  the per-tenant `serviceUrl`. Inbound activities (1:1 and group chats in full;
  channel messages only when the bot is `@mentioned`; membership updates) arrive
  at `POST /api/messages`. The Bot Connector JWT is verified before an activity
  is trusted.
- **Microsoft Graph change notifications** — to capture *every* channel message
  (not just `@mentions`), the adapter subscribes per channel and Graph delivers
  **encrypted** resource data to `POST /api/teams/notifications`. The adapter
  validates the `clientState` secret, decrypts with its private key, and renews
  subscriptions before their ~60-minute expiry.

## Ops prerequisites (must exist before onboarding)

These are tenant/environment setup owned by an administrator — treat as a
separate ops task before you can onboard the bridge.

1. **Azure AD app registration** — provides the bot's `app_id` (client id), a
   client secret (`app_password`), and the `tenant_id`.
2. **Azure Bot resource** on that app, with the **messaging endpoint** set to
   `https://<public-host>/api/messages` and the **Microsoft Teams channel**
   enabled.
3. **Teams app package** (manifest) including the bot, installed into the target
   team so it can be added to channels and post proactively.
4. **Graph API permissions** (admin-consented) for channel capture +
   provisioning: `ChannelMessage.Read.Group` (RSC, preferred) *or* tenant-wide
   `ChannelMessage.Read.All`; plus `Channel.Create` and
   `TeamMember.ReadWrite.All` / `ChannelMember.ReadWrite.All`. Resource-data
   subscriptions count against a shared per-tenant Teams subscription quota.
5. **Encryption certificate** — an X.509 cert whose public certificate is handed
   to Graph and whose private key the bridge holds to decrypt message bodies.
   Give it a stable id.
6. **Public HTTPS ingress** routing `https://<public-host>/api/messages` and
   `/api/teams/notifications` to the bridge's listener. Graph requires valid TLS
   and a response to its validation handshake within 10 seconds.

## Onboard the bridge in Switch

As a gateway admin, onboard the bridge from the **operator dashboard**:
**Messaging Apps → Add bridge → Teams**, give it a display name (e.g. "Acme
Teams"), and fill in the fields below.

Fields (`TeamsConnectionConfig`):

| Field | Required | Description |
| --- | --- | --- |
| `app_id` | yes | Azure AD app (bot) client id. |
| `app_password` | yes | Azure AD app client secret. |
| `tenant_id` | yes | Azure AD tenant id. |
| `team_id` | yes | AAD team (group) id that outbound-created channels go into. |
| `public_base_url` | yes | Public HTTPS base the listener is reachable at (used to build the `/api/teams/notifications` URL given to Graph). |
| `client_state` | yes | Shared secret echoed in every Graph notification and validated on receipt — the only control that authenticates a notification's origin. |
| `encryption_certificate_id` | for channel capture | Stable id for the Graph resource-data encryption cert. |
| `encryption_public_certificate` | for channel capture | PEM public certificate handed to Graph. |
| `encryption_private_key` | for channel capture | PEM private key used to decrypt message bodies. |

Switch-internal fields are **not** admin inputs and are hidden from the gateway
form:

- `listen_host` / `listen_port` (default `0.0.0.0:3978`) — the listener bind, a
  deployment detail. Override via the stored `connection_config` only when
  running more than one Teams bridge on a host (one bridge per listener port).
- `service_url` — the Bot Connector outbound endpoint, learned at runtime from
  inbound activities and persisted automatically.

Without the three encryption fields the bridge still runs (outbound, chats, and
`@mention` capture work), but per-channel Graph subscriptions are skipped and an
error is logged — **full channel capture is disabled until they are supplied**.

## Security note

Graph resource-data encryption proves message **integrity, not origin** (the
wrapping key is the public certificate, which anyone can encrypt to). The
`clientState` shared secret is therefore **required** and validated on every
notification. Inbound Bot Framework activities are separately authenticated by
verifying the Bot Connector JWT.

## Known limitations / follow-ups

- **Switch-initiated DM rooms** are user-initiated (as on Mattermost);
  bootstrapping one bot-side needs proactive app installation via Graph.
- **Attachments** (inbound media and outbound files) are currently **disclosed,
  not relayed** — the text bridges and a note names the un-relayed media.
- **Real outbound `@mentions`** are not yet emitted (needs a display-name → AAD
  id directory); mention text bridges as plain `@name`.
- **One Teams bridge per listener port** — run multiple on distinct ports (and
  ingress routes) if needed.

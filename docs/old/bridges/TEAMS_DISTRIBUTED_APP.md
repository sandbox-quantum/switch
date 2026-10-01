# The distributed Teams app

`TEAMS_SETUP.md` describes the app **an operator registers for themselves**:
they create an Entra app and an Azure Bot in their own directory, grant it
permissions, upload an app package into their own Teams, and paste five values
into Switch. This page describes the other one — the app **we** register once
per environment, which a customer's Microsoft admin approves for their
organisation from Switch, and which never requires them to touch Azure.

They are two separate Microsoft apps and they will both exist. Nothing here
replaces the other page.

The install connects a Microsoft organisation (a directory, or **tenant** in
Microsoft's terms) to a Switch workspace that **already exists**. The flow
begins with an authenticated admin inside the workspace they are connecting,
so nothing in Microsoft's screens can bring a workspace into being.

## Why it cannot be the same app

The bring-your-own app runs entirely inside the customer's directory: its
credential reaches only that organisation, its bot listens on its own port,
and every activity it receives is its own. A distributed app has none of that:

- **Microsoft grants no credential per install.** Approving the app gives the
  one app we registered access to the organisation; Switch mints that
  organisation's tokens with the app's own credential when it needs them. So
  the credential is deployment config (`TEAMS_APP_*`), never stored against an
  install, and an install records no token — like Discord's.
- **One bot, one messaging endpoint.** An Azure Bot has exactly one messaging
  address, so every organisation's activities arrive at the same URL, and each
  is routed by the organisation it carries. Graph's change notifications do
  the same.
- **New "multi-tenant" Azure Bot resources cannot be created.** Microsoft
  stopped allowing them after 31 July 2025. The supported shape is a
  **SingleTenant** Azure Bot in our own directory, backed by an Entra app
  registered for **any organizational directory**. Bot Connector tokens for it
  are only ever issued in our own directory; Graph tokens are issued in each
  customer's.

## The two public URLs

Both arrive under the public `/messaging` prefix at `MESSAGING_PUBLIC_URL`
(scheme and host, https, no path):

| Where | Path |
| --- | --- |
| Azure Bot → Configuration → **Messaging endpoint** | `/messaging/teams/events` |
| Entra app → Authentication → **Redirect URI** (Web) | `/messaging/teams/oauth/callback` |

Graph's notification URL, `/messaging/teams/notifications`, is set by Switch
when it subscribes and needs no registration. Add `/messaging` to the ingress
path allowlist (`ingress.agentApiPaths` in the chart), or the URLs exist and
nothing routes to them. The bring-your-own path keeps its own listener on port
3978; the distributed app uses none.

## Registering the app (once per environment)

**One app and one bot per environment, never shared.** A bot has one messaging
address, and Switch deletes Graph subscriptions that point anywhere but its
own, so two environments on one app would take each other's traffic and wipe
each other's capture.

1. **Entra app registration.** Supported account types: **Accounts in any
   organizational directory**. Record the **Application (client) ID**
   (`TEAMS_APP_CLIENT_ID`) and **Directory (tenant) ID** (`TEAMS_APP_TENANT_ID`).
2. **Redirect URI** (platform Web): `https://<MESSAGING_PUBLIC_URL>/messaging/teams/oauth/callback`.
3. **Token configuration.** Emit **directory roles** in tokens — in the
   manifest, `"groupMembershipClaims": "DirectoryRole"` — so Switch can see
   that the person approving holds an admin role. Add the optional ID-token
   claim **`tenant_region_sub_scope`**, so a government-cloud organisation is
   refused at approval rather than half-installed.
4. **API permissions — Microsoft Graph, application:**

   | Permission | Why |
   | --- | --- |
   | `ChannelMessage.Read.All` | Every channel message, including private channels and other bots' posts |
   | `Channel.Create` | Create channels for new rooms |
   | `Channel.ReadBasic.All` | Channel names and layout; proving a channel is the organisation's |
   | `TeamMember.ReadWriteNonOwnerRole.All` | Add people to a team |
   | `ChannelMember.ReadWrite.All` | Add people to private channels |
   | `User.ReadBasic.All` | Find people in the organisation |
   | `Team.ReadBasic.All` | List the organisation's teams |
   | `TeamsAppInstallation.ReadWriteSelfForTeam.All` | Add Switch to, and remove it from, teams |

   **Delegated:** `openid`, `profile`, `User.Read` (the organisation's name) and
   `AppCatalog.ReadWrite.All` (putting the app in the organisation's Teams app
   list). Do **not** grant admin consent here — each customer's admin grants it
   for their own organisation.
5. **Credential — exactly one:**
   - **Federated (recommended):** a federated credential trusting the
     cluster's service-account issuer, subject
     `system:serviceaccount:<namespace>:<service account>`, audience
     `api://AzureADTokenExchange`. No secret exists. In the chart,
     `switchCore.teamsApp.credential: federated` mounts the projected token.
   - **Certificate:** upload the public certificate; give Switch the
     certificate and its key (`TEAMS_APP_CERTIFICATE`,
     `TEAMS_APP_CERTIFICATE_PRIVATE_KEY`).
   - **Client secret:** simplest, for local development; it expires.
6. **Azure Bot resource.** Type of app: **Single Tenant**, using the app above.
   Messaging endpoint as in the table. Under **Channels**, enable **Microsoft
   Teams**.
7. **Notification keypair.** An RSA keypair Graph encrypts captured messages
   to, as PEM (`TEAMS_APP_NOTIFICATION_CERTIFICATE`,
   `TEAMS_APP_NOTIFICATION_PRIVATE_KEY`). Self-signed is fine; Graph uses it
   only to carry a key. For example:

   ```sh
   openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=switch-teams" \
     -keyout notification.key -out notification.crt
   ```

   To rotate: set the new pair, move the old private key to
   `TEAMS_APP_NOTIFICATION_PREVIOUS_PRIVATE_KEY`, restart, and remove it once
   the subscriptions made against it have run out (an hour).
8. **Privacy and terms pages.** Every Teams app package names both, and the
   approving admin is shown them (`TEAMS_APP_PRIVACY_URL`,
   `TEAMS_APP_TERMS_URL`, https).
9. **Publisher verification** (Partner Center). Without it, Microsoft's
   approval screen shows the app as unverified, which makes IT teams more
   likely to refuse. A Teams Store listing also requires it.

All of these are required together; a partial configuration is refused at
startup. Setting `TEAMS_APP_CLIENT_ID` is what enables the button.

## What a customer's install produces

1. A workspace admin clicks **Add to Microsoft Teams** in Switch.
2. A Microsoft admin signs in and approves Switch for the organisation — one
   screen, with **Consent on behalf of your organization** ticked.
3. Switch records nothing until it has proved three things: the ID token
   Microsoft signed names the organisation and is issued by it; the person
   holds **Global Administrator** or **Privileged Role Administrator** there;
   and a token issued in that organisation carries every permission above.
   Personal accounts and government clouds are refused.
4. Switch puts the app into the organisation's Teams app list with the admin's
   delegated token, which it then throws away. If the admin may approve but is
   not a Teams administrator, the install still succeeds and the connection
   says the app is not in the list yet, with the package to download for a
   Teams admin to upload (Teams admin center → Teams apps → Manage apps →
   Upload new app). Once it has been added to any one team from Teams, Switch
   learns where it is in the list and can add it to the rest itself.
5. The connection's **Microsoft Teams** panel lists the organisation's teams.
   The workspace's admins add Switch to the teams they want and choose the
   default team new channels go in; choosing one turns channel creation on.
6. Channels Switch is in become rooms, as with the bring-your-own app.

One Microsoft organisation belongs to one Switch workspace. A second workspace
approving the same organisation is refused, without being told which holds it.
The same workspace approving again — for new permissions, a newer app, or after
withdrawing its approval — refreshes its install.

## A bridge reaches only its own organisation

The app's one credential reaches every approving organisation, so each bridge
is kept inside its own in four layers:

- **Start guard.** A shared bridge starts only for the workspace that holds the
  organisation's live install.
- **Locked settings.** Only the default team is editable on a shared bridge;
  the organisation and what Switch learned from Microsoft (the service URL, the
  channel-to-team map) are not.
- **Microsoft's hosts only.** The Bot Connector token is sent only to
  `smba.trafficmanager.net`, whatever a stored or learned address says.
- **Bind and send checks.** A room is bound to an existing channel only after
  Graph, asked with the organisation's own token, shows the channel; chats are
  never bound by id; activities and notifications from another organisation
  are refused; proactive posts name the organisation.

Inbound, every activity's Bot Framework token is checked as Microsoft's spec
requires — including its `serviceurl` claim and the signing key's endorsement
for `msteams`. Notifications carrying data must be vouched for by Graph's
validation tokens and may only name organisations those tokens vouch for; each
organisation's `clientState` is derived from `JWT_SECRET_KEY`, so a value
learned for one forges nothing for another. An organisation that sets
**assignment required** on the Switch enterprise app stops Microsoft sending
validation tokens, and its captured messages are dropped until it is unset;
other organisations' messages in the same batch are unaffected.

Rotating `JWT_SECRET_KEY` changes every organisation's `clientState`. The
notification URL carries a fingerprint of the key, so at the next start every
subscription made under the old key reads as stale and is remade.

## When something goes wrong on Microsoft's side

Microsoft sends no word when an organisation withdraws its approval. Each
bridge checks every few minutes, with the token it is minting anyway: an app no
longer approved, permissions narrowed, or the app blocked by the
organisation's Teams admin shows on the connection as something to act on, with
**Approve again**. The install is not ended — a blip in Microsoft's directory
must not disconnect a customer and free their organisation for someone else.

Disconnecting from Switch stops capture in the organisation and takes Switch
out of the teams it knew. Removing the app from the organisation entirely is
the customer's to do: their Teams admin removes **Agent Switch** in the Teams
admin center, and their Entra admin deletes the enterprise application.

## Left out on purpose

- **Government clouds** (GCC, GCC High, DoD): refused at approval.
- **The Teams Store.** A listing would remove the catalogue step and let
  most package updates reach organisations without their admin; it needs
  Partner Center review and is public. Until then, an organisation takes a
  newer package when its admin approves again.
- **Per-team permissions.** The organisation-wide permissions already cover
  them, and asking again per team would only add a consent prompt.

# Microsoft Teams collaboration bridge setup

Connects a Microsoft Teams tenant to Switch. A **single Azure bot app** backs
every Switch agent (like Slack); each agent's messages render as an **Adaptive
Card** headed with the agent's name and avatar.

Teams is the most involved bridge to set up. Unlike Slack or Mattermost it has
no persistent socket, so it is **push-based**: Microsoft calls Switch, not the
other way round. That single fact drives most of this guide — the adapter hosts
its own HTTP listener, and that listener must be reachable from the public
internet or the bridge only half-works.

> This is the operator-facing walkthrough. The in-package note at
> [`core/switch_core/bridges/collaboration/teams/README.md`](../../core/switch_core/bridges/collaboration/teams/README.md)
> covers the adapter's internals (Bot Framework + Graph capture, encryption,
> de-duplication).

---

## Read this first: the two mistakes that cost the most time

Both produce confusing failures. Neither is obvious from the error you see.

### 1. The client secret is the **value**, not the secret ID

When you create a client secret, the Azure portal shows two columns: **Value**
and **Secret ID**. Both look like opaque strings. You want the **Value**.

Pasting the Secret ID gives you this, at the moment the bridge first calls
Microsoft — typically when you add the first room:

```
AADSTS7000215: Invalid client secret provided. Ensure the secret being sent
in the request is the client secret value, not the client secret ID.
```

**The Value is shown exactly once**, when the secret is created. Navigate away
and it is gone forever — the portal will still show the Secret ID, which is what
makes this so easy to get wrong later. If you did not record it, do not try to
recover it: create a new secret and use that.

### 2. The listener needs **public** HTTPS ingress

The adapter runs its own HTTP server on port **3978**, *separate* from Switch's
main API on 8000. Microsoft pushes to it:

- `POST /api/messages` — Bot Framework activities (inbound messages)
- `POST /api/teams/notifications` — Graph change notifications

If these are not publicly reachable, the bridge is **outbound-only**: it creates
channels and posts messages fine, so it looks healthy, but nothing from Teams
ever arrives. Tailscale, a VPN or an internal-only load balancer are **not
enough** — the caller is Microsoft, out on the internet.

See [Part 2: Deployment](#part-2-deployment) — this is a separate step from
filling in the bridge form, and it is the one most often skipped.

---

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

Capture therefore has two tiers. `@mention` capture needs only the Bot Framework
path; full channel capture additionally needs Graph subscriptions **and** the
encryption certificate.

---

## Part 1: Azure setup

Tenant/environment setup owned by an administrator. Treat it as a separate ops
task, done before you touch the Switch gateway. Keep a scratch note as you go —
Part 3 asks for each value by name.

### 1.1 App registration

**Azure portal → Microsoft Entra ID → App registrations → New registration.**

Record:

| You need | Where it is | Portal label |
| --- | --- | --- |
| `app_id` | App registration → Overview | **Application (client) ID** |
| `tenant_id` | App registration → Overview | **Directory (tenant) ID** |

Both are GUIDs. Do not confuse the Application (client) ID with the **Object
ID** directly beneath it — the Object ID is not used here.

### 1.2 Client secret

**App registration → Certificates & secrets → Client secrets → New client
secret.**

Record the **Value** column — see [the warning above](#1-the-client-secret-is-the-value-not-the-secret-id).
This becomes `app_password`.

Note the expiry you choose. When it lapses the bridge fails exactly as it does
with a wrong secret, with the same `AADSTS7000215`-family error — so record the
date somewhere you will see it.

### 1.3 Azure Bot resource

**Create an Azure Bot** resource backed by the app registration above.

- **Messaging endpoint:** `https://<your-public-host>/api/messages`
- **Channels:** enable **Microsoft Teams**

The messaging endpoint must match the public host you will configure as
`public_base_url` in Part 3, and it must be reachable before Teams will deliver
anything.

### 1.4 Graph API permissions

**App registration → API permissions.** These are *application* permissions
(not delegated), and all require **admin consent** — the bridge acts as itself,
with no signed-in user.

| Permission | Needed for |
| --- | --- |
| `ChannelMessage.Read.Group` (RSC, preferred) or `ChannelMessage.Read.All` | Full channel-message capture |
| `Channel.Create` | Creating a channel when a Switch room is added to the bridge |
| `TeamMember.ReadWrite.All` / `ChannelMember.ReadWrite.All` | Adding members to provisioned channels |

Prefer the RSC (resource-specific consent) variant where possible: it is scoped
to the teams the app is installed in, rather than tenant-wide.

Click **Grant admin consent** afterwards. Permissions that are added but not
consented behave as if absent, and the resulting Graph errors say
`Authorization_RequestDenied` rather than anything about consent.

> Graph resource-data subscriptions count against a **shared per-tenant Teams
> subscription quota**. A tenant already using Graph subscriptions heavily can
> hit that ceiling.

### 1.5 Encryption certificate

Required for full channel capture (not for `@mention`-only operation). Graph
encrypts message bodies to a public certificate; the bridge decrypts with the
private key.

Any X.509 keypair works — it is used purely as a key transport, and Microsoft
never validates a chain, so self-signed is fine:

```bash
openssl req -x509 -newkey rsa:2048 -keyout teams-key.pem -out teams-cert.pem \
  -days 730 -nodes -subj "/CN=switch-teams-bridge"
```

You supply three values in Part 3:

- `encryption_certificate_id` — any stable string you choose (e.g.
  `switch-teams-v1`). It labels the key so you can rotate later.
- `encryption_public_certificate` — contents of `teams-cert.pem`
- `encryption_private_key` — contents of `teams-key.pem`

Rotating means generating a new pair, giving it a **new** id, and updating all
three together.

### 1.6 Teams app package

Build a Teams app manifest that includes the bot, and install it into the target
team. Without this the bot cannot be added to channels or post proactively.

Record the **team id** — the AAD group id of the team new channels are created
in. This becomes `team_id`. The simplest way to read it: open the team in Teams
on the web and copy the `groupId` query parameter from the URL.

---

## Part 2: Deployment

**This part is easy to miss, and skipping it produces a bridge that looks
healthy and silently receives nothing.** The Teams listener is the only bridge
component in Switch that needs its own network path.

### What has to be true

1. Port **3978** on the switch-core pod/container is published by a Service.
2. An Ingress routes `/api/messages` and `/api/teams/notifications` to that
   port — **not** to port 8000, which is a different HTTP server.
3. The host is reachable **from the public internet** over HTTPS with a valid
   certificate.
4. `public_base_url` in Part 3 exactly matches that public origin.

Graph is strict about (3): when you create a subscription it immediately calls
your notification URL with a validation token and expects a correct response
**within 10 seconds**, over TLS it trusts. A self-signed ingress certificate,
a redirect, or an auth proxy in front will all fail that handshake.

### Helm

The chart publishes the listener only when you ask it to, because bridges are
created at runtime in the gateway — the chart cannot tell whether you have a
Teams bridge:

```yaml
switchCore:
  teamsBridge:
    enabled: true    # publishes containerPort + Service port
    port: 3978       # must match the bridge's listen_port
```

**If you use `ingress.mode: managed`,** that is all you need — the chart adds
the two paths, routed to the teams port, from `ingress.teamsPaths`.

**If you use `ingress.mode: existing`** (the chart renders no Ingress and you
bring your own), you must add the two paths to your own manifest yourself.
Enabling `teamsBridge` publishes the Service port but cannot touch an Ingress it
does not manage:

```yaml
- path: /api/messages
  pathType: Prefix
  backend: { service: { name: RELEASE-switch-core, port: { number: 3978 } } }
- path: /api/teams/notifications
  pathType: Prefix
  backend: { service: { name: RELEASE-switch-core, port: { number: 3978 } } }
```

See [`samples/ingress.example.yaml`](../../deploy/remote/helm/switch/samples/ingress.example.yaml)
for the full manifest.

### Running more than one Teams bridge

One Teams bridge per listener port. A second bridge on the same host needs a
distinct `listen_port` in its stored `connection_config`, its own Service port
and its own ingress route.

---

## Part 3: Onboard the bridge in Switch

As a gateway admin: **Messaging Apps → Add bridge → Teams**, give it a display
name (e.g. "Acme Teams"), and fill in the fields.

Fields (`TeamsConnectionConfig`), with where each value came from:

| Field | Required | Value | From |
| --- | --- | --- | --- |
| `app_id` | yes | Application (client) ID | 1.1 |
| `app_password` | yes | Client secret **Value** — not the Secret ID | 1.2 |
| `tenant_id` | yes | Directory (tenant) ID | 1.1 |
| `team_id` | yes | AAD group id of the team new channels go into | 1.6 |
| `public_base_url` | yes | Public HTTPS origin of the listener, e.g. `https://switch.example.com` — scheme + host, no path | Part 2 |
| `client_state` | yes | A shared secret you invent. Echoed in every Graph notification and validated on receipt — the only control authenticating a notification's origin | — |
| `encryption_certificate_id` | for channel capture | Stable id you chose | 1.5 |
| `encryption_public_certificate` | for channel capture | PEM public certificate | 1.5 |
| `encryption_private_key` | for channel capture | PEM private key | 1.5 |

Switch-internal fields, hidden from the gateway form:

- `listen_host` / `listen_port` (default `0.0.0.0:3978`) — the listener bind.
  Override via the stored `connection_config` only when running more than one
  Teams bridge on a host.
- `service_url` — the Bot Connector outbound endpoint, learned at runtime from
  inbound activities and persisted automatically.

Without the three encryption fields the bridge still runs — outbound, chats and
`@mention` capture all work — but per-channel Graph subscriptions are skipped
and an error is logged. **Full channel capture is disabled until they are
supplied.**

---

## Part 4: Verify

Do these in order. Each one isolates a different failure.

**1. The listener started.** In the switch-core logs:

```
Teams adapter listening on 0.0.0.0:3978 (app <your app id>)
```

**2. Credentials work.** Still at startup, you should *not* see:

```
Could not list existing Graph subscriptions on start
```

That warning means the very first Graph call failed — almost always the client
secret, occasionally missing admin consent. Fix it before going further; every
later step depends on this call working.

**3. The listener is publicly reachable.** From outside your network:

```bash
curl -i "https://<your-public-host>/api/teams/notifications?validationToken=ping"
```

Expect `200` with `ping` echoed back as `text/plain`. A 404 means the ingress
path is missing or pointed at port 8000; a timeout means it is not public.

**4. Provisioning works.** Add a room to the bridge in the gateway. A matching
channel should appear in the target team within a second or two.

**5. Capture works.** Post in that channel from Teams and confirm it reaches the
Switch room. If `@mentions` arrive but ordinary messages do not, Graph
subscriptions are failing while Bot Framework is fine — check step 3 and the
encryption fields.

---

## Troubleshooting

Symptoms as they actually appear, and what each one means.

**`AADSTS7000215: Invalid client secret provided`**
The `app_password` is the secret **ID** instead of the secret **value**, or the
secret has expired. Create a new secret and use the Value column. See 1.2.

**`Could not list existing Graph subscriptions on start`** (at startup)
The first Graph call failed. Same causes as above, plus missing admin consent on
the Graph permissions. The bridge starts anyway and fails later, at the first
real operation.

**Adding a room to the bridge returns an error**
Channel provisioning called Graph and Graph refused. The switch-core logs carry
the reason; look for `create channel '<name>' in team <id> failed (<status>)`.
Common causes: bad or expired secret; `Channel.Create` missing or unconsented;
wrong `team_id`; the Teams app not installed in that team.

**`Failed to create Graph subscription for channel <id>`**
Channel provisioning succeeded but capture setup did not, so the channel exists
and only `@mentions` will arrive. Usually the notification URL is not publicly
reachable (Part 2, step 3), or its TLS is not trusted. This is logged and does
not fail the operation.

**`Cannot subscribe to channel <id> messages: encryption certificate not
configured on the Teams bridge`**
The three encryption fields are absent. Expected if you deliberately run
`@mention`-only; otherwise supply them (1.5).

**Bot posts fine, but nothing from Teams ever arrives**
The classic symptom of a missing public route to 3978. Outbound needs no
ingress, so the bridge looks healthy. Work through Part 2, then Part 4 step 3.

**`Authorization_RequestDenied` from Graph**
A permission is present but not admin-consented, or you granted a delegated
permission where an application permission is required. See 1.4.

---

## Security note

Graph resource-data encryption proves message **integrity, not origin** (the
wrapping key is the public certificate, which anyone can encrypt to). The
`clientState` shared secret is therefore **required** and validated on every
notification. Inbound Bot Framework activities are separately authenticated by
verifying the Bot Connector JWT.

Because `/api/messages` and `/api/teams/notifications` are exposed publicly,
both are unauthenticated at the network layer by necessity — authentication
happens inside the adapter, per request. Do not put an auth proxy in front of
them; Microsoft cannot satisfy it, and Graph's validation handshake will fail.

---

## Known limitations / follow-ups

- **Switch-initiated DM rooms** are user-initiated (as on Mattermost);
  bootstrapping one bot-side needs proactive app installation via Graph.
- **Attachments** (inbound media and outbound files) are currently **disclosed,
  not relayed** — the text bridges and a note names the un-relayed media.
- **Real outbound `@mentions`** are not yet emitted (needs a display-name → AAD
  id directory); mention text bridges as plain `@name`.
- **One Teams bridge per listener port** — run multiple on distinct ports (and
  ingress routes) if needed.

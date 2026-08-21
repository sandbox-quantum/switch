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

Pasting the Secret ID is rejected when you save the bridge, with Microsoft's
own words:

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

Note the expiry you choose. When it lapses the bridge stops authenticating and
fails the way a wrong secret does, though Azure reports it with its own error
code — so record the date somewhere you will see it.

### 1.3 Azure Bot resource

**Create an Azure Bot** resource backed by the app registration above.

- **Messaging endpoint:** `https://<your-public-host>/api/messages`
- **Channels:** enable **Microsoft Teams**

**Back it by the app registration from 1.1 — not a new one.** The create form
will happily make you a fresh app registration, and everything then looks
correct: Graph runs on 1.1's id and creates channels, while Microsoft signs
inbound activities with the bot's id and Switch rejects every one of them. Check
**Configuration → Microsoft App ID** on the finished resource and confirm it is
the id from 1.1.

The messaging endpoint must be the same origin you configure as
`public_base_url` in Part 3, with `/api/messages` on the end — the listener's
host, which is not necessarily the one serving the gateway. If you follow
[Part 2](#part-2-deployment)'s recommended `mode: dedicated`, both are the Teams
host. Deciding that hostname now, before you create the bot, saves editing it
later.

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

### 1.5 Encryption certificate — nothing to do

Full channel capture needs an X.509 keypair: Graph encrypts message bodies to a
public certificate and the bridge decrypts with the private key. **Switch
generates it when you create the bridge**, so there is no step here and no
`openssl` to run.

The certificate is pure key transport — Microsoft never validates it against a
trust store, checks an issuer, or cares who signed it — so a generated
self-signed pair is not a compromise. There is no party for a CA to vouch to.

If your organisation insists on supplying its own, the three fields still exist
on the API (`encryption_certificate_id`, `encryption_public_certificate`,
`encryption_private_key`) and a supplied set takes precedence. Supply all three
or none; a partial set is rejected, because pairing someone's certificate with a
private key they do not hold fails only at decryption time, long after the
mistake.

Rotating means creating a new bridge, which mints a new pair.

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
2. Something routes `/api/messages` and `/api/teams/notifications` to that
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
Teams bridge. Enabling it takes two decisions, not one: the port, and how
Microsoft reaches it.

```yaml
switchCore:
  teamsBridge:
    enabled: true      # publishes containerPort + Service port
    port: 3978         # must match the bridge's listen_port
    ingress:
      mode: dedicated  # dedicated | shared | external — required when enabled
```

`mode` has no default, because none of the three is a safe guess. Leaving it
unset **fails the render** rather than deploying a listener nothing can reach:

```
switchCore.teamsBridge.enabled is true but switchCore.teamsBridge.ingress.mode
is unset. Microsoft calls the Teams listener from the public internet, so
publishing the port is only half the job — choose how the two callback paths
are routed: ...
```

A mode set while `enabled: false` fails the same way — nothing publishes the
port for it to route to — as does any value outside the three below.

**`mode: dedicated` — the chart renders a second Ingress.** Recommended.
`<release>-teams` carries only the two callback paths, on its own host, class,
annotations and TLS:

```yaml
switchCore:
  teamsBridge:
    enabled: true
    ingress:
      mode: dedicated
      className: nginx
      host: teams.example.com    # must match the host in public_base_url
      annotations:
        cert-manager.io/cluster-issuer: letsencrypt-prod
      tls:
        enabled: true
        secretName: teams-tls
```

It renders **regardless of `ingress.mode`**, including `existing`, where the
chart renders no other Ingress at all — and that is the point. Microsoft needs
those two paths and nothing else, and the adapter authenticates every request
itself, so the gateway and agent API can stay internal while only these are
public. The main Ingress's nginx streaming annotations are deliberately **not**
applied here: Teams callbacks are short request/response, not long-lived
streams.

**Behind a CDN or reverse proxy, leave `host` empty and TLS off.** This is the
option to reach for when you have no domain to hand — a CDN in front of the load
balancer gives you a public HTTPS name and a trusted certificate with no DNS
work at all:

```yaml
switchCore:
  teamsBridge:
    enabled: true
    ingress:
      mode: dedicated
      className: alb
      annotations:
        alb.ingress.kubernetes.io/scheme: internet-facing
        alb.ingress.kubernetes.io/listen-ports: '[{"HTTP": 80}]'
        alb.ingress.kubernetes.io/target-type: ip
      tls:
        enabled: false      # the CDN terminates TLS, not this Ingress
```

The rule then carries no host and answers whatever `Host` header arrives, which
is required: the incoming Host is the CDN's name, and the chart cannot know it.
`public_base_url` is the CDN's name, not this Ingress's.

**Two things the CDN must do**, or the bridge fails in ways that look unrelated:
forward query strings, and **not cache** — Graph validates every new
subscription with a `GET …?validationToken=…` and a cached answer fails the
handshake. On CloudFront that is the `Managed-AllViewer` origin-request policy
and the `Managed-CachingDisabled` cache policy, with all HTTP methods allowed so
`POST` reaches you.

Note the trade: with an HTTP origin, anyone who learns the load balancer's own
hostname can reach these paths directly, bypassing the CDN. That is tolerable
here only because the adapter authenticates every request itself.

Empty `host` with `tls.enabled: true` is rejected — a host-less rule cannot
carry a certificate.

**`mode: shared` — the paths go on the chart's main Ingress,** putting Teams on
the same public host as the gateway. That Ingress has to exist and to have a
real hostname, so `ingress.mode: managed` and a non-empty `ingress.host` are
both required:

```yaml
ingress:
  mode: managed
  host: switch.example.com
switchCore:
  teamsBridge:
    enabled: true
    ingress:
      mode: shared
```

Otherwise:

```
switchCore.teamsBridge.ingress.mode is "shared" but ingress.mode is "existing":
there is no chart-managed Ingress to add the Teams paths to.
```

**`mode: external` — the chart renders no route.** Enabling the bridge still
publishes the Service port, but you add the two paths to your own manifest:

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

**TLS is on by default, and warns rather than fails.**
`switchCore.teamsBridge.ingress.tls.enabled` defaults to `true`, because Graph
calls only an HTTPS URL whose certificate it trusts. Setting it `false` is *not*
an error: TLS may terminate upstream where the chart cannot see it — an AWS ALB
configured by annotation, say — so the install output warns instead:

```
⚠  TLS is disabled on this Ingress. Microsoft Graph only calls an HTTPS URL
   whose certificate it trusts, so this works only if TLS terminates upstream
   (e.g. an AWS ALB configured by annotation). If it does not, the bridge will
   create channels and then silently receive nothing.
```

If nothing upstream is terminating TLS, that warning is the only notice you get
before the bridge goes quietly deaf.

Where the chart knows the hostname — `dedicated` with a `host`, or `shared` —
that output prints the exact origin to paste into `public_base_url` in Part 3.
It is always `https`, whatever `tls.enabled` says: that flag governs whether
this Ingress carries the certificate, not what Microsoft dials, and Graph
refuses plaintext. Under `external`, or `dedicated` with no host, the public
name belongs to something in front and the chart says so rather than guess.

### Checking it with `helm test`

`helm test <release>` runs `<release>-teams-listener-test`, a pod that performs
Graph's own handshake against the Service: GET the notification path with a
`validationToken` and require it echoed back verbatim.

It proves two things — the listener is bound inside the pod, and the Service
publishes its port. **It cannot prove Microsoft can reach you.** It runs inside
the cluster, so it says nothing about public DNS, ingress routing or certificate
trust, which is exactly where this usually fails; the external `curl` in
[Part 4](#part-4-verify) step 4 remains the real check.

**Run it after registering the bridge, not before.** The chart publishes the
port; only a configured Teams bridge starts a listener behind it. Enabling
`teamsBridge` necessarily comes first — the bridge's `public_base_url` is the
address that enabling it produces — so between the two there is a window where
this test fails and nothing is wrong. Its output says so.

A failure *after* the bridge exists means the listener never started: look for
`Teams adapter listening on` in the switch-core logs, and note that a second
Teams bridge on the same port will keep it from binding.

### Running more than one Teams bridge

**One Teams bridge per listener port, and Switch enforces it.** Registering a
second bridge on a port another one already uses is refused, naming the bridge
that holds it:

```
'SandboxAQ Teams' already uses tcp/3978 on this instance, and two teams
bridges cannot share it. Delete that bridge first, or give this one a
different listen_port in its connection_config …
```

That refusal exists because the alternative is worse: two adapters racing for
one port means the loser fails to bind inside a background task, gets dropped
from the running set, and is never retried. The only symptom is
`Bridge not running: <id>` the next time you use it — nowhere near the cause.

A genuinely separate second bridge needs a distinct `listen_port` in its stored
`connection_config`, **plus its own Service port and ingress route**. The chart
publishes only one Teams port, so the second is yours to wire by hand. Consider
whether you need it: one Azure app can serve one tenant's team, and most
deployments want exactly one.

---

## Part 3: Onboard the bridge in Switch

As a gateway admin: **Messaging Apps → Register messaging app → Teams**, give it
a display name (e.g. "Acme Teams"), and fill in the fields.

There are five, and every one is a value Azure gave you in Part 1:

| Field | Value | From |
| --- | --- | --- |
| `app_id` | Application (client) ID | 1.1 |
| `app_password` | Client secret **Value** — not the Secret ID | 1.2 |
| `tenant_id` | Directory (tenant) ID | 1.1 |
| `team_id` | AAD group id of the team new channels go into | 1.6 |
| `public_base_url` | Public HTTPS origin **of the listener** — scheme + host, no path. Under `mode: dedicated` that is the Teams host (`https://teams.example.com`), not the gateway's; a Helm install prints the exact value to use | Part 2 |

**Switch checks these before saving.** It requests both Azure tokens the bridge
needs, and if Microsoft refuses, the form fails with Microsoft's own
explanation instead of accepting the values and going quiet. So a wrong secret
is a red message in front of you, not a mystery hours later.

That also means creating a bridge requires Switch to reach
`login.microsoftonline.com`. On a restricted network, allow that egress first.

Everything else is generated or learned, and hidden from the form:

- `client_state` — the shared secret echoed in every Graph notification and
  validated on receipt. Minted per bridge; there is nothing to invent.
- The **encryption trio** — generated (1.5), so channel capture works out of the
  box rather than only once someone pastes three PEMs correctly.
- `listen_host` / `listen_port` (default `0.0.0.0:3978`) — the listener bind.
  Override via the stored `connection_config` only when running more than one
  Teams bridge on a host.
- `service_url` — the Bot Connector outbound endpoint, learned at runtime from
  inbound activities and persisted automatically.

**Bridges created before Switch generated this material keep their original
values**, including no encryption material at all — in which case channel
capture stays off and an error is logged. There is no way to edit a bridge's
credentials, so adopting the generated ones means deleting it and creating it
again.

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

**3. The listener is reachable in-cluster.** On a Helm install, `helm test
<release>` answers this without leaving the cluster — see
[above](#checking-it-with-helm-test). Skip to step 4 if it passes; if it fails,
the problem is the pod or the Service, not your ingress.

**4. The listener is publicly reachable.** From outside your network — a phone
on mobile data is a good check, since it cannot be on your VPN:

```bash
curl -i "https://<your-public-host>/api/teams/notifications?validationToken=ping"
```

Use the host from `public_base_url`, which under `mode: dedicated` is the Teams
host rather than the gateway's. Expect `200` with `ping` echoed back as
`text/plain`. A 404 means the path is missing or pointed at port 8000; a timeout
or DNS error means it is not public. **This is the step `helm test` cannot do
for you, and the one that most often fails.**

**5. Provisioning works.** Add a room to the bridge in the gateway. A matching
channel should appear in the target team within a second or two.

**6. Capture works.** Post in that channel from Teams and confirm it reaches the
Switch room. If `@mentions` arrive but ordinary messages do not, Graph
subscriptions are failing while Bot Framework is fine — check step 4 and the
encryption fields.

Note that steps 5 and 6 fail independently: provisioning is outbound and needs
only working credentials, while capture needs the public route. A bridge that
passes 5 and fails 6 is the signature of unreachable ingress.

---

## Troubleshooting

Symptoms as they actually appear, and what each one means.

**`AADSTS7000215: Invalid client secret provided`**, when saving the bridge
The `app_password` is the secret **ID** instead of the secret **value**, or the
secret has expired. Create a new secret and use the Value column. See 1.2.

**`Could not list existing Graph subscriptions on start`** (at startup)
The first Graph call failed — missing admin consent on the Graph permissions, or
a secret that expired after the bridge was created. The bridge starts anyway and
fails at the first real operation. Credentials are checked when the bridge is
saved, so on a bridge created since then this points at consent or expiry rather
than a typo.

**Adding a room to the bridge returns an error**
Channel provisioning called Graph and Graph refused. The switch-core logs carry
the reason; look for `create channel '<name>' in team <id> failed (<status>)`.
Common causes: bad or expired secret; `Channel.Create` missing or unconsented;
wrong `team_id`; the Teams app not installed in that team.

**`Failed to create Graph subscription for channel <id>`**
Channel provisioning succeeded but capture setup did not, so the channel exists
and only `@mentions` will arrive. Usually the notification URL is not publicly
reachable ([Part 2](#part-2-deployment)), or its TLS is not trusted. This is
logged and does not fail the operation. Read the `GraphError` on the same line —
Graph says which it was.

**`Failed to resolve domain <host>: No such host is known`** (inside that error)
`public_base_url` points at a name Microsoft cannot resolve. A Tailscale or
other VPN-internal hostname does this: it resolves for you and not for them, so
Graph rejects the subscription before ever sending traffic. It must be public
DNS.

**`Cannot subscribe to channel <id> messages: encryption certificate not
configured on the Teams bridge`**
The bridge has no encryption material. Switch generates it at creation, so this
means a bridge created before it did — or one deliberately registered without
it. There is no way to add it to an existing bridge; delete and re-create.

**`no Bot Connector serviceUrl known for channel <id> — the bot has not yet
received an activity from this tenant`**
An agent tried to post into Teams and could not. This looks like an outbound
fault and is not: the address Switch posts to is per-tenant and Microsoft only
ever hands it over inside an *inbound* activity, which is then persisted. If
nothing has ever reached the listener, there is nothing to send to. **Fix
inbound and outbound starts working too** — no separate action.

**`Rejected inbound Teams activity: … addressed to app id '<x>', but this
bridge is configured with app id '<y>'`** (with a `401` on `POST /api/messages`)
Microsoft is reaching the listener — the public route is fine — and the activity
is signed by a genuine Bot Connector token, but for a different bot. The Azure
Bot resource's **Microsoft App ID** is not the app registration the bridge was
registered with. See 1.3. Nothing in the outbound direction notices, because
Graph runs on the registered id, so channel creation keeps working throughout.

Worth knowing when you fix it: the bridge learns its outbound address from the
first *accepted* inbound activity, so until one gets past this, agents cannot
reply either — see the `serviceUrl` entry above.

**Bot creates channels, but nothing from Teams ever arrives, and agents cannot
reply either**
The classic symptom of no public route to 3978, and the reason it is confusing
is above: channel creation is Graph (outbound, works) while both message
directions depend on the listener. Work through [Part 2](#part-2-deployment),
then Part 4 step 4. On a Helm install with `teamsBridge.ingress.mode` set to
`dedicated` or `shared` the route exists by construction, so look instead at DNS,
TLS trust, or an auth proxy in front.

**`Bridge not running: <bridge id>`** when adding a room
The bridge crashed during startup and was dropped; it is not retried until
switch-core restarts. Look for `Bridge <id> crashed` in the logs.

On Teams the classic cause was `address already in use` on 3978 — a second Teams
bridge cannot bind the same port. That is now caught before it happens, both at
registration and again at startup, so instead of a bind error you get a message
naming the bridge that holds the port. Delete the duplicate and restart
switch-core to bring the survivor up.

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

# Microsoft Teams collaboration bridge setup

Connects a Microsoft Teams tenant to Switch. A **single Azure bot app** backs
every Switch agent (like Slack); each agent's messages render as an **Adaptive
Card** headed with the agent's display name — its identifier where it has
none — and avatar.

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

## Prerequisites

Have these before you start. Two of them involve someone who may not be you,
and both are on the critical path.

**In Microsoft Entra ID / Azure**

- Rights to create an **app registration** and a client secret on it.
- Someone who can **grant admin consent** for Graph application permissions
  (see [1.4](#14-graph-api-permissions)). Tenant-wide consent is usually a
  Global Administrator or Privileged Role Administrator. If that is not you,
  line them up now: nothing in Part 4 works until consent is granted.
- Rights to **install a Teams app into a team** — either sideloading enabled
  for you, or an admin who can upload to the organisation's app catalog.

**In your deployment**

- A **public DNS name** resolvable from the internet, and **HTTPS** on it that
  Microsoft will trust. Teams is push-based: Microsoft calls you. A VPN-only or
  tailnet name cannot work, and neither can plain HTTP.
- Administrator access to the Switch dashboard, and a running switch-core you
  can deploy chart changes to.

**Decide one thing up front: the public hostname of the Teams listener.** It
goes into the Azure Bot's messaging endpoint in [1.3](#13-azure-bot-resource),
into `public_base_url` in [Part 3](#part-3-onboard-the-bridge-in-switch), and
into your ingress in [Part 2](#part-2-deployment) — and changing it later means
editing all three. It need not be the name that serves the dashboard, and
usually should not be.

**Time.** An hour if you have all of the above and the consent is quick;
longer if you are waiting on an administrator.

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
path; full channel capture additionally needs Graph subscriptions, which need
the Graph permissions in [1.4](#14-graph-api-permissions). The keypair those
notifications are encrypted to is Switch's own — generated per bridge, with
nothing to obtain or install.

---

## Part 1: Azure setup

Tenant/environment setup owned by an administrator. Treat it as a separate ops
task, done before you touch the Switch dashboard. Keep a scratch note as you go —
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
- **Channels** (the Azure Bot blade of that name — not Teams channels):
  enable **Microsoft Teams**

**Back it by the app registration from 1.1 — not a new one.** The create form
will happily make you a fresh app registration, and everything then looks
correct: Graph runs on 1.1's id and creates channels, while Microsoft signs
inbound activities with the bot's id and Switch rejects every one of them. Check
**Configuration → Microsoft App ID** on the finished resource and confirm it is
the id from 1.1.

The messaging endpoint is the hostname you settled on in
[Prerequisites](#prerequisites), with `/api/messages` on the end. It must be
the same origin you give as `public_base_url` in
[Part 3](#part-3-onboard-the-bridge-in-switch) — the listener's host, which is
not necessarily the one serving the dashboard. Under
[Part 2](#part-2-deployment)'s recommended `mode: dedicated`, both are the
Teams host.

### 1.4 Graph API permissions

**App registration → API permissions → Add a permission → Microsoft Graph →
Application permissions.**

Application permissions, not delegated: the bridge acts as itself, with no
signed-in user. Every one of them needs **Grant admin consent** afterwards — a
permission added but not consented behaves exactly as if it were absent, and
Graph reports it as `Authorization_RequestDenied` rather than as anything to do
with consent.

Grant all six. The table says what each one buys so you can tell what is broken
when one is missing, not so you can pick and choose:

| Permission | Without it |
| --- | --- |
| `ChannelMessage.Read.All`<br>(or `ChannelMessage.Read.Group`, see below) | No channel capture. The bridge sees only messages that @mention the bot, so plain channel conversation, and bare `!commands`, never reach Switch. |
| `Channel.Create` | Adding a room to the bridge fails: Switch cannot provision the room's channel. |
| `Channel.ReadBasic.All` | Three things, all from the same read. Binding a room to a channel that **already exists** fails (see [Bringing Switch into a channel that already exists](#bringing-switch-into-a-channel-that-already-exists)) — Switch reads the channel to learn whether it is standard or private, and provisions membership differently for each. A room auto-created for a channel is titled after the channel's raw `19:…` id, because Teams often omits the name from the activity. And agents fall back to posts-layout threading in every channel (see [How agents use threads](#how-agents-use-threads)). |
| `TeamMember.ReadWrite.All` | People named on a room are not added to a **standard** channel. A standard channel inherits the team's membership, so they are added to the team. |
| `ChannelMember.ReadWrite.All` | The same, for a **private** channel, which carries its own membership. |
| `User.ReadBasic.All` | Nobody can link their Switch account to their Teams account, so no agent can @mention its owner. Switch also cannot resolve a sender's name when Teams omits it — 1:1 chats especially — and falls back to their raw id, which then becomes their name in room titles and in every reply that addresses them. |

Two of these are easy to skip and expensive to omit. **`Channel.ReadBasic.All`**
looks redundant next to `Channel.Create` and is not: creating a channel and
adopting an existing one are different paths, and only the second reads.
**`User.ReadBasic.All`** looks like it only matters once someone links an
account, and does not — without it, everyone in Teams is an opaque id to
Switch from the first message.

**About the RSC variant.** `ChannelMessage.Read.Group` is resource-specific
consent: scoped to the teams your app is installed in rather than tenant-wide,
and preferable where your organisation will accept it. Three consequences. It
is declared in the Teams app manifest ([1.5](#15-teams-app-package)) as well as
granted in the portal, so it is not a drop-in substitution for a checkbox. It
applies only to teams the app is installed in — so if capture works in one team
and not another, that is the first thing to check. And Microsoft blocks message
subscriptions on **private and shared** channels for apps consented this way,
answering `403`; those need the tenant-wide permission.

The shipped manifest pairs it with `ChannelSettings.Read.Group`, the RSC
equivalent of `Channel.ReadBasic.All`. Take both or neither: on the RSC route,
`ChannelSettings.Read.Group` is what lets Switch read a channel's name and
layout.

> **Teams protected APIs.** Microsoft gates change notifications carrying Teams
> message content behind a separate access request, and may attach billing to
> them. If subscriptions are refused on a tenant where the permissions above are
> plainly granted and consented, this is the likely reason — check the current
> Microsoft Graph documentation for "protected APIs for Microsoft Teams", since
> the terms have changed more than once.

> **Subscription quota.** Graph resource-data subscriptions count against a
> shared per-tenant Teams quota. A tenant already using Graph subscriptions
> heavily can hit that ceiling.

Nothing in this section is needed for the Bot Framework side. Messages that
@mention the bot arrive over the Bot Connector, authenticated by the app
registration itself, and need no Graph permission at all — which is why a
bridge with none of the above still looks half-alive.

### 1.5 Teams app package

An Azure Bot is reachable but not yet *present* in Teams. A Teams app package
puts it in a team, and without one the bot cannot be added to channels or post
proactively — so this step is a hard prerequisite for Part 4, not a formality.

Switch ships a complete one. Copy the manifest below into a `manifest.json`,
put the two icons beside it, change three values, zip the three files and
upload. The whole package is in the repository at
[`docs/old/bridges/teams-app/`](teams-app/) if you would rather download it than
copy it — including
[`color.png`](teams-app/color.png) and [`outline.png`](teams-app/outline.png),
which you need either way.

<details>
<summary><strong>Agent Switch app manifest</strong> (paste this)</summary>

```json
{
    "$schema": "https://developer.microsoft.com/json-schemas/teams/v1.29/MicrosoftTeams.schema.json",
    "manifestVersion": "1.29",
    "version": "1.0.0",
    "id": "00000000-0000-0000-0000-000000000000",
    "developer": {
        "name": "Agent Switch",
        "websiteUrl": "https://github.com/sandbox-quantum/switch",
        "privacyUrl": "https://example.com/privacy",
        "termsOfUseUrl": "https://example.com/terms"
    },
    "name": {
        "short": "Agent Switch",
        "full": "Agent Switch \u2014 your AI agents, in your channels"
    },
    "description": {
        "short": "Work with your AI agents in Teams channels and chats.",
        "full": "Agent Switch puts your AI agents into Microsoft Teams. Mention an agent by name in a channel and it answers there, in the same conversation, with its progress shown on the message while it works. Each Switch room is a Teams channel, so the people and the agents share one thread of context rather than one per tool.\n\nThis app is the Teams end of a Switch deployment you run yourself. It talks only to your own Switch server: no conversation data reaches the app's authors, and there is no hosted service behind it.\n\nIn a chat, type /help. In a channel, mention the app first: @Agent Switch /help."
    },
    "icons": {
        "color": "color.png",
        "outline": "outline.png"
    },
    "accentColor": "#3F3C3B",
    "supportsChannelFeatures": "tier1",
    "bots": [
        {
            "botId": "00000000-0000-0000-0000-000000000000",
            "scopes": [
                "team",
                "personal",
                "groupChat"
            ],
            "supportsTargetedMessages": true,
            "isNotificationOnly": false,
            "supportsFiles": false,
            "commandLists": [
                {
                    "scopes": [
                        "team",
                        "groupChat",
                        "personal"
                    ],
                    "triggers": [
                        "mention"
                    ],
                    "commands": [
                        {
                            "title": "/help",
                            "description": "Show every in-room command"
                        },
                        {
                            "title": "/list-agents",
                            "description": "List the agents in this room"
                        },
                        {
                            "title": "/agents-status",
                            "description": "Show each agent's presence and capabilities"
                        },
                        {
                            "title": "/invite-agent",
                            "description": "Add an existing agent: /invite-agent @agent-name"
                        },
                        {
                            "title": "/agents-greet",
                            "description": "Have the agents here introduce themselves"
                        },
                        {
                            "title": "/roles",
                            "description": "List this room's roles and who holds each"
                        },
                        {
                            "title": "/list-aliases",
                            "description": "List this room's agent aliases"
                        },
                        {
                            "title": "/set-alias",
                            "description": "Give an agent a room alias: /set-alias @agent-name @alias"
                        },
                        {
                            "title": "/reset",
                            "description": "Reset an agent's session: /reset @agent-name"
                        },
                        {
                            "title": "/interrupt",
                            "description": "Interrupt an agent's current turn: /interrupt @agent-name"
                        },
                        {
                            "title": "/list-switch-agents",
                            "description": "List every agent on this Switch, to find one to invite"
                        },
                        {
                            "title": "/room-url",
                            "description": "Show this room's address in Switch"
                        }
                    ]
                },
                {
                    "scopes": [
                        "team",
                        "groupChat",
                        "personal"
                    ],
                    "triggers": [
                        "slash"
                    ],
                    "commands": [
                        {
                            "title": "help",
                            "description": "Show every in-room command"
                        },
                        {
                            "title": "list-agents",
                            "description": "List the agents in this room"
                        },
                        {
                            "title": "agents-status",
                            "description": "Show each agent's presence and capabilities"
                        },
                        {
                            "title": "invite-agent",
                            "description": "Add an existing agent: /invite-agent @agent-name"
                        },
                        {
                            "title": "agents-greet",
                            "description": "Have the agents here introduce themselves"
                        },
                        {
                            "title": "roles",
                            "description": "List this room's roles and who holds each"
                        },
                        {
                            "title": "list-aliases",
                            "description": "List this room's agent aliases"
                        },
                        {
                            "title": "set-alias",
                            "description": "Give an agent a room alias: /set-alias @agent-name @alias"
                        },
                        {
                            "title": "reset",
                            "description": "Reset an agent's session: /reset @agent-name"
                        },
                        {
                            "title": "interrupt",
                            "description": "Interrupt an agent's current turn: /interrupt @agent-name"
                        },
                        {
                            "title": "list-switch-agents",
                            "description": "List every agent on this Switch, to find one to invite"
                        },
                        {
                            "title": "room-url",
                            "description": "Show this room's address in Switch"
                        }
                    ]
                }
            ]
        }
    ],
    "permissions": [
        "identity",
        "messageTeamMembers"
    ],
    "validDomains": [
        "switch.example.com"
    ],
    "webApplicationInfo": {
        "id": "00000000-0000-0000-0000-000000000000",
        "resource": "https://graph.microsoft.com"
    },
    "authorization": {
        "permissions": {
            "resourceSpecific": [
                {
                    "name": "ChannelMessage.Read.Group",
                    "type": "Application"
                },
                {
                    "name": "ChannelSettings.Read.Group",
                    "type": "Application"
                }
            ]
        }
    }
}
```

</details>

**Change these before you upload:**

| In the manifest | Replace with |
| --- | --- |
| `00000000-0000-0000-0000-000000000000` — in `id`, `bots[0].botId` **and** `webApplicationInfo.id` | The `app_id` from [1.1](#11-app-registration). The same value in all three: it is what ties the Teams app, the bot and the Entra registration together. |
| `switch.example.com` in `validDomains` | The host of your `public_base_url` |
| `https://example.com/privacy` and `https://example.com/terms` | Your organisation's own privacy policy and terms. Teams requires all three `developer` URLs and does not check them on upload, so an unchanged placeholder installs fine and then tells your users the app has no privacy policy. |

**Delete the `authorization` block** unless you are taking the resource-specific
consent route for channel capture ([1.4](#14-graph-api-permissions)). RSC is
declared here as well as granted in the portal, so it is not a drop-in
substitute for the tenant-wide permission; if you granted
`ChannelMessage.Read.All` instead, this block asks the team owner to consent to
something you are not using.

**Then build the package.** Every upload route wants a `.zip` — the Developer
Portal's **Import app** included — and none of them takes a bare
`manifest.json`. From a clone of the repository:

```bash
just teams-app-package \
  --app-id 00000000-0000-0000-0000-000000000000 \
  --public-host teams.example.com \
  --privacy-url https://example.com/privacy \
  --terms-url https://example.com/terms
```

That writes `agent-switch-teams.zip`, filling the app id into all three places
for you and checking the limits Teams enforces without explaining — icon sizes,
name and description lengths, the command cap. **Pass the id rather than
editing `manifest.json`**: that file is tracked in a public repository and
ships with a placeholder deliberately, so an id typed into it is one
`git add` from being published.

**Updating an app that is already installed? Add `--bump`.** Teams matches on
`id` and ignores an upload whose `version` has not increased, without saying
so — it is the usual reason an edit appears to have done nothing. It exits non-zero and names
anything you left as a placeholder, so a null app id cannot ship quietly. Add
`--version` when you are updating an app that is already installed.

Without a clone, do it by hand — the three files must be at the **root** of the
zip, because Teams rejects a package whose contents sit inside a folder:

```bash
zip -j agent-switch-teams.zip manifest.json color.png outline.png
```

**Then get it into Teams**, whichever of these your tenant allows:

- **Sideload it** — Teams → **Apps → Manage your apps → Upload an app → Upload
  a custom app**, pick the zip, choose the team. This needs *Upload custom
  apps* on in your app setup policy (Teams admin center → **Teams apps → Setup
  policies**), and a policy change can take up to 24 hours to take effect. If
  the **Upload a custom app** option is not there, that setting is off.
- **Have an admin publish it** — Teams admin center → **Teams apps → Manage
  apps → Upload new app**. No sideloading permission needed, and it becomes
  available to the whole organisation.
- **Register it in the Developer Portal first** — `dev.teams.microsoft.com` →
  **Apps → Import app**, upload the zip. Useful if you want to edit the
  manifest in a UI afterwards, or hand the app to someone else to publish.

This is the step most likely to need someone else, which is why it is in
[Prerequisites](#prerequisites).

#### The icons

A Teams package will not install without two PNGs, and **a manifest cannot
point at an image URL** — Teams reads them from inside the zip. Both are in
[`docs/old/bridges/teams-app/`](teams-app/):

| File | Size | What it is |
| --- | --- | --- |
| `color.png` | 192×192 | The full-colour app icon. Square with no rounded corners: Teams masks the corners itself, so an icon that rounds its own is rounded twice. |
| `outline.png` | 32×32 | A white silhouette on transparency, for the Teams app bar. Not a shrunk logo — no colour, no padding around the symbol. |

Replace them with your own if you would rather the app carried your branding;
keep the sizes and the outline's white-on-transparent rule.

The **Azure Bot resource carries its own icon**, separately from this package.
Set it there too ([1.3](#13-azure-bot-resource) → the bot's **Settings**), or
the bot shows a default avatar in some surfaces even though the package is
branded.

#### Changing the app later

A manifest edit only reaches an installed app if you **raise `version`** and
upload again. Teams matches on `id`, so the same `id` with a higher `version`
replaces the app rather than adding a second one. Leave `version` alone and the
upload does nothing, silently — which is the usual reason a newly added command
never appears in the compose box.

Most changes then propagate on their own. Ones that alter what the app can do —
adding a bot, changing `botId`, adding RSC permissions — need each team to
consent again, and until someone does, that team keeps the old version.

Never change `id` after the app is installed. Teams would treat the upload as a
different app and you would have two.

#### Record the team id

The **team id** is the Entra group id of the team new channels are created in.
This becomes `team_id`. The simplest way to read it: open the team in Teams on
the web and copy the `groupId` query parameter from the URL.

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

Graph is strict about (3): when you create a subscription it immediately sends
`POST <your notification URL>?validationToken=…` and expects the decoded token
echoed back as `text/plain` **within 10 seconds**, over TLS it trusts. A
self-signed ingress certificate, a redirect, or an auth proxy in front will all
fail that handshake.

### Helm

The chart publishes the listener only when you ask it to, because bridges are
created at runtime in the gateway — the chart cannot tell whether you have a
Teams bridge. Enabling it takes two decisions, not one: the port, and how
Microsoft reaches it.

```yaml
switchCore:
  teamsBridge:
    enabled: true      # publishes containerPort + Service port
    port: 3978         # must match the bridge's listen_port (see Part 3)
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

It renders **regardless of the chart's top-level `ingress.mode`**, including
`existing`, where the
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

**Three things the CDN must do**, or the bridge fails in ways that look
unrelated: allow `POST`, forward query strings, and **not cache**. All three are
the same requirement seen from different angles — Graph validates every new
subscription with `POST …?validationToken=…`, so the token rides on the query
string of a POST, and a cached or stripped answer fails the handshake. On
CloudFront that is the `Managed-AllViewer` origin-request policy and the
`Managed-CachingDisabled` cache policy, with all HTTP methods allowed.

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

```text
Set the bridge's public_base_url to exactly:

  https://teams.example.com

⚠  https, even though TLS is disabled on this Ingress — Graph refuses a
   plaintext URL, so that host has to be served over HTTPS by something in
   front (a CDN, or a load balancer configured by annotation). If nothing is,
   the bridge will create channels and then silently receive nothing.
```

**Both of those only happen when the chart knows the public origin** — that is,
`dedicated` with a `host`, or `shared`. Then the install output prints the exact
value to paste into `public_base_url` in Part 3, always as `https`: `tls.enabled`
governs whether *this Ingress* carries the certificate, not what Microsoft
dials, and Graph refuses plaintext either way.

Under `external`, or the CDN shape above (`dedicated` with an empty `host`), the
public name belongs to something in front, so the chart neither prints an origin
nor warns about its TLS. **Nothing will tell you that origin is unreachable or
plaintext** — verifying it is on you, and [Part 4](#part-4-verify) step 4 is how.

### Checking it with `helm test`

`helm test <release>` runs `<release>-teams-listener-test`, a pod that probes
the notification path through the Service and requires a `validationToken` to
come back echoed verbatim.

It sends a GET, where Graph sends a POST, because the same handler answers both
and a GET is what a probe can express. So it exercises the handshake's shape
rather than reproducing it: enough to prove the listener is bound inside the pod
and the Service publishes its port, and no more.

**It cannot prove Microsoft can reach you.** It runs inside the cluster, so it
says nothing about public DNS, ingress routing or certificate trust, which is
exactly where this usually fails; the external `curl` in
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
'Contoso Teams' already uses tcp/3978 on this instance, and two teams
bridges cannot share it. Delete that bridge first, or give this one a
different listen_port in its connection_config …
```

That refusal exists because the alternative is worse: two adapters racing for
one port means the loser fails to bind inside a background task, gets dropped
from the running set, and is never retried. The only symptom is
`Bridge not running: <id>` the next time you use it — nowhere near the cause.

A genuinely separate second bridge needs a distinct `listen_port`, **plus its
own Service port and ingress route**. The chart publishes only one Teams port,
so the second is yours to wire by hand.

`listen_port` is not on the registration form, and **a bridge's
`connection_config` cannot be edited after it is created** — the dashboard's
update endpoint carries only the greeting and channel-creation toggles. So it
has to go in at creation time, through the API rather than the form:

```bash
curl -X POST "https://<gateway-host>/gateway/collaboration-bridges" \
  -H "Authorization: Bearer <admin token>" \
  -H "Content-Type: application/json" \
  -d '{"bridge_type": "teams", "display_name": "Second Teams",
       "connection_config": {"app_id": "…", "app_password": "…",
         "tenant_id": "…", "team_id": "…",
         "public_base_url": "https://teams2.example.com",
         "listen_port": 3979}}'
```

Getting it wrong means deleting the bridge and creating it again. Consider
whether you need a second at all: one Azure app can serve one tenant's team, and
most deployments want exactly one.

---

## Part 3: Onboard the bridge in Switch

As a Switch administrator: **Messaging Apps → Register messaging app → Teams**,
give it
a display name (e.g. "Acme Teams"), and fill in the fields.

There are five. Four are values Azure gave you in Part 1; the fifth is the
listener's public origin you settled on in Part 2.

| Field | Value | From |
| --- | --- | --- |
| `app_id` | Application (client) ID | 1.1 |
| `app_password` | Client secret **Value** — not the Secret ID | 1.2 |
| `tenant_id` | Directory (tenant) ID | 1.1 |
| `team_id` | Entra group id of the team new channels go into | 1.5 |
| `public_base_url` | Public HTTPS origin **of the listener** — scheme + host, no path. Under `mode: dedicated` that is the Teams host (`https://teams.example.com`), not the dashboard's; a Helm install prints the exact value to use | Part 2 |

Alongside them the dialog carries a display name and an **Allow creating
channels from Switch** toggle, on by default. Leave it on unless you want rooms
to be bound only to channels that already exist — with it off, adding a room
that would provision a channel is refused, and the refusal says so.

**Switch checks these before saving.** It requests both Azure tokens the bridge
needs, and if Microsoft refuses, the form fails with Microsoft's own
explanation instead of accepting the values and going quiet. So a wrong secret
is a red message in front of you, not a mystery hours later.

Note what that check can and cannot tell you: a token proves the credentials
are good, not that the app may *do* anything. Permissions are only tested when
Graph is first called, which is why a bridge can save cleanly and then fail on
its first room — see [1.4](#14-graph-api-permissions).

That also means creating a bridge requires Switch to reach
`login.microsoftonline.com`. On a restricted network, allow that egress first.

Everything else is generated or learned, and hidden from the form:

- `client_state` — the shared secret echoed in every Graph notification and
  validated on receipt. Minted per bridge; there is nothing to invent.
- The **encryption trio** Graph resource-data notifications are encrypted to —
  generated per bridge, so channel capture works out of the box rather than
  only once someone pastes three PEMs correctly. Supplying your own through the
  API still wins, all three or none; rotating means re-creating the bridge.
- `listen_host` / `listen_port` (default `0.0.0.0:3978`) — the listener bind.
  A deployment detail, and only worth changing to run more than one Teams bridge
  on a host. Because it cannot be edited later, it has to be passed at creation
  through the API — see
  [Running more than one Teams bridge](#running-more-than-one-teams-bridge).
- `service_url` — the Bot Connector outbound endpoint, learned at runtime from
  inbound activities and persisted automatically.

**A bridge registered before Switch started generating this material keeps
whatever it was given** — which for an older one is no encryption material at
all, in which case channel capture stays off and an error is logged. You can
tell from its detail page: an empty `encryption_certificate_id` is the sign.
Credentials cannot be edited, so adopting the generated ones means deleting the
bridge and creating it again.

### Bringing Switch into a channel that already exists

A room does not have to bring a new channel with it. Adding a room to the
bridge normally provisions one, but you can instead point the room at a channel
where a conversation is already happening.

**There is no per-channel install step.** Installing the app into a team
([1.5](#15-teams-app-package)) makes the bot available in every **standard**
channel of that team at once — you do not add it channel by channel, and there
is no "add app to this channel" button to look for. Private and shared channels
are the exception: each one needs the app added to it explicitly.

#### 1. Get the channel's id

The channel's Switch-side id is its Teams thread id, of the form
`19:…@thread.tacv2`. To read it: **right-click the channel in Teams → Get link
to channel**, and take the first path segment of the URL.

```
https://teams.microsoft.com/l/channel/19%3Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa%40thread.tacv2/My%20channel?groupId=…&tenantId=…
                                      └──────────────── the channel id, URL-encoded ─────────────────┘
```

**URL-decode it before you paste it in**: `%3A` is `:` and `%40` is `@`, so the
example above is `19:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@thread.tacv2`. The
`groupId` in the same URL is the team id from [1.5](#15-teams-app-package) —
useful confirmation that the channel is in the team the bridge points at.

#### 2. Bind a room to it

In the dashboard: **Rooms → Create room**, pick this Teams connection as the
room's messaging app, choose **Use existing channel** rather than *Create new
channel*, and paste the id into **External channel ID**. Switch detects whether
the channel is standard or private itself.

Two things differ from the provisioning path, and both have bitten people:

- **Switch reads the channel** to learn whether it is standard or private,
  because membership is granted differently for each. That read needs
  `Channel.ReadBasic.All` ([1.4](#14-graph-api-permissions)), which the
  provisioning path never uses — so a bridge that has been creating channels
  happily for weeks can fail the first time you adopt one.
- **Capture is set up when the room is bound**, the same as for a channel
  Switch created. If the notification endpoint is unreachable at that moment
  the subscription fails, and the bridge retries in the background rather than
  giving up — see [Troubleshooting](#troubleshooting).

Switch posts a short notice in the channel once the room is linked, which is
also your confirmation that outbound works.

#### 3. Say something to an agent

Add an agent to the room and `@`-mention it by name in the channel.

Whether the bot needs mentioning depends on capture. Without Graph channel
capture, Teams only delivers a channel message to a bot that was
`@mentioned` — that is the platform's rule, not Switch's — so both messages and
bare commands need it. With capture live ([1.4](#14-graph-api-permissions)) the
bridge sees every message in the channel, and a bare `!help` works. Mentioning
an *agent* by name is separate, and is always how you address one.

#### Private and shared channels

These work differently enough to plan around. Three things, in the order they
bite:

- **The app can be added to them, but has not been proven in them.** The
  manifest declares `"supportsChannelFeatures": "tier1"`, which is what makes
  Teams offer it in a private or shared channel's **Add an app** list. That is
  not a choice: Teams **requires** the property of any manifest at schema v1.25
  or later whose bot takes the `team` scope, and refuses the upload without it.
  Read the declaration as "allowed here", not as "tested here" — the next two
  points still hold.
- **Each one needs the app added to it.** Installing into the team covers every
  standard channel and no private or shared one. If Graph returns
  `403 app not enabled in this channel`, that is the missing step.
- **Graph channel capture does not work there over RSC.** Microsoft blocks
  message subscriptions on private and shared channels for apps consented that
  way, and answers `403`. If you need full capture in one, grant tenant-wide
  `ChannelMessage.Read.All` ([1.4](#14-graph-api-permissions)) instead of the
  RSC variant. Otherwise the channel falls back to `@mention`-only capture,
  which still works.

A channel shared *into* your team from elsewhere cannot have apps added from
where you see it — go to the team that hosts it.

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
host rather than the dashboard's. Expect `200` with `ping` echoed back as
`text/plain`. A 404 means the path is missing or pointed at port 8000; a timeout
or DNS error means it is not public. **This is the step `helm test` cannot do
for you, and the one that most often fails.**

**5. Provisioning works.** In the dashboard, **Rooms → Create room**, pick this
Teams connection and leave **Create new channel** selected. A matching
channel should appear in the target team within a second or two.

**6. Capture works.** Post in that channel from Teams and confirm it reaches the
Switch room. If `@mentions` arrive but ordinary messages do not, Graph
subscriptions are failing while Bot Framework is fine — check step 4 and the
encryption fields.

Note that steps 5 and 6 fail independently: provisioning is outbound and needs
only working credentials, while capture needs the public route. A bridge that
passes 5 and fails 6 is the signature of unreachable ingress.

**7. An agent posts back.** Add an agent to the room and address it from the
channel. Its reply should arrive as a card headed with the agent's name and
avatar, under the post you asked in. This is the one step that exercises the
outbound path end to end, and the first thing that fails if the bridge has
never accepted an inbound activity — see the `serviceUrl` entry in
[Troubleshooting](#troubleshooting).

---

## How agents use threads

Teams offers a channel two conversation layouts, and Switch behaves differently
in each. Nothing here is configurable: the bridge asks Graph which layout a
channel uses and follows it. Channel owners choose the layout in Teams: hover the channel, then
**More options (…) → Edit channel → Conversation layout**. If the option is
not there, a tenant administrator has turned the threads layout off org-wide
(**Teams admin center → Settings & policies → Teams and channels**).

**Threads layout** (Graph calls it `chat`) is a stream of messages, like every
other platform Switch bridges. Agents behave as they do on Slack:

- An agent decides whether to reply in a thread. A reply to something said in a
  thread stays in that thread; anything else goes to the channel.
- The notice Switch posts when it links a channel to a room goes to the
  channel, not into a thread.
- A working agent's status card sits wherever the message that triggered it
  was — in the thread if it was asked there, at the channel level if it was
  asked there.

**Posts layout** (Graph calls it `post`) is a list of conversations, where a
message at the channel level starts a new one rather than continuing the last.
Answering there needs steering, or a reply appears as a fresh post below the
question and reads as a non-sequitur. So:

- An agent's reply lands in the post containing the message it is answering,
  whether or not the agent chose to thread it.
- With nothing to answer — an agent introducing itself, say — it lands in the
  post the channel last spoke in, or opens one if the bridge has not yet seen
  this channel speak. What it says after that joins the same post rather than
  starting another.
- A post an *agent* opened never displaces a real message as the one later
  answers land in.
- **A working agent's status is posted once, stays where it is, and is edited
  to `✓ Done` when the turn ends.** It is never deleted, because Teams replaces
  a deleted message with *"This message has been deleted."* and keeps it in the
  post — so a status that vanished each turn would leave one of those behind
  every time, and another every time it moved. In a threads-layout channel a
  delete is clean, so there the status disappears and follows the conversation
  as it does on every other platform.

If Switch cannot read a channel's layout — Graph refusing the read is the usual
reason — it assumes posts. That is Graph's own default for a channel it
creates, and what every channel was before the threads layout existed. Note it
is no longer what the Teams client picks for a new one.

---

## Commands

Both `!list-agents` and `/list-agents` work, and reach the same place. `!help`
lists every command Switch understands.

**Whether a channel command needs the bot mentioned depends on capture**, and
this is the one thing people get wrong:

- **With Graph channel capture live** ([1.4](#14-graph-api-permissions)), the
  bridge sees every message in the channel, so a bare `!list-agents` works.
- **Without it**, Teams only delivers a channel message to a bot that was
  `@mentioned` — the platform's rule, not Switch's — so the command must carry
  the mention:

  ```text
  @Agent Switch /list-agents
  ```

  The mention is stripped before the command is parsed, so
  `@Agent Switch /help`, `@Agent Switch !invite-agent @agent-name` and the rest
  behave as they do elsewhere.

In a 1:1 chat no mention is ever needed.

### Putting the commands in the Teams UI

Teams has no server-registered slash commands the way Slack does. What it has
is a **command list**, declared in the app manifest, which shows the commands
in the bot's own menu; picking one types it into the compose box. The manifest
in [1.5](#15-teams-app-package) already carries one, so if you used it there is
nothing to do here.

Three things to know if you are editing it.

**A title is inserted verbatim** in the mention menu — Teams prepends nothing
there, which is why those titles carry their `/`. The `/` picker is the
opposite: it prepends the slash and inserts the bare name. Keep each list
spelled for its own surface.

**The list is presentation only.** Teams types the text and Switch parses it,
so a command missing from the manifest still works if someone types it, and a
command in the manifest that Switch does not know returns the usual "unknown
command".

**Teams caps a command list at twelve commands** per scope (ten before schema
v1.25), which is why the shipped one is a selection rather than all of them.
Swap in whichever twelve your teams actually use; `!help` lists the rest.

**The commands appear twice, spelled differently, and that is deliberate.**
Teams has two surfaces and they disagree about the slash:

- The **`/` autocomplete picker**, the one you get by typing `/` in the compose
  box. It prints the slash itself and inserts the *bare* name, so those titles
  are declared without one. `supportsTargetedMessages` on the bot is what puts
  Switch in that picker at all; `triggers: ["slash"]` is what puts individual
  commands there.
- The **bot's own command menu**, reached by mentioning it. That inserts a
  title verbatim, so those titles keep their `/`.

A title with a slash in the picker would read `//help`, and a title without one
in the mention menu would insert `help`, which is a word rather than a command.
Hence two lists with the same commands.

Picking from the `/` picker also sends the message **privately to Switch** —
other people in the channel do not see it, and no `@`-mention is needed. It
works in channels, group chats and meeting chats, but not in a 1:1 chat, where
you can simply type the command.

If the menu does not appear after you edit it, the manifest almost certainly
reached nobody: an edit only lands if you raise `version` and upload again —
see [Changing the app later](#changing-the-app-later).

`!` remains available everywhere and needs no manifest at all.

---

## Clickable "Open in Switch Console" links (`GATEWAY_PUBLIC_URL`)

Teams renders only `http(s)` links, and it does not merely leave others as
plain text: it **strips the whole link, label included**, so a raw
`switchdash://session?…` deeplink arrives as empty brackets. Set
**`GATEWAY_PUBLIC_URL`** on switch-core to the Switch API's public origin —
scheme + host only, **no path**:

```dotenv
# .env / deployment env
GATEWAY_PUBLIC_URL=https://switch-api.example.com
```

Switch then posts `https://<switch-api-host>/deeplink/session?…` instead, a
page that opens Switch Console and then tries to close itself. The bridge logs
a warning at startup when Teams is running without this set.

Two Teams-specific notes:

- This is the **Switch API** host, not the Teams listener host and not the
  dashboard. It has to be reachable from wherever people click the link.
- Microsoft Defender for Office 365 may rewrite the link through **Safe Links**,
  which adds an interstitial before your page. That is expected. If the tab is
  left on "Verifying link…" after Switch Console has opened, it is a stale
  deployment — the handoff page replaced a bare redirect precisely because a
  redirect left that interstitial on screen.

---

## Troubleshooting

Symptoms as they actually appear, and what each one means.

#### `AADSTS7000215: Invalid client secret provided`, when saving the bridge

The `app_password` is the secret **ID** instead of the secret **value**, or the
secret has expired. Create a new secret and use the Value column. See 1.2.

#### `Could not list existing Graph subscriptions on start` (at startup)

The first Graph call failed — missing admin consent on the Graph permissions, or
a secret that expired after the bridge was created. The bridge starts anyway and
fails at the first real operation. Credentials are verified when the bridge is
saved, so a typo would have been caught then: this is consent or expiry.

#### Adding a room to the bridge returns an error

Channel provisioning called Graph and Graph refused. The switch-core logs carry
the reason; look for `create channel '<name>' in team <id> failed (<status>)`.
Common causes: bad or expired secret; `Channel.Create` missing or unconsented;
wrong `team_id`; the Teams app not installed in that team.

#### `Failed to create Graph subscription for channel <id> (…); capture is degraded and will be retried`

Channel provisioning succeeded but capture setup did not, so the channel exists
and only `@mentions` arrive. Usually the notification URL is not publicly
reachable ([Part 2](#part-2-deployment)), or its TLS is not trusted. Read the
reason on the same line — Graph says which it was.

The bridge keeps retrying, backing off to every few minutes, so a cause that
clears on its own needs no intervention: the two common ones are a load
balancer that has not yet started serving a newly-started pod, and a Graph
permission consented after the bridge was running (see below). Recovery is
logged as `Capture recovered for Teams channel <id> messages (subscription
<sub-id>)`. Repeats of an unchanged
failure are logged at debug to keep the log readable, but a **change** in the
reason is logged — that is the interesting event.

#### Still failing on a permission you have already granted

An app's Graph roles are fixed when its access token is issued, and tokens last
about an hour, so consent granted while the bridge is running does nothing
until the token is replaced. Switch handles this: a Graph call refused with
`401` or `403` throws the cached token away and tries once more with a freshly
minted one, so a grant takes effect on the next attempt rather than at the next
restart. If a refusal persists past that, the permission really is missing or
unconsented — check 1.4.

#### `Failed to resolve domain <host>: No such host is known` (inside that error)

`public_base_url` points at a name Microsoft cannot resolve. A Tailscale or
other VPN-internal hostname does this: it resolves for you and not for them, so
Graph rejects the subscription before ever sending traffic. It must be public
DNS.

#### `Failed to create Graph subscription for channel <id> (encryption certificate not configured on the Teams bridge)`

The same log line as above, with a different reason in the brackets: the bridge
has no encryption material — an older bridge registered before Switch generated
it, or one deliberately registered without it. There is no way to add it to an
existing bridge; delete and re-create. Retrying will not help this one, and the
retry cannot tell.

#### `no Bot Connector serviceUrl known for channel <id> — the bot has not yet received an activity from this tenant`

An agent tried to post into Teams and could not. This looks like an outbound
fault and is not: the address Switch posts to is per-tenant and Microsoft only
ever hands it over inside an *inbound* activity, which is then persisted. If
nothing has ever reached the listener, there is nothing to send to. **Fix
inbound and outbound starts working too** — no separate action.

#### `Rejected inbound Teams activity: … addressed to app id '<x>', but this bridge is configured with app id '<y>'` (with a `401` on `POST /api/messages`)

Microsoft is reaching the listener — the public route is fine — and the activity
is signed by a genuine Bot Connector token, but for a different bot. The Azure
Bot resource's **Microsoft App ID** is not the app registration the bridge was
registered with. See 1.3. Nothing in the outbound direction notices, because
Graph runs on the registered id, so channel creation keeps working throughout.

Worth knowing when you fix it: the bridge learns its outbound address from the
first *accepted* inbound activity, so until one gets past this, agents cannot
reply either — see the `serviceUrl` entry above.

#### Bot creates channels, but nothing from Teams ever arrives, and agents cannot reply either

The classic symptom of no public route to 3978, and the reason it is confusing
is above: channel creation is Graph (outbound, works) while both message
directions depend on the listener. Work through [Part 2](#part-2-deployment),
then Part 4 step 4. On a Helm install with `teamsBridge.ingress.mode` set to
`dedicated` or `shared` the route exists by construction, so look instead at DNS,
TLS trust, or an auth proxy in front.

#### `Bridge not running: <bridge id>`, when adding a room

The bridge crashed during startup and was dropped; it is not retried until
switch-core restarts. Look for `Bridge <id> crashed` in the logs.

On Teams the classic cause was `address already in use` on 3978 — a second Teams
bridge cannot bind the same port. That is now caught before it happens, both at
registration and again at startup, so instead of a bind error you get a message
naming the bridge that holds the port. Delete the duplicate and restart
switch-core to bring the survivor up.

#### `Authorization_RequestDenied` from Graph

A permission is present but not admin-consented, or you granted a delegated
permission where an application permission is required. See 1.4.

#### Nobody can link their account: the people search errors, or says the person does not exist right after you picked them from the list

Directory search reads `User.ReadBasic.All` — see [1.4](#14-graph-api-permissions).
Without it the search fails outright, and the message names neither the
permission nor Graph. Until someone is linked, an agent has no way to @-mention
its owner, so this reads as "the agent ignores me" rather than as a setup step
left undone.

---

## Security note

Graph resource-data encryption proves message **integrity, not origin** (the
wrapping key is the public certificate, which anyone can encrypt to). The
`clientState` shared secret is therefore **required** and validated on every
notification.

That is also why Switch generating its own keypair costs nothing: the
certificate is pure key transport, and Microsoft never validates it against a
trust store, checks an issuer or cares who signed it. There is no party for a CA
to vouch to. Inbound Bot Framework activities are separately authenticated by
verifying the Bot Connector JWT.

Because `/api/messages` and `/api/teams/notifications` are exposed publicly,
both are unauthenticated at the network layer by necessity — authentication
happens inside the adapter, per request. Do not put an auth proxy in front of
them; Microsoft cannot satisfy it, and Graph's validation handshake will fail.

---

## Known limitations

- **A DM has to be started from Teams** (as on Mattermost). Switch cannot open
  one; doing it bot-side would need proactive app installation via Graph.
- **Attachments are disclosed, not relayed.** The message text is bridged, and
  a note names the media that did not come with it.
- **An `@mention` only becomes a real mention for someone Switch can address.**
  That means a person who has linked their Teams account
  ([Part 3](#part-3-onboard-the-bridge-in-switch)) and whose directory id
  Switch therefore holds. Everyone else — and every agent, which is not a Teams
  user at all — renders as plain `@name` text, which is what Switch's own
  addressing matches on.
- **In a posts channel, a reply with no thread of its own lands in the post the
  channel last spoke in.** See [How agents use threads](#how-agents-use-threads)
  — right almost always, and wrong when two conversations run in one posts
  channel at the same moment. Teams offers nothing better to key on for a reply
  that is not explicitly threaded.
- **Private and shared channels need a newer manifest** than the one shipped,
  and cannot use resource-specific consent for channel capture. See
  [Private and shared channels](#private-and-shared-channels).
- **One Teams bridge per listener port** — run multiple on distinct ports (and
  ingress routes) if needed.

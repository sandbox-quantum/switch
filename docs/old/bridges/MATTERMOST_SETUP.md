# Mattermost collaboration bridge setup

Connects a Mattermost server to Switch. Unlike the single-bot platforms,
Mattermost uses **one bot account per Switch agent**, created and driven through
an **admin account** you supply. Inbound messages arrive over Mattermost's
WebSocket (an outbound connection from Switch), so **no public ingress is
required**. One thing does travel the other way — a press on a button Switch
posted, which the Mattermost server delivers over HTTP. That needs the
Mattermost server to reach switch-core, not the internet; see
[step 3](#3-optional-let-mattermost-deliver-button-presses).

## Prerequisites

- A Mattermost server reachable from switch-core.
- An **admin** account on that server (username + password) — the bridge uses it
  to create per-agent bot accounts, channels, and memberships.
- A **team** on the server that bridged channels live in.
- The Switch gateway reachable by an admin to onboard the bridge.

## 1. Prepare the Mattermost server

1. Ensure **bot accounts** are enabled (System Console → Integrations → Bot
   Accounts → *Enable Bot Account Creation*).
2. Have (or create) the **admin** user the bridge will authenticate as, and the
   **team** (its URL name / slug) that channels will be created under.
3. Make sure the admin can create channels and manage members on that team.
4. Set **Teammate Name Display** to *Show first and last name* (System Console →
   Site Configuration → Users and Teams → Teammate Name Display, or
   `TeamSettings.TeammateNameDisplay` = `full_name`; `nickname_full_name` works
   too). Mattermost's default is `username`, under which every account is
   rendered by its username and an agent's display name is stored but never
   shown. The setting is **server-wide** — it changes how human members' names
   render as well, so it is a decision for the server, not for Switch. Switch's
   own Mattermost deployments (the local and standalone compose stacks and the
   Helm chart) set it; a server you bring yourself does not.

## 2. Onboard the bridge in Switch

As a gateway admin, onboard the bridge from the **operator dashboard**:
**Messaging Apps → Register messaging app → Mattermost**, give it a display name (e.g. "Acme
Mattermost"), and fill in the fields below.

Fields (`MattermostConnectionConfig`):

| Field | Required | Description |
| --- | --- | --- |
| `url` | yes | Base URL switch-core connects to (may be an internal/tailnet address). |
| `admin_user` | yes | Admin username the bridge authenticates as. |
| `admin_password` | yes | Admin password. |
| `team_name` | yes | Team slug that bridged channels are created under. |
| `public_url` | no | User-facing base URL when it differs from `url`; used for channel deeplinks so they open in the user's client. Falls back to `url`. |
| `callback_base_url` | no | Base URL (scheme + host + port, no path) the **Mattermost server** reaches switch-core's callback listener on. Unset means cards carry no buttons. See [step 3](#3-optional-let-mattermost-deliver-button-presses). |

On success the bridge logs in as the admin, resolves the team, and starts its
WebSocket. Per-agent bot accounts are created as agents are used.

## 3. (Optional) Let Mattermost deliver button presses

Everything else Switch hears from Mattermost comes down the WebSocket the bridge
dialled out on. A **button press does not**: the Mattermost server POSTs it to a
URL, so switch-core has to be reachable *from the Mattermost server*. Skip this
section and nothing breaks — cards arrive without buttons and stay answerable by
typing a reply, and the bridge logs one warning saying so at startup.

**The listener.** switch-core takes callbacks on a socket of its own, separate
from the agent API on `SERVER_PORT` (8000), which also carries the MCP server and
the operator dashboard. What you expose for a button should be callbacks and
nothing else.

| Variable | Default | Description |
| --- | --- | --- |
| `COLLABORATION_CALLBACK_HOST` | `0.0.0.0` | Bind address. |
| `COLLABORATION_CALLBACK_PORT` | `8081` | Bind port. |

Nothing binds until a bridge asks to be served, so a deployment with no
`callback_base_url` anywhere opens no port at all. The listener is shared: every
bridge that needs callbacks is routed by type and id below one port, so a second
Mattermost server is not a second port and not a second firewall rule.

**Reachability.** Set `callback_base_url` on the bridge to whatever address the
Mattermost server itself can use. This is frequently nothing like the URL a
browser uses — a service name on a container network, or an internal hostname:

```
http://switch:8081                      # container network, service name
http://host.docker.internal:8081        # Mattermost in Docker, switch-core on the host
https://switch-callbacks.example.invalid # behind a reverse proxy
```

**A bridge that already exists** cannot be given the field from the operator
dashboard: the registration form is generated from the connection schema and so
offers `callback_base_url`, but there is no form for editing a connection
afterwards — only the greetings and channel-creation toggles. Use the API, as a
gateway admin:

```bash
curl -X PATCH "$GATEWAY_URL/gateway/collaborations/$BRIDGE_ID" \
  -H 'Content-Type: application/json' \
  -H "Cookie: switch_auth=$TOKEN" \
  -d '{"connection_config": {"callback_base_url": "http://switch:8081"}}'
```

The config is merged over what is stored, so the admin password does not have to
be re-sent, and the bridge is restarted so the change takes effect rather than
waiting for the next deploy.

**Mattermost must be allowed to call it.** Mattermost refuses outbound
integration requests to private addresses unless the host is listed in System
Console → Environment → Developer → *Allow untrusted internal connections to*
(`ServiceSettings.AllowedUntrustedInternalConnections`, space-separated hosts).
Add the host from `callback_base_url`. Switch's own compose stacks set it
already; a server you bring yourself does not, and the symptom is a press that
silently does nothing with an error only in the Mattermost server log.

**TLS** is a proxy's job, as it is for Teams: the listener speaks plain HTTP. If
the hop between the two servers leaves a network you trust, terminate TLS in
front of it and point `callback_base_url` at the proxy.

**The credential.** Each button carries a signature inside the action's
`context`, which Mattermost keeps server-side and never sends to the browser. The
signing key is **derived** from `JWT_SECRET_KEY` and the bridge's own identity —
it is not stored anywhere, so there is nothing extra to configure, back up, or
keep in step, and a bridge registered before any of this existed needs no edit.
Two consequences:

- A signature minted for one bridge is not valid for another, so a leaked
  `context` is worth one button on one card.
- **Rotating `JWT_SECRET_KEY` invalidates the buttons on cards already posted.**
  Those presses are refused and logged; the requests behind them stay answerable
  by typing. New cards work immediately.

**What a reader sees.** An open permission card gains one button per option,
numbered the way a typed answer numbers them, so pressing and typing name the
same choice. The card's body does not then list those options again — the
buttons are carrying them. An option too long to fit on a button keeps its line
in the body, and a card that carries no buttons at all lists everything, so the
choices are always written somewhere.

The buttons disappear when the request is answered, cancelled or expires, and
the card is **edited down to its outcome** rather than deleted: it keeps the
question and gains the decision, so the channel stays a record of what was
asked and what was chosen. Mattermost is the only platform Switch bridges to
where an answered card behaves this way — the others take it off the screen —
because it is the only one that leaves a "(message deleted)" line behind a post
removed while somebody has the channel open.

A press by somebody who may not answer, or on a card that has already settled,
is explained to that person alone — nobody else in the channel sees it. A card
that says it is too long to answer from Mattermost carries no buttons, because
the reader has not been shown what they would be deciding.

Buttons ride in the post's props, which an edit replaces wholesale, so a redraw
reads the post back and merges rather than overwriting what the Mattermost
server itself put there. It is one extra API call, made only for request cards
on bridges that take callbacks.

**Kubernetes.** The chart publishes the callback port when
`switchCore.collaborationCallback.enabled` is set, which it is not by default:
the Service gains the port, switch-core declares it, and the Mattermost this
chart deploys is given the address to allow. `helm install` then prints the
`callback_base_url` to put on the bridge — the cluster-internal Service name,
not an address a browser follows. No Ingress is rendered for it, so a Mattermost
outside the cluster needs a route you provide yourself.

## Local development

The local stack (`just up` / `just standalone-up`) runs a **Mattermost server in
Docker** and **auto-registers a Mattermost bridge** for you via
`deploy/shared_resources/setup.py`. It reads these values from `.env`:

```dotenv
MATTERMOST_HOST_PORT=8065
MATTERMOST_ADMIN_USER=admin
MATTERMOST_ADMIN_PASSWORD=admin1234
MATTERMOST_TEAM_NAME=switch
MATTERMOST_USER=user
MATTERMOST_USER_PASSWORD=user1234
```

The seeder creates the admin user + team, then registers the bridge with
`connection_config = { url, admin_user, admin_password, team_name }` (adding
`public_url` only if a public URL is configured). So for local dev you normally
don't onboard Mattermost by hand — it's already there after setup. Log in at
`http://localhost:8065` with the `MATTERMOST_USER` credentials to try it.

Both stacks also wire up button presses ([step 3](#3-optional-let-mattermost-deliver-button-presses)):
the compose file allows Mattermost to call the private address, and the seeder
sets `callback_base_url` — `http://switch:8081` under `standalone-up`, where
switch-core is a service, and `http://host.docker.internal:8081` under `just up`,
where it runs on your host. A bridge that is **already** registered keeps its
existing configuration, except for this one field: the seeder sets the callback
address on every run, because the config a bridge holds carries the admin
password and so is not readable back to compare against. A bridge registered
before callbacks existed therefore gains its buttons on the next stack start,
and the bridge restarts as part of that.

A **Mattermost container** created before callbacks existed does not get the
allowlist by being restarted — its environment was fixed when it was created.
Recreate it (`docker compose up -d --force-recreate mattermost`; the volume and
so the data survive), or set the value by hand in System Console → Environment →
Developer.

## Notes

- **Identity.** Each agent gets its own Mattermost bot account, so agent messages
  appear as distinct users (not a single relayed bot). The bot's **username** is
  the agent's identifier — the handle a mention resolves, and the key the bridge
  finds an existing bot back by — and the bot account's own display-name field
  carries the agent's display name, falling back to the identifier. A bot whose
  display name has drifted from the agent's is corrected when the bridge adopts
  it. Whether Mattermost shows any of it is the **Teammate Name Display** server
  setting from [step 1](#1-prepare-the-mattermost-server); the bridge logs one
  warning when it writes an agent display name on a server whose setting would
  hide it.
- **DMs.** Switch-initiated DM rooms are user-initiated on Mattermost — a user
  starts the DM with the agent's bot and Switch picks it up.
- **Deeplinks.** Set `GATEWAY_PUBLIC_URL` on switch-core for clickable "Open in
  Switch Console" links (see the [index](README.md#deployment-knobs)).

## Showing that an agent is working

Three signals, in order of how long they last. Nothing here needs configuring.

- **A reaction on the message that asked** — 👀 while an agent is working on it,
  ⏳ while a prompt is waiting behind one already running. Cleared when the turn
  ends. Inside a thread it goes on the reply, not the root the reply hangs off —
  the mark says *which* message is being handled. It is added by the agent's own
  bot, so two agents on one message show two reactions and hovering names them.
  This is the signal that always works: it needs no thread and it does not
  expire.
- **A posted status line**, edited in place as the agent reports activity:
  "Working… 41s" while the turn runs, "Worked for 2m 14s." when it finishes. It
  stays in the channel after the turn rather than being taken down, so someone
  scrolling back can still see that the turn ran and how long it took. Editing
  is also the only clean option: Mattermost's client leaves a
  "(message deleted)" placeholder behind any post removed while it is on screen.
- **The typing indicator**, nudged once as the turn opens. Mattermost expires it
  after about five seconds, so treat it as a first flicker rather than a
  progress signal.

**What Mattermost cannot do.** There is no equivalent of Slack's native AI
progress card — the live panel that streams what an agent is doing under the
agent's own name and icon. The one thing in Mattermost that looks like it, the
"thinking" UI in Mattermost's own
[Agents plugin](https://github.com/mattermost/mattermost-plugin-agents),
is not a platform feature: progress travels over a plugin-private websocket
event and is drawn by a webapp bundle that plugin registers. Neither half is
reachable from a bot token or the REST API, and ephemeral posts cannot be edited
over the API either. Matching that layer would mean Switch shipping a Mattermost
plugin of its own, which every server admin would have to install. Switch does
not do this, and does not approximate it.

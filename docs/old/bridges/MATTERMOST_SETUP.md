# Mattermost collaboration bridge setup

Connects a Mattermost server to Switch. Unlike the single-bot platforms,
Mattermost uses **one bot account per Switch agent**, created and driven through
an **admin account** you supply. Inbound messages arrive over Mattermost's
WebSocket (an outbound connection from Switch), so **no public ingress is
required**.

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

On success the bridge logs in as the admin, resolves the team, and starts its
WebSocket. Per-agent bot accounts are created as agents are used.

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

- **👀 on the message that asked.** Added when the agent picks the message up and
  removed when its turn ends. Inside a thread it goes on the reply, not the root
  the reply hangs off — the mark says *which* message is being handled. It is
  added by the agent's own bot, so two agents on one message show two
  reactions and hovering names them. This is the signal that always works: it
  needs no thread and it does not expire.
- **A posted status line** — "⚙️ Working on it…", edited in place as the agent
  reports activity and retired to "✓ Done · 2m14s" when the turn finishes. It is
  edited rather than deleted because Mattermost's client leaves a
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

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

## 2. Onboard the bridge in Switch

As a gateway admin, onboard the bridge from the **operator dashboard**:
**Messaging Apps → Add bridge → Mattermost**, give it a display name (e.g. "Acme
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
  appear as distinct users (not a single relayed bot).
- **DMs.** Switch-initiated DM rooms are user-initiated on Mattermost — a user
  starts the DM with the agent's bot and Switch picks it up.
- **Deeplinks.** Set `GATEWAY_PUBLIC_URL` on switch-core for clickable "Open in
  Switch Console" links (see the [index](README.md#deployment-knobs)).

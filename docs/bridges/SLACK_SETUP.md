# Slack collaboration bridge setup

Connects a Slack workspace to Switch. A **single Slack app** (one bot) backs
every Switch agent; per-agent presentation is done with per-message username +
avatar overrides. Inbound events arrive over **Socket Mode** — an outbound
WebSocket the bot opens to Slack — so **no public ingress is required**. Outbound
messages go through the Slack Web API.

## Prerequisites

- A Slack workspace where you can install a custom app (workspace admin approval
  may be required).
- The Switch gateway reachable by an admin to onboard the bridge.

## 1. Create the Slack app

1. Go to <https://api.slack.com/apps> → **Create New App** → **From scratch**.
   Name it (e.g. "Agent Switch") and pick the target workspace.
2. **Enable Socket Mode** (Settings → Socket Mode). This generates an
   **app-level token** (`xapp-…`) with the `connections:write` scope — save it;
   it is the `app_token`.

## 2. Bot token scopes

Under **OAuth & Permissions → Scopes → Bot Token Scopes**, add the scopes the
bridge needs. These follow directly from the Web API calls the adapter makes:

| Scope | Why (adapter call) |
| --- | --- |
| `chat:write` | post / edit / delete agent messages (`chat.postMessage`, `chat.update`, `chat.delete`) |
| `channels:manage` | create public channels + set topic + invite (`conversations.create`, `conversations.setTopic`, `conversations.invite`) |
| `groups:write` | same operations for private channels |
| `channels:read`, `groups:read` | look up channel info (`conversations.info`) |
| `users:read` | resolve user display names (`users.info`) |
| `files:write` | relay agent image attachments (`files.upload` v2) |

## 3. Event subscriptions

Under **Event Subscriptions**, subscribe the **bot** to the events the bridge
consumes (delivered over Socket Mode — no request URL needed):

- `message.channels`, `message.groups`, `message.im`, `message.mpim` — inbound
  messages in public/private channels, DMs, and group DMs.
- `member_joined_channel` — so the bridge notices the app (and users) joining a
  channel and provisions the room.
- `app_mention` — so a message that tags the app itself is recognised.

Enable **Slash Commands** if you want the bridge's `/…` commands in Slack.

## 4. Install and collect credentials

1. **Install App** to the workspace. Copy the **Bot User OAuth Token**
   (`xoxb-…`) — this is the `bot_token`.
2. Note the **workspace id** (`T…`) — this is `workspace_id`. (Workspace →
   Settings, or from any message link.)
3. Invite the app to the channels you want bridged (`/invite @Agent Switch`).
   The bridge provisions a Switch room when the app joins a channel.

## 5. Onboard the bridge in Switch

As a gateway admin, create the bridge (operator dashboard → add bridge, or the
API directly):

```http
POST /gateway/collaborations
{
  "bridge_type": "slack",
  "display_name": "Acme Slack",
  "connection_config": {
    "bot_token": "xoxb-…",
    "app_token": "xapp-…",
    "workspace_id": "T01234567"
  }
}
```

`connection_config` fields (`SlackConnectionConfig`):

| Field | Required | Description |
| --- | --- | --- |
| `bot_token` | yes | Bot User OAuth token (`xoxb-…`) — outbound Web API. |
| `app_token` | yes | App-level token (`xapp-…`, `connections:write`) — Socket Mode. |
| `workspace_id` | yes | Slack workspace/team id (`T…`). |

On success the bridge starts its Socket Mode session immediately. Add the app to
a channel (or create a bridged room) to start relaying.

## Notes

- **Deeplinks.** Slack linkifies `http(s)`, so "Open in SwitchDash" links work
  once `GATEWAY_PUBLIC_URL` is set on switch-core (see the
  [index](README.md#deployment-knobs)); otherwise the raw `switchdash://` link is
  posted.
- **Local dev.** There is no local Slack — Slack always points at a real
  workspace onboarded through the gateway. (Local dev seeds only Mattermost.)

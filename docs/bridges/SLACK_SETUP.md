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

You need one Slack app for the whole bridge. There are two ways to create it —
**the manifest path is strongly recommended**, it is far less error-prone.

### Recommended: from an app manifest

1. Go to <https://api.slack.com/apps> → **Create New App** → **From an app
   manifest**.
2. Select the target workspace.
3. Paste the manifest below and create the app. It pre-configures the bot token
   scopes, all of Switch's `/…` slash commands, Socket Mode, event subscriptions,
   interactivity, and the app home in one step — so you can skip the manual scope
   and event setup entirely.

<details>
<summary><strong>Agent Switch app manifest</strong> (paste this)</summary>

```json
{
    "display_information": {
        "name": "Agent Switch"
    },
    "features": {
        "app_home": {
            "home_tab_enabled": true,
            "messages_tab_enabled": false,
            "messages_tab_read_only_enabled": false
        },
        "bot_user": {
            "display_name": "Agent Switch",
            "always_online": false
        },
        "slash_commands": [
            { "command": "/admin", "description": "Toggle admin mode on/off for this room", "should_escape": false },
            { "command": "/help", "description": "Show the list of available in-room commands", "should_escape": false },
            { "command": "/reset", "description": "Reset a targeted agent's session (clears context, then reconnects)", "usage_hint": "@agent-name | @role (required)", "should_escape": true },
            { "command": "/reset-all-agents", "description": "Reset EVERY agent's session in this room", "should_escape": false },
            { "command": "/compact", "description": "Compact a targeted agent's session context", "usage_hint": "@agent-name | @role (required)", "should_escape": true },
            { "command": "/compact-all-agents", "description": "Compact EVERY agent's session context in this room", "should_escape": false },
            { "command": "/interrupt", "description": "Interrupt a targeted agent's current turn", "usage_hint": "@agent-name | @role (required)", "should_escape": true },
            { "command": "/interrupt-all-agents", "description": "Interrupt EVERY agent's current turn in this room", "should_escape": false },
            { "command": "/agents-status", "description": "Show each agent's presence and capabilities in this room", "should_escape": false },
            { "command": "/roles", "description": "List this room's roles and who currently holds each", "should_escape": false },
            { "command": "/list-agents", "description": "List the agents available in this room", "should_escape": false },
            { "command": "/list-switch-agents", "description": "List all agents registered on the Switch", "should_escape": false },
            { "command": "/list-documents", "description": "List the room's internal documents", "should_escape": false },
            { "command": "/list-references", "description": "List the room's references", "should_escape": false },
            { "command": "/list-aliases", "description": "List per-room agent aliases (@alias to agent)", "should_escape": false },
            { "command": "/set-alias", "description": "Give an agent a room alias", "usage_hint": "@agent-name @alias", "should_escape": true },
            { "command": "/remove-alias", "description": "Remove a room alias", "usage_hint": "@alias (or @agent-name)", "should_escape": true },
            { "command": "/invite-agent", "description": "Add an existing agent to this room", "usage_hint": "@agent-name", "should_escape": true },
            { "command": "/run-cmd", "description": "Show the terminal command to start a session for an agent", "usage_hint": "@agent-name [@role]", "should_escape": true },
            { "command": "/agents-greet", "description": "Have agents in the room introduce themselves", "should_escape": false },
            { "command": "/room-url", "description": "Show the frontend URL for this room", "should_escape": false }
        ]
    },
    "oauth_config": {
        "scopes": {
            "bot": [
                "files:read",
                "files:write",
                "assistant:write",
                "channels:history",
                "channels:manage",
                "channels:read",
                "chat:write",
                "chat:write.customize",
                "commands",
                "groups:history",
                "groups:read",
                "groups:write",
                "im:history",
                "im:read",
                "im:write",
                "mpim:history",
                "reactions:read",
                "reactions:write",
                "users:read"
            ]
        },
        "pkce_enabled": false
    },
    "settings": {
        "event_subscriptions": {
            "bot_events": [
                "message.channels",
                "message.groups",
                "message.im",
                "message.mpim"
            ]
        },
        "interactivity": {
            "is_enabled": true
        },
        "org_deploy_enabled": false,
        "socket_mode_enabled": true,
        "token_rotation_enabled": false,
        "is_mcp_enabled": false
    }
}
```

</details>

Then continue with [Generate tokens and install](#2-generate-tokens-and-install).

### Alternative: from scratch (manual)

1. **Create New App → From scratch**, name it (e.g. "Agent Switch"), and pick the
   workspace.
2. Configure the **bot token scopes**, **event subscriptions**, **slash
   commands**, and enable **Socket Mode** + **interactivity** by hand — see the
   [App configuration reference](#app-configuration-reference) below for the exact
   values (they mirror the manifest).

## 2. Generate tokens and install

Regardless of how you created the app:

1. **App-level token (Socket Mode).** Under **Basic Information → App-Level
   Tokens**, generate a token with the `connections:write` scope — this is the
   `app_token` (`xapp-…`). (Socket Mode is already enabled by the manifest; on the
   from-scratch path, enable it under **Settings → Socket Mode** first.)
2. **Install to workspace.** **Install App** → copy the **Bot User OAuth Token**
   (`xoxb-…`) — this is the `bot_token`.
3. **Workspace id.** Note the workspace/team id (`T…`) — this is `workspace_id`
   (Workspace → Settings, or from any message link).
4. **Invite the app** to the channels you want bridged (`/invite @Agent Switch`).
   The bridge provisions a Switch room when the app joins a channel.

## 3. Onboard the bridge in Switch

As a gateway admin, onboard the bridge from the **operator dashboard**:
**Messaging Apps → Register messaging app → Slack**, give it a display name (e.g. "Acme
Slack"), and fill in the fields below.

Fields (`SlackConnectionConfig`):

| Field | Required | Description |
| --- | --- | --- |
| `bot_token` | yes | Bot User OAuth token (`xoxb-…`) — outbound Web API. |
| `app_token` | yes | App-level token (`xapp-…`, `connections:write`) — Socket Mode. |
| `workspace_id` | yes | Slack workspace/team id (`T…`). |

On save the bridge starts its Socket Mode session immediately. Add the app to a
channel (or create a bridged room) to start relaying.

## App configuration reference

The manifest above already sets all of this — this section is for the
from-scratch path and as a reference for what the app needs.

### Bot token scopes

Under **OAuth & Permissions → Scopes → Bot Token Scopes**:

- `chat:write`, `chat:write.customize` — post agent messages, with the
  per-message username + avatar override each agent is presented under.
- `commands` — the `/…` slash commands.
- `channels:read`, `channels:manage` — look up, create, set topic on, and invite
  into public channels; `groups:read`, `groups:write` — the same for private
  channels.
- `channels:history`, `groups:history`, `im:history`, `mpim:history` — read
  channel / DM / group-DM message history for context.
- `im:read`, `im:write` — direct messages.
- `users:read` — resolve user display names.
- `files:read`, `files:write` — relay attachments (incl. agent image uploads).
- `reactions:read`, `reactions:write` — reaction-based acknowledgements.
- `assistant:write` — assistant/app-home surface.

### Event subscriptions (over Socket Mode)

Subscribe the **bot** to (no request URL is needed with Socket Mode):

- `message.channels`, `message.groups`, `message.im`, `message.mpim` — inbound
  messages in public/private channels, DMs, and group DMs.

A message that tags the app itself is recognised from these `message.*` events
(the bridge detects its own bot mention inline), so a separate `app_mention`
subscription is not required.

### Interactivity and slash commands

Enable **Interactivity** and add the `/…` slash commands (the full set is in the
manifest) so Switch's in-room commands work from Slack.

## Notes

- **Deeplinks.** Slack linkifies `http(s)`, so "Open in Switch Console" links work
  once `GATEWAY_PUBLIC_URL` is set on switch-core (see the
  [index](README.md#deployment-knobs)); otherwise the raw `switchdash://` link is
  posted.
- **Local dev.** There is no local Slack — Slack always points at a real
  workspace onboarded through the gateway. (Local dev seeds only Mattermost.)

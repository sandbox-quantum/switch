# The distributed Slack app

`SLACK_SETUP.md` describes the app **an operator registers for themselves**:
they create it, install it into their own workspace, and paste its tokens into
Switch. This page describes the other one — the app **we** register and
distribute, which a customer installs by clicking a button and which never
requires them to see a token at all.

They are two separate Slack apps and they will both exist. Nothing here
replaces the other page.

## Why it cannot be the same app

The self-registered app uses **Socket Mode**: Switch dials out to Slack and
events arrive down that connection, so the deployment needs no inbound route
from the internet. That is the right shape for a self-hosted operator and the
wrong shape here, for two independent reasons:

- Slack does not permit Socket Mode for apps listed on the Marketplace.
- A Socket Mode connection is opened with one app-level token by one process.
  Every installing workspace's events would arrive down that single socket, so
  the moment Switch runs more than one replica the events land on whichever
  replica happens to hold the connection.

So the distributed app receives events over HTTPS instead, at a public URL.
That is the whole of the difference, and everything below follows from it.

## The four URLs

Every URL is the same host with a different path. The host is the public
origin of the deployment — the same value as `GATEWAY_PUBLIC_URL`, which is
already validated as scheme-and-host with no path and already serves the
deeplink redirect from the same application.

| Slack setting | Path |
| --- | --- |
| **OAuth & Permissions → Redirect URLs** | `/messaging/slack/oauth/callback` |
| **Event Subscriptions → Request URL** | `/messaging/slack/events` |
| **Interactivity & Shortcuts → Request URL** | `/messaging/slack/interactive` |
| **Slash Commands → each command's URL** | `/messaging/slack/commands` |

`/messaging` is a public prefix in its own right: it is unauthenticated by
nature, because a Slack event arrives with no credential of ours and an OAuth
callback arrives before there is anything to authenticate against. It is
deliberately not `/gateway` — that prefix is cookie-authenticated and is not
routed to this application from the outside — and deliberately not `/oauth`,
which already belongs to agents authenticating *to* Switch and would collide
in name only, confusingly.

Reaching it from the internet needs the prefix added in two places: the
application's own public-path list, and the deployment's ingress path
allowlist.

## Registering the app

**Slack verifies the Request URL the moment you save it**, by posting a
challenge it expects the endpoint to echo back. So the order matters: you can
create the app and collect its credentials before the endpoints exist, but you
cannot fill in the URL fields until they are live and publicly reachable.

1. <https://api.slack.com/apps> → **Create New App** → **From an app
   manifest**, in a workspace we control. Paste the manifest below, with the
   host substituted.
2. **Basic Information → App Credentials.** Take the **Client ID**, **Client
   Secret** and **Signing Secret**. The signing secret is what proves an
   inbound webhook came from Slack; the client id and secret are what exchange
   an install code for a bot token. There is no app-level token and no bot
   token here — a bot token belongs to an installation, not to the app, and
   arrives one per customer.
3. **Manage Distribution → Activate Public Distribution.** This is what makes
   the app installable outside our own workspace and produces the *Add to
   Slack* URL. Slack requires every hardcoded workspace reference to be removed
   first.
4. Marketplace listing is a separate, reviewed submission, and is not required
   for a customer to install by link.

## Manifest

Substitute the host in the four `url` fields. The scopes, slash commands and
bot events are identical to the self-registered app's, because the app does
the same job once installed — the differences are all in `settings` and
`oauth_config`.

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
            { "command": "/admin", "url": "https://HOST/messaging/slack/commands", "description": "Toggle admin mode on/off for this room", "should_escape": false },
            { "command": "/help", "url": "https://HOST/messaging/slack/commands", "description": "Show the list of available in-room commands", "should_escape": false },
            { "command": "/reset", "url": "https://HOST/messaging/slack/commands", "description": "Reset a targeted agent's session (clears context, then reconnects)", "usage_hint": "@agent-name | @role (required)", "should_escape": true },
            { "command": "/reset-all-agents", "url": "https://HOST/messaging/slack/commands", "description": "Reset EVERY agent's session in this room", "should_escape": false },
            { "command": "/compact", "url": "https://HOST/messaging/slack/commands", "description": "Compact a targeted agent's session context", "usage_hint": "@agent-name | @role (required)", "should_escape": true },
            { "command": "/compact-all-agents", "url": "https://HOST/messaging/slack/commands", "description": "Compact EVERY agent's session context in this room", "should_escape": false },
            { "command": "/interrupt", "url": "https://HOST/messaging/slack/commands", "description": "Interrupt a targeted agent's current turn", "usage_hint": "@agent-name | @role (required)", "should_escape": true },
            { "command": "/interrupt-all-agents", "url": "https://HOST/messaging/slack/commands", "description": "Interrupt EVERY agent's current turn in this room", "should_escape": false },
            { "command": "/agents-status", "url": "https://HOST/messaging/slack/commands", "description": "Show each agent's presence and capabilities in this room", "should_escape": false },
            { "command": "/roles", "url": "https://HOST/messaging/slack/commands", "description": "List this room's roles and who currently holds each", "should_escape": false },
            { "command": "/list-agents", "url": "https://HOST/messaging/slack/commands", "description": "List the agents available in this room", "should_escape": false },
            { "command": "/list-switch-agents", "url": "https://HOST/messaging/slack/commands", "description": "List all agents registered on the Switch", "should_escape": false },
            { "command": "/list-documents", "url": "https://HOST/messaging/slack/commands", "description": "List the room's internal documents", "should_escape": false },
            { "command": "/list-references", "url": "https://HOST/messaging/slack/commands", "description": "List the room's references", "should_escape": false },
            { "command": "/list-aliases", "url": "https://HOST/messaging/slack/commands", "description": "List per-room agent aliases (@alias to agent)", "should_escape": false },
            { "command": "/set-alias", "url": "https://HOST/messaging/slack/commands", "description": "Give an agent a room alias", "usage_hint": "@agent-name @alias", "should_escape": true },
            { "command": "/remove-alias", "url": "https://HOST/messaging/slack/commands", "description": "Remove a room alias", "usage_hint": "@alias (or @agent-name)", "should_escape": true },
            { "command": "/invite-agent", "url": "https://HOST/messaging/slack/commands", "description": "Add an existing agent to this room", "usage_hint": "@agent-name", "should_escape": true },
            { "command": "/run-cmd", "url": "https://HOST/messaging/slack/commands", "description": "Show the terminal command to start a session for an agent", "usage_hint": "@agent-name [@role]", "should_escape": true },
            { "command": "/agents-greet", "url": "https://HOST/messaging/slack/commands", "description": "Have agents in the room introduce themselves", "should_escape": false },
            { "command": "/room-url", "url": "https://HOST/messaging/slack/commands", "description": "Show the frontend URL for this room", "should_escape": false }
        ]
    },
    "oauth_config": {
        "redirect_urls": [
            "https://HOST/messaging/slack/oauth/callback"
        ],
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
                "users:read",
                "usergroups:read",
                "usergroups:write"
            ]
        },
        "pkce_enabled": false
    },
    "settings": {
        "event_subscriptions": {
            "request_url": "https://HOST/messaging/slack/events",
            "bot_events": [
                "message.channels",
                "message.groups",
                "message.im",
                "message.mpim"
            ]
        },
        "interactivity": {
            "is_enabled": true,
            "request_url": "https://HOST/messaging/slack/interactive"
        },
        "org_deploy_enabled": false,
        "socket_mode_enabled": false,
        "token_rotation_enabled": false,
        "is_mcp_enabled": false
    }
}
```

## Three things left out on purpose

**`agent_view`.** The self-registered app declares itself a Slack agent, which
is what turns DMs into threads and puts progress on the message. Declaring it
is irreversible per app, removes guest access from the workspace, and requires
re-review for a distributed app. It should be a deliberate later step with
that review budgeted, not something a customer discovers after installing.

**`org_deploy_enabled`.** An Enterprise Grid org-wide install identifies itself
by enterprise id rather than by a single workspace id. `messaging_installs` is
unique on `(platform, external_workspace_id)` and an org install does not have
one of those, so enabling this is a schema question and not a checkbox.

**`token_rotation_enabled`.** Rotating tokens means storing a refresh token,
refreshing before expiry, and handling a refresh that fails while events are
arriving. Worth doing, and not worth doing at the same time as everything
else; a non-rotating bot token is what the self-registered app already uses.

## What a customer's install produces

One row in `messaging_installs`: the workspace it was installed into, the bot
token that install granted (encrypted), the scopes Slack actually approved,
and the tenant and user who initiated it. `(platform, external_workspace_id)`
is unique across the whole deployment, because an inbound event carries a
workspace id and no tenant — a workspace claimed by two tenants would be an
event with two possible destinations. A second tenant attempting to claim an
already-claimed workspace is refused by the database.

# The distributed Slack app

`SLACK_SETUP.md` describes the app **an operator registers for themselves**:
they create it, install it into their own workspace, and paste its tokens into
Switch. This page describes the other one — the app **we** register and
distribute, which a customer installs by clicking a button and which never
requires them to see a token at all.

They are two separate Slack apps and they will both exist. Nothing here
replaces the other page.

The install connects a workspace to a tenant that **already exists**. Creating
a tenant is Switch Console's job and is not reachable from Slack: the flow
begins with an authenticated admin inside the tenant they are installing into,
so no amount of clicking in Slack brings a tenant into being.

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

Every URL is the same host with a different path. The host is
**`MESSAGING_PUBLIC_URL`**: scheme and host, no path, https only, and the
origin Slack itself dials.

It is deliberately not `GATEWAY_PUBLIC_URL`. That one is the host a *person*
lands on following an "Open in Switch Console" deeplink, and on many
deployments it is reachable only over a private network — which is fine for a
person and useless to Slack. Pointing it at an internet-facing host to satisfy
Slack would move every deeplink to that host as a side effect, so the two are
separate settings and a deployment may set either, both, or neither.

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
bot events are the self-registered app's, because the app does the same job
once installed. The differences are in `settings` and `oauth_config`, and the
`switch-` in front of each command.

Every command starts with `switch-` (`/switch-reset` runs `!reset`): every
app in a Slack workspace shares one set of slash command names, so an app
installed into other people's workspaces must not take `/help` or `/reset`,
and Slack's Marketplace review asks for exactly this. Switch accepts the bare
names too, from any app, so a self-registered app keeps the names it was made
with. A test holds this list to the commands the server has.

`/switch-auto-route` belongs only on an app whose server has the `decision_routing`
feature flag on. A server with it off does not have the command, and answers
it with "Unknown command", so leave it out of that server's app until
auto-route is turned on there.

```json
{
    "display_information": {
        "name": "Agent Switch"
    },
    "features": {
        "app_home": {
            "home_tab_enabled": true,
            "messages_tab_enabled": true,
            "messages_tab_read_only_enabled": true
        },
        "bot_user": {
            "display_name": "Agent Switch",
            "always_online": false
        },
        "slash_commands": [
            { "command": "/switch-help", "url": "https://HOST/messaging/slack/commands", "description": "Show the commands", "should_escape": false },
            { "command": "/switch-reset", "url": "https://HOST/messaging/slack/commands", "description": "Reset an agent's session", "usage_hint": "<target>", "should_escape": true },
            { "command": "/switch-reset-all-agents", "url": "https://HOST/messaging/slack/commands", "description": "Reset every agent's session here", "should_escape": false },
            { "command": "/switch-compact", "url": "https://HOST/messaging/slack/commands", "description": "Compact an agent's context", "usage_hint": "<target>", "should_escape": true },
            { "command": "/switch-compact-all-agents", "url": "https://HOST/messaging/slack/commands", "description": "Compact every agent's context here", "should_escape": false },
            { "command": "/switch-interrupt", "url": "https://HOST/messaging/slack/commands", "description": "Stop an agent's current turn", "usage_hint": "<target>", "should_escape": true },
            { "command": "/switch-interrupt-all-agents", "url": "https://HOST/messaging/slack/commands", "description": "Stop every agent's current turn here", "should_escape": false },
            { "command": "/switch-list-agents", "url": "https://HOST/messaging/slack/commands", "description": "List the agents here", "should_escape": false },
            { "command": "/switch-agents-status", "url": "https://HOST/messaging/slack/commands", "description": "Show each agent's status", "should_escape": false },
            { "command": "/switch-roles", "url": "https://HOST/messaging/slack/commands", "description": "List roles and who holds them", "should_escape": false },
            { "command": "/switch-list-documents", "url": "https://HOST/messaging/slack/commands", "description": "List the room's documents", "should_escape": false },
            { "command": "/switch-list-references", "url": "https://HOST/messaging/slack/commands", "description": "List the room's references", "should_escape": false },
            { "command": "/switch-list-aliases", "url": "https://HOST/messaging/slack/commands", "description": "List agent aliases here", "should_escape": false },
            { "command": "/switch-follow-ups", "url": "https://HOST/messaging/slack/commands", "description": "Turn follow-ups on or off", "usage_hint": "<state>", "should_escape": true },
            { "command": "/switch-auto-route", "url": "https://HOST/messaging/slack/commands", "description": "Let Switch pick who answers untagged messages", "usage_hint": "<state>", "should_escape": true },
            { "command": "/switch-assign-agent", "url": "https://HOST/messaging/slack/commands", "description": "Send every message here to one agent", "usage_hint": "<agent>", "should_escape": true },
            { "command": "/switch-unassign-agent", "url": "https://HOST/messaging/slack/commands", "description": "Stop sending every message to one agent", "should_escape": false },
            { "command": "/switch-add-room-admin", "url": "https://HOST/messaging/slack/commands", "description": "Make someone a room admin", "usage_hint": "<person>", "should_escape": true },
            { "command": "/switch-remove-room-admin", "url": "https://HOST/messaging/slack/commands", "description": "Remove a room admin", "usage_hint": "<person>", "should_escape": true },
            { "command": "/switch-list-room-admins", "url": "https://HOST/messaging/slack/commands", "description": "Show the room's owner and admins", "should_escape": false },
            { "command": "/switch-set-alias", "url": "https://HOST/messaging/slack/commands", "description": "Give an agent a room alias", "usage_hint": "<agent> <alias>", "should_escape": true },
            { "command": "/switch-remove-alias", "url": "https://HOST/messaging/slack/commands", "description": "Remove a room alias", "usage_hint": "<alias>", "should_escape": true },
            { "command": "/switch-invite-agent", "url": "https://HOST/messaging/slack/commands", "description": "Add an agent to this room", "usage_hint": "<agent>", "should_escape": true },
            { "command": "/switch-remove-agent", "url": "https://HOST/messaging/slack/commands", "description": "Remove an agent from this room", "usage_hint": "<agent>", "should_escape": true },
            { "command": "/switch-remove-user", "url": "https://HOST/messaging/slack/commands", "description": "Remove a person from this room", "usage_hint": "<person>", "should_escape": true },
            { "command": "/switch-link-account", "url": "https://HOST/messaging/slack/commands", "description": "Link this chat account with a code", "usage_hint": "<code>", "should_escape": true },
            { "command": "/switch-unlink-account", "url": "https://HOST/messaging/slack/commands", "description": "Show or remove your linked Switch users", "usage_hint": "<user>", "should_escape": true },
            { "command": "/switch-rename-agent", "url": "https://HOST/messaging/slack/commands", "description": "Rename an agent", "usage_hint": "<agent> <new_name> <display_name>", "should_escape": true },
            { "command": "/switch-delete-agent", "url": "https://HOST/messaging/slack/commands", "description": "Delete an agent everywhere", "usage_hint": "<agent> <confirm>", "should_escape": true },
            { "command": "/switch-room-url", "url": "https://HOST/messaging/slack/commands", "description": "Show this room's web address", "should_escape": false },
            { "command": "/switch-list-switch-agents", "url": "https://HOST/messaging/slack/commands", "description": "List every agent on this server", "should_escape": false },
            { "command": "/switch-agents-greet", "url": "https://HOST/messaging/slack/commands", "description": "Have the agents introduce themselves", "should_escape": false }
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
                "message.mpim",
                "subteam_updated"
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

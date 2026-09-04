# Connect Slack

_Put your Switch agents in a Slack workspace, so a channel becomes a room_

Published at <https://docs.flintai.dev/flintai/switch/deploy/messaging-apps/slack> — link readers there, not to this file.

Slack is the quickest platform to connect. One Slack app backs every agent on your Switch server, and Slack posts each agent under its own name and icon, so a room reads like a conversation with a team rather than with one relay bot.

Slack reaches Switch over a connection Switch opens outwards, so **nothing needs to be publicly reachable**. This works from a laptop.

## Before you begin

- **A Slack workspace where you can install a custom app.** Many workspaces require admin approval for this; get it first, because the install step fails without it.
- **An admin account on the Switch server** you're connecting to. If Switch Console set that server up for you, you have one.

## Set up Slack

### Create the Slack app from a manifest

Go to [Slack API apps](https://api.slack.com/apps), select **Create New App**, then **From an app manifest**. Choose your workspace, paste the manifest below, and create the app.

The manifest configures the permissions, the events, the Switch slash commands, Socket Mode and the app home in one step, which is why it's worth using over building the app by hand.

It also asks for the user group scopes and declares the app an **Agent**. Both are about how agents look in Slack rather than whether the bridge works, and you choose whether to use either one when you connect.

**Warning**

Declaring the app an Agent removes access to it for workspace guests, and turns every direct message with it into a thread. Pasting the manifest applies both, and neither can be undone. If guests use Slack in your workspace, delete the `agent_view` block from the manifest before you paste it.

### Agent Switch app manifest

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
        "agent_view": {
            "agent_description": "Switch agents. Mention one by name in a channel and it answers there; its progress appears on the message while it works."
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
                "users:read",
                "usergroups:read",
                "usergroups:write"
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

**Note**

Slack reads the slash commands from the manifest once, when you create the app — it doesn't pick up commands Switch adds later. If a command Switch documents doesn't appear in your workspace, compare your app against the [current manifest](https://github.com/sandbox-quantum/switch/blob/main/docs/bridges/SLACK_SETUP.md) and add what's missing.

You can also build the app from scratch and configure it by hand. See [Configure the app by hand](#configure-the-app-by-hand) for the values to set.

### Generate the app-level token

In the app, open **Basic Information**, find **App-Level Tokens**, and generate a token with the `connections:write` scope. It starts with `xapp-`. This is what lets Slack push events to Switch without a public address.

### Install the app and copy the bot token

Select **Install App** and install it to your workspace. Copy the **Bot User OAuth Token** — it starts with `xoxb-`.

### Note your workspace id

You need the workspace (team) id, which starts with `T`. It's in your workspace settings, and it's also the first path segment of any Slack message link.

## Connect Slack to your Switch server

### Open the messaging apps for your server

In Switch Console, select the server in the sidebar switcher and open its **Home** page. **Messaging apps** lists what's connected.

### Start the connection

Select **Connect**, then choose **Slack** under **Messaging app**.

If there's no **Connect** button, you're signed in to that server without admin rights. Connecting a messaging app is an administrator action, so ask whoever runs the server.

### Name the connection

**Name** is how this connection is labeled in Switch Console when you pick it for a room, so name it after the workspace — "Acme Slack" rather than "Slack".

### Paste in what you gathered

- **Bot Token** — the `xoxb-` token from installing the app.
- **App Token** — the `xapp-` app-level token.
- **Workspace Id** — the `T…` id.

The token fields are masked as you type and aren't shown again afterwards.

### Decide whether Switch may create channels

**Allow creating channels from Switch** is on by default, and it's what lets a room created in Switch — by you or by an agent — get a Slack channel to go with it. Turn it off if channels in your workspace should only ever be made in Slack.

### Decide how agents appear in Slack

These checkboxes settle how much of Slack's own interface your agents get. They're on by default, and they're about how agents look rather than whether the bridge works.

- **Agent name autocomplete** — an agent's name completes when you type `@` in a channel. Needs a paid Slack plan, and permission for the bot to manage user groups.
- **Native progress card** — an agent's progress appears in Slack's own live card rather than in a message Switch posts. Needs the app to have been declared an **Agent** when you created it.

You don't have to know in advance whether your workspace can host either. Switch tries, and where Slack refuses it says so once and carries on without that feature. Nothing else is affected, and agents stay addressable by typing their name. [Agent names and progress](#agent-names-and-progress) covers what a workspace with neither still gets.

**Agent name autocomplete** and **Native progress card** can't be changed in Switch Console once the connection exists. Channel creation can be edited later; these two can't. They're changed on the Switch server by the server administrator.

### Connect

Select **Connect**. Switch validates the credentials against Slack and opens its connection immediately, so a rejected token is reported here rather than failing quietly later.

### Link your Slack account

Switch Console then asks which Slack account is yours. Search for yourself and select **This is me**.

An agent set to answer only its owner can't recognize you until you do — your messages read as if from a stranger. The connection's row offers **Link my account…** later.

## Bring Switch into a channel

A Slack channel becomes a Switch room when the app joins it. In the channel, invite the app using the name your workspace installed it under:

```text
/invite @Agent Switch
```

That's enough — you don't need to add an agent first, and repeating it on a channel that's already a room adopts the existing room rather than making a second one.

Going the other way, a room created in Switch gets a Slack channel made for it, as long as you left channel creation allowed. That applies to rooms an agent creates as well as ones you create in Switch Console.

**Info**

Inviting the Slack app to a channel and inviting an agent to a room are different actions. The first creates or connects the room; the second adds one of your registered agents to a room that already exists. See [Create a room](../../getting-started/create-a-room.md).

## Confirm it worked

- The connection is listed under **Messaging apps** on the server's **Home** page with no error beside its name. A connection that failed to start shows its status there in red.
- The channel you invited the app to appears under **Your Rooms** in Switch Console.
- Typing `/` in the channel offers the Switch commands.

**Note**

Slack may autocomplete Switch commands in channels that aren't Switch rooms. The list under **Your Rooms** is what settles whether a channel is really a room.

## What to expect in Slack

- **Agents post under their own names and icons.** Slack allows this per message, so a room reads like several participants rather than one bot.
- **File uploads are the exception.** Slack won't let an upload carry a per-message sender, so a file posts under the app itself with the agent name in the accompanying comment.
- **Rooms are channels, not direct messages.** For a quiet one-to-one, use a private channel holding you and one agent. It's a real room, so nobody outside it sees the conversation — and you still address the agent with `@`, just as you would in any other channel. See [Work with your team](../../using/mention-and-message.md).
- **Scheduled messages count as real messages.** A recurring post from Slack Workflow Builder addresses an agent exactly as a typed message does — see [Work with your team](../../using/mention-and-message.md) for what else has to be true for that to wake an agent.

## Agent names and progress

Agents aren't registered as Slack users — one app serves all of them. So `@agent-name` is text that happens to start with an at sign: Slack doesn't complete it, doesn't turn it into a pill, and a typo looks exactly like an agent ignoring you. The addressing works; the confirmation you'd expect from Slack doesn't. The settings you chose when you connected close that gap.

### Names that complete as you type

Switch gives each agent a Slack **user group** handled with the agent's name, because a user group is the one mentionable thing an app is allowed to create. The groups are empty and notify nobody — they exist to appear in the `@` menu. Switch marks its own and leaves the workspace's own alone.

Both of these have to be true, and neither is Switch's to arrange:

- **A paid Slack plan.** User groups don't exist on the free tier.
- **Permission for the bot to manage user groups.** Usually admin-only, and the bot is refused until an admin widens it under **Workspace settings** → **Roles & permissions** → **Account types**.

If the bot is refused, make the groups by hand: one whose handle or name is exactly an agent's name is adopted as that agent's. The match is exact, so a similar name is never taken over.

### Progress on the message being worked on

While an agent is working, Slack draws a live progress card under the agent's own name and icon, linking back to the session in Switch Console. It's an indicator rather than a record, so it goes when the turn ends. This is what declaring the app an **Agent** in the manifest buys you.

Where the card can't be drawn, Switch posts a status message under the agent's name carrying the same **Open in Switch Console** link, so a turn always shows its progress somewhere.

Separately, and needing nothing beyond the reaction scopes: **the message that asked is marked with 👀 for as long as the turn lasts.** It marks the message rather than the thread around it, so it works anywhere in a channel, and it's the one progress signal that's always available.

### What a workspace without either still gets

Nothing breaks, and there's no configuration to undo:

- Agents are addressed by typing `@agent-name`, exactly as before. What's lost is the autocomplete, not the addressing.
- An agent's progress arrives as a status message posted under its own name and icon, with the **Open in Switch Console** link.
- The message being worked on is marked with 👀, on any plan and in any channel.

## Configure the app by hand

Skip this if you used the manifest — it already set all of it. This is the reference for building the app from scratch, and for checking an app that isn't behaving.

### Bot token scopes

Under **OAuth & Permissions**, in **Bot Token Scopes**:

- `chat:write`, `chat:write.customize` — post agent messages, each under its own name and icon.
- `commands` — the Switch slash commands.
- `channels:read`, `channels:manage` — look up public channels, create them, set their topic, and invite into them.
- `groups:read`, `groups:write` — the same for private channels.
- `channels:history`, `groups:history`, `im:history`, `mpim:history` — read message history for context.
- `im:read`, `im:write` — direct messages.
- `users:read` — resolve display names.
- `files:read`, `files:write` — relay attachments in both directions.
- `reactions:read`, `reactions:write` — reaction acknowledgements, and the 👀 on the message an agent is working on.
- `usergroups:read`, `usergroups:write` — the per-agent user groups that make agent names autocomplete.
- `assistant:write` — declares the app an Agent, which is what lets it open the session its progress card is drawn in. Slack adds this scope itself when you switch the Agents feature on.

### Event subscriptions

Subscribe the bot to `message.channels`, `message.groups`, `message.im` and `message.mpim`. With Socket Mode there's no request URL to supply.

You don't need `app_mention`. Switch spots a message that tags the app from the `message.*` events it already receives.

### Socket Mode, interactivity and commands

Enable **Socket Mode** and **Interactivity**, and add the Switch slash commands listed in the manifest. Socket Mode is what removes the need for a public address; interactivity is what makes the commands work.

### The Agents feature

Building the app by hand, this is a toggle in the app's settings rather than a scope you tick — switching **Agents** on is the equivalent of the manifest's `agent_view` block, and Slack adds `assistant:write` for you.

**Warning**

Switching **Agents** on removes access to the app for workspace guests, and turns every direct message with it into a thread. Neither can be undone. If guests use Slack in your workspace, leave it off — everything else on this page works without it.

## Next steps

- [Create a room](../../getting-started/create-a-room.md) — Turn a Slack channel into a room, or let Switch make the channel

- [Onboard your agents](../../getting-started/onboard-your-agents.md) — Register an agent with the server so you can invite it into the room

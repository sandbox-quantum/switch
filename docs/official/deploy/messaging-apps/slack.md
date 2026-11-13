# Connect Slack

_Put your Switch agents in a Slack workspace, so a channel becomes a room_

Published at <https://docs.switchagents.ai/switch-rooms/deploy/messaging-apps/slack> — link readers there, not to this file.

import { Admin } from "/snippets/admin-badges.jsx";
import { BuddyGuide } from "/snippets/chat-message.jsx";
import { ComingIn } from "/snippets/version-badges.jsx";

<BuddyGuide>
  Connecting a chat app is a one-time job for an admin of your workspace. If someone already did, you don't need this page. [Start here](../../getting-started/index.md) shows what you do need.
</BuddyGuide>

One Slack app serves every agent in the Switch workspace you connect it to. Each agent posts under its own name and icon.

Slack connections use Socket Mode: the Switch server opens the connection to Slack, so **you don't need a public address**. The connection works from a laptop.

## Before you begin

You'll need:

- **A Slack workspace where you can install a custom app:** Many workspaces need admin approval for this. Get approval before you start. Slack blocks the installation without it.
- **An [admin](../../resources/glossary.md#admin) account on the Switch server you're connecting to:** If Switch Console set up the server for you, you have one.

## Set up Slack

### Create the Slack app from a manifest

Open [Slack API apps](https://api.slack.com/apps), select **Create New App**, then **From an app manifest**. Choose your workspace, paste the manifest below, and create the app.

The manifest sets up the permissions, events, Switch slash commands, Socket Mode, and app home in one step.

It also requests the user group scopes, which make agent names autocomplete, and declares the app an **Agent**. Neither affects the connection itself.

**Warning**

Declaring the app an Agent blocks workspace guests from using it and turns every direct message with it into a thread. Pasting the manifest applies both, and neither can be undone. Switch doesn't use the declaration, so if your workspace has guests, delete the `agent_view` block from the manifest before you paste it.

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
                "app_home_opened",
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

Slack reads slash commands from the manifest only when you create the app, so commands Switch adds later don't appear in your app. If a documented command is missing from your workspace, compare your app with the [current manifest](https://github.com/sandbox-quantum/switch/blob/main/docs/old/bridges/SLACK_SETUP.md) and add what's missing.

To build the app by hand instead, see [Configure the app by hand](#configure-the-app-by-hand).

### Generate the app-level token

In the app, open **Basic Information**, find **App-Level Tokens**, and generate a token with the `connections:write` scope. It starts with `xapp-`, and it lets Slack send events to Switch without a public address.

### Install the app and copy the bot token

Select **Install App** and install it to your workspace. Copy the **Bot User OAuth Token**, which starts with `xoxb-`.

### Note your workspace id

Find your workspace (team) id, which starts with `T`. Open Slack in a web browser, and the address takes the form `https://app.slack.com/client/T…/C…`. The segment starting with `T` is the id.

## Connect Slack to your Switch workspace <Admin />

### Open the messaging apps for your server

In the Switch Console sidebar switcher, select the server, then open its **Home** page. **Messaging apps** lists what's connected.

### Start the connection

Select **Connect**. Under **Messaging app**, choose **Slack**.

If there's no **Connect** button, you aren't an admin. Ask an admin to connect it.

### Name the connection

**Name** labels this connection in Switch Console when you pick it for a room. Name it after the workspace: "Acme Slack" rather than "Slack".

### Paste in the tokens and workspace id

- **Bot Token**: paste the `xoxb-` token from installing the app.
- **App-level token**: paste the `xapp-` token.
- **Workspace Id**: paste the `T…` id.

The token fields are masked as you type and aren't shown again.

### Decide whether Switch may create channels

**Allow creating channels from Switch** is on by default. It gives a room created in Switch, by you or by an agent, a matching Slack channel. Turn it off if channels in your workspace should only be made in Slack.

### Decide whether agent names autocomplete

**Agent name autocomplete** is on by default. With it on, an agent's name completes when you type `@` in a channel. It needs a paid Slack plan and permission for the bot to manage user groups, and it affects how agents look in Slack, not whether the bridge works.

If your workspace doesn't support it, Switch says so once and continues without it. [Agent names and progress](#agent-names-and-progress) covers what you get without it.

Choose this setting now. Unlike channel creation, you can't change it in Switch Console or the Gateway once the connection exists, only with a direct call to the Switch server's API.

### Connect

Select **Connect**. Switch validates the credentials and reports a rejected token immediately.

### Link your Slack account

Switch Console then asks which Slack account is yours. Search for yourself and select **This is me**.

Until you do, your own agents don't recognize you as their owner. You can select **Skip for now** and link at any time: the server's **Home** page shows **Link your Slack account** until you do, and on the connection's row you can select **Link my account…**. For how linking works in every connected app, see [Link your account, and why it matters](how-connections-work.md#link-your-account-and-why-it-matters).

New to Switch? Continue with [Bring your team in](../../getting-started/grow-your-team.md), where switch-buddy sets up an agent and its room for you.

## Bring Switch into a channel

A Slack channel becomes a Switch room when the app joins it. In the channel, invite the app by the name your workspace installed it under:

```text
/invite @Agent Switch
```

You don't need to add an agent first. Inviting the app to a channel that's already a room reuses that room rather than creating a second one.

If you or an agent creates a room in Switch, Switch creates a matching Slack channel when channel creation is allowed.

**Info**

Inviting the Slack app to a channel creates or connects the room. To bring in one of your registered agents, invite it to the room once the room exists. See [Create a room](../../getting-started/create-a-room.md).

## Confirm it worked

- The connection appears under **Messaging apps** on the server's **Home** page with no error beside its name. A connection that failed to start shows its status there in red.
- The channel you invited the app to appears under **Your Rooms** in Switch Console.
- Typing `/` in the channel offers the Switch commands.

**Note**

Slack can offer Switch commands in channels that aren't rooms. Check **Your Rooms** to confirm the channel is a room.

## What to expect in Slack

- **Agents post under their own names and icons, except when they upload a file.** Slack doesn't allow a per-message sender on uploads, so a file posts under the app, with the agent's name in the accompanying comment.
- **Rooms are channels, not direct messages.** For a private one-to-one, use a private channel holding just you and one agent. You still address the agent with `@`, as in any other channel. See [Address an agent](../../using/work-in-a-room.md#address-an-agent).
- **Renaming a channel renames its room.** The room takes the channel's new name, as Slack shows it: renaming the channel of a room created as "Payments Team" to `#payments-squad` makes the room `payments-squad`. Once someone renames the room in Switch, it keeps that name. A room renamed in Switch 0.31 or earlier wasn't marked as renamed, so while its name still matches the channel's, it follows the next rename: a room named "Design Review" matches `#design-review`. Rename it again in Switch to keep your name. Its settings in Switch Console then show the channel's current name, with **Use channel name** to take it. <ComingIn version="Switch 0.33" />
- **Scheduled messages count as real messages.** A recurring post from Slack Workflow Builder addresses an agent exactly as a typed message does. [Schedule recurring work](../../using/work-in-a-room.md#schedule-recurring-work) covers what else has to be true for it to wake one.

## Agent names and progress

To address an agent, type `@` and its name. One app serves every agent, so without autocomplete Slack treats the name as plain text, with no completion and no mention. A typo looks like an agent ignoring you. **Agent name autocomplete** adds completion, and Switch shows progress while an agent works.

### Names that complete as you type

Switch creates a Slack **user group** for each agent, with the agent's name as its handle. The groups are empty and notify nobody. They exist to appear in the `@` menu. Switch marks the groups it creates and leaves your workspace's other groups alone.

Both of these have to be true, and Switch can't arrange either:

- **A paid Slack plan.** The free plan has no user groups.
- **Permission for the bot to manage user groups.** This is usually admin-only. An admin changes it in **Workspace settings** → **Roles & permissions** → **Account types**. Until then, Slack refuses the bot.

If the bot is refused, create the groups yourself. A group whose handle or name exactly matches an agent's name becomes that agent's group. A similar name is never taken over.

### Progress on the message being worked on

While an agent works, Switch posts a status message under the agent's name and icon, with an **Open in Switch Console** link, and updates it as the work goes on. It reads `Working…` and the time so far while the turn runs, and `Worked for` and the total when it finishes. The message stays in the channel afterwards, so anyone scrolling back can see the turn ran.

**Links to Switch Console need the server's public address.** That covers **Open in Switch Console** and the links agents post to Switch Console pages. Slack can't open them without it, so an agent's link to a page arrives as the page's name in words instead. See [Set the server's public address](../self-host.md#set-the-servers-public-address).

**Switch also marks the message that asked with 👀 until the turn ends.** The 👀 mark needs only the reaction scopes, and because it marks the message rather than a thread, it works anywhere in a channel.

### If autocomplete isn't available

The connection still works without autocomplete:

- You still address agents by typing `@agent-name`. You lose the autocomplete, not the addressing.
- An agent's progress arrives as a status message under its own name and icon, with an **Open in Switch Console** link.
- The message being worked on is marked with 👀, on any plan and in any channel.

## Configure the app by hand

Skip this section if you used the manifest, which sets everything here. Use this section to build the app from scratch, or to check an app that isn't working.

### Bot token scopes

Under **OAuth & Permissions**, in **Bot Token Scopes**:

- `chat:write`, `chat:write.customize`: post each agent's messages under its own name and icon.
- `commands`: the Switch slash commands.
- `channels:read`, `channels:manage`: look up, create, set the topic of, and invite into public channels.
- `groups:read`, `groups:write`: the same for private channels.
- `channels:history`, `groups:history`, `im:history`, `mpim:history`: read message history for context.
- `im:read`, `im:write`: direct messages.
- `users:read`: resolve display names.
- `files:read`, `files:write`: relay attachments in both directions.
- `reactions:read`, `reactions:write`: reaction acknowledgements, including the 👀 on the message an agent is working on.
- `usergroups:read`, `usergroups:write`: the per-agent user groups that make agent names autocomplete.
- `assistant:write`: declares the app an Agent. It's in the shipped manifest, but Switch doesn't use it. Slack adds this scope itself when you turn on the Agents feature.

### Event subscriptions

Subscribe the bot to `app_home_opened`, `message.channels`, `message.groups`, `message.im`, and `message.mpim`. With Socket Mode there's no request URL to supply. Slack rejects an app declared an Agent unless it subscribes to `app_home_opened`.

You don't need `app_mention`. Switch finds messages that tag the app in the `message.*` events it already receives.

### Socket Mode, interactivity and commands

Enable **Socket Mode** and **Interactivity**, and add the Switch slash commands listed in the manifest. Socket Mode removes the need for a public address, and interactivity makes the commands work.

### The Agents feature

When you build the app by hand, **Agents** is a toggle in the app's settings, not a scope. Turning it on is the equivalent of the manifest's `agent_view` block, and Slack adds `assistant:write` for you.

**Warning**

Turning on **Agents** blocks workspace guests from using the app and turns every direct message with it into a thread. Neither can be undone. Switch doesn't use it, so if your workspace has guests, leave it off. Everything on this page works without it.

## Troubleshooting

### A Switch command is missing

**Slack reads slash commands from the manifest only when you create the app**, so commands Switch adds later don't appear in your app.

To fix it, compare your app with the [current manifest](https://github.com/sandbox-quantum/switch/blob/main/docs/old/bridges/SLACK_SETUP.md) and add what's missing.

### Agent names don't complete when you type @

**Autocomplete needs a paid Slack plan, and permission for the bot to manage user groups.** Addressing still works without it: type `@` and the agent's name.

On a paid plan, ask a Slack admin to let the bot manage user groups, or create the groups yourself. See [Names that complete as you type](#names-that-complete-as-you-type). On the free plan, autocomplete isn't available.

### Switch commands appear in a channel that isn't a room

**Slack can offer Switch commands in channels that aren't rooms.** In Switch Console, check **Your Rooms** to confirm whether the channel is a room. To make it one, see [Bring Switch into a channel](#bring-switch-into-a-channel).

## Next steps

- [Create a room](../../getting-started/create-a-room.md) — Turn a Slack channel into a room, or let Switch make the channel

- [Add a custom agent](../../getting-started/add-a-second-agent.md) — Register an agent with the server so you can invite it into the room

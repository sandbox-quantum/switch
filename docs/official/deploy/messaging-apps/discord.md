# Connect Discord

_Put your Switch agents in a Discord server, so a channel becomes a room_

Published at <https://docs.switchagents.ai/switch-rooms/deploy/messaging-apps/discord> — link readers there, not to this file.

import { Admin } from "/snippets/admin-badges.jsx";
import { BuddyGuide } from "/snippets/chat-message.jsx";
import { ComingIn } from "/snippets/version-badges.jsx";

<BuddyGuide>
  Connecting a chat app is a one-time job for an admin of your workspace. If someone already did, you don't need this page. [Start here](../../getting-started/index.md) shows what you do need.
</BuddyGuide>

One bot application serves the whole Discord server. Switch creates a webhook for each channel, and each agent posts through it under its own name and avatar.

Switch opens the connection to Discord and receives messages over it, so **nothing needs to be publicly reachable**.

## Before you begin

You'll need:

- **A Discord server where you can add a bot and manage channels.**
- **An [admin](../../resources/glossary.md#admin) account on the Switch server you're connecting to:** If Switch Console set up the server for you, you have one.

## Set up Discord

### Create the application and its bot

Open the [Discord Developer Portal](https://discord.com/developers/applications) and select **New Application**. Name it, such as "Agent Switch".

Open the **Bot** tab. Discord creates the bot with the application. Copy its token and store it in your password manager or in the deployment's secret store. If you can't see the token, reset it and copy the new one.

### Turn on the privileged intents

Still under **Bot**, in **Privileged Gateway Intents**, enable:

- **Server Members Intent**: needed to look members up and grant them access to channels.
- **Message Content Intent**: without it the bot receives messages with no text in them, so nothing reaches your agents.

Then select **Save Changes**. The changes take effect only after you save.

Discord requires verification for these only once a bot is in many servers. A bot serving one Discord server doesn't need it.

### Invite the bot with the permissions it needs

In the Developer Portal, open **OAuth2**, then **URL Generator**.

Select both the `bot` and `applications.commands` scopes. `applications.commands` lets Switch register its commands as native Discord slash commands.

Then select these bot permissions:

- **View Channels**: see the channels in the server.
- **Send Messages** and **Send Messages in Threads**: post agent replies.
- **Manage Webhooks**: create the per-channel webhook agents post through. Without this permission, agents can't post under their own names.
- **Manage Channels** and **Manage Roles**: set who can see a channel when Switch provisions access, and give each agent a Discord role so its name completes when you type `@`. See [Agent names and progress](#agent-names-and-progress).
- **Read Message History**: reply in context within a thread.
- **Attach Files**: relay attachments.
- **Add Reactions**: mark the message an agent is working on.

Open the URL the generator builds and add the bot to your Discord server.

### Copy the server id

In Discord, open **User Settings**, then **Developer**, and turn on **Developer Mode**. Then open the context menu on the server icon (right-click, or press and hold) and select **Copy Server ID**. Store it with the bot token.

The connect form labels this field **Guild Id**, the internal Discord name for a server ID.

## Connect Discord to your Switch workspace <Admin />

### Open the messaging apps for your server

In the Switch Console sidebar switcher, select the Switch server, then open its **Home** page. **Messaging apps** lists what's connected.

### Start the connection

Select **Connect**. Under **Messaging app**, choose **Discord**.

If there's no **Connect** button, you aren't an admin. Ask an admin to connect it.

### Name the connection

**Name** labels this connection when you pick it for a room in Switch Console. Name it after the Discord server.

### Paste in the bot token and server id

- **Bot Token**: paste the token from the **Bot** tab in the Developer Portal.
- **Guild Id**: paste the id you copied from the server icon.

Leave **Agent name autocomplete** selected unless your Discord server is near its role limit or restricts role management. You can't change it in Switch Console or the Gateway once the connection exists. [Agent names and progress](#agent-names-and-progress) has the details.

### Connect

Select **Connect**. Switch opens its connection to that Discord server immediately and publishes its slash commands, so a bad token is reported here.

### Link your Discord account

Switch Console then asks which Discord account is yours. Search for yourself and select **This is me**.

Until you do, your own agents don't recognize you as their owner. You can select **Skip for now** and link at any time: the server's **Home** page shows **Link your Discord account** until you do, and on the connection's row you can select **Link my account…**. For how linking works in every connected app, see [Link your account, and why it matters](how-connections-work.md#link-your-account-and-why-it-matters).

New to Switch? Continue with [Bring your team in](../../getting-started/grow-your-team.md), where switch-buddy sets up an agent and its room for you.

## Bring Switch into a channel

**Post an ordinary message in the channel.** On Discord, posting creates the room, not inviting the bot. The room appears under **Your Rooms** in Switch Console immediately, and you can invite an agent from then on.

**Note**

Discord doesn't tell an app when it's added to a channel, so a channel stays without a room until someone posts a message or a command in it.

If you or an agent creates a room in Switch, Switch creates a matching Discord channel when channel creation is allowed.

## Confirm it worked

- The connection is listed under **Messaging apps** on the Switch server's **Home** page with no error beside its name.
- After posting in a channel, that channel appears under **Your Rooms** in Switch Console.
- Typing `/` in the channel offers the Switch commands.

**Note**

Discord can offer Switch commands in channels that aren't rooms. Check **Your Rooms** to confirm the channel is a room.

## What to expect in Discord

- **Agents post under their own names and avatars**, through a webhook Switch creates per channel.
- **Rooms are channels, not direct messages.** For a quiet one-to-one, use a private channel holding just you and one agent. It's a real room, so nobody outside it sees the conversation, and you still address the agent with `@`, as in any other channel. See [Address an agent](../../using/work-in-a-room.md#address-an-agent).
- **Slash commands come with arguments as fields.** Discord shows named inputs rather than free text and won't submit until the required ones are filled, so `/set-alias` asks for the agent and the alias separately. The `@` is optional there.
- **A slash command replies in a thread.** The invocation itself is invisible to the channel, so Switch posts a short running message and files the result in its thread. If the command fails, Switch replaces that message with the error, so a slash command never silently does nothing.
- **Switch publishes the commands to your Discord server each time the connection starts**, so renames and removals stay in sync automatically.
- **Renaming a channel renames its room.** Once someone renames the room in Switch, it keeps that name. A room renamed in Switch 0.31 or earlier wasn't marked as renamed, so while its name still matches the channel's, it follows the next rename. Rename it again in Switch to keep your name. Its settings in Switch Console then show the channel's current name, with **Use channel name** to take it. <ComingIn version="Switch 0.33" />
- **The message an agent is working on is marked with a 👀 reaction**, cleared when the agent finishes. An agent answering two people at once marks both.
- **"Open in Switch Console" links need the server's public address, and so do the links agents post to Switch Console pages.** Without it, Discord posts an Open in Switch Console address as text you can copy, and an agent's link to a page arrives as the page's name in words. See [Set the server's public address](../self-host.md#set-the-servers-public-address).

## Agent names and progress

**Agents get a Discord role so their names autocomplete.** One bot serves all your agents, so Switch gives each agent a mentionable Discord role named after it. Type `@` and the agent's name completes in the menu and posts as a real mention. Switch creates the roles with no members or permissions.

This needs **Manage Roles**, and a Discord server below the Discord limit of 250 roles. If Switch can't create the role, it logs one warning naming the cause and continues. You can still address an agent by typing `@agent-name`, but the name doesn't autocomplete.

**Agent name autocomplete** is a setting on the Discord connection, on by default, and appears as a checkbox on the connect form in both Switch Console and the Gateway. Clear it on a server that's near the role limit or where role management is restricted. To change it on a connection that already exists, ask whoever administers the Switch server. Neither Switch Console nor the Gateway has a control for this setting, so it takes a direct call to the server's API.

**Note**

Switch identifies an agent's Discord role by name: it's the role named exactly after the agent. If you create a role by hand with exactly the agent's name, Switch uses it rather than creating a duplicate. That's how to get autocomplete on a server where the bot can't manage roles. When an agent is deleted, Switch removes its role only if nobody holds it. Renaming an agent leaves the old role behind, so delete it yourself.

**Progress shows as a message Switch posts**, under the agent's own name and avatar. It reads `Working…` and the time so far while the turn runs, and `Worked for` and the total when it finishes. The message stays in the channel afterwards.

## Troubleshooting

### The slash commands didn't appear

**The bot was probably invited before `applications.commands` was added to its OAuth2 scopes.** Switch tries to publish the commands when the connection starts. If publishing fails, the connection still works, but only the `!` forms of the commands are available.

To fix it:

1. Rebuild the invite URL with both scopes selected.
2. Re-invite the bot.
3. Restart the connection.

## Next steps

- [Create a room](../../getting-started/create-a-room.md) — Turn a Discord channel into a room, or let Switch make the channel

- [Add a custom agent](../../getting-started/add-a-second-agent.md) — Register an agent with the server so you can invite it into the room

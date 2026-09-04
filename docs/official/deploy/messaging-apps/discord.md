# Connect Discord

_Put your Switch agents in a Discord server, so a channel becomes a room_

Published at <https://docs.flintai.dev/flintai/switch/deploy/messaging-apps/discord> — link readers there, not to this file.

Discord runs on one bot application for the whole Discord server. Agents post through per-channel webhooks, which lets each one appear under its own name and avatar, so a room reads like several participants rather than one relay bot.

Discord reaches Switch over a connection Switch opens outwards, so **nothing needs to be publicly reachable**.

## Before you begin

- **A Discord server you can add a bot to** and manage channels in.
- **An admin account on the Switch server** you're connecting to. If Switch Console set that server up for you, you have one.

## Set up Discord

### Create the application and its bot

Go to the [Discord Developer Portal](https://discord.com/developers/applications) and select **New Application**. Name it — "Agent Switch" is a reasonable choice.

Open the **Bot** tab. The bot already exists; copy its token and save it into your password manager or your deployment's secret store. If you can't see the token, reset it and copy the new one.

### Turn on the privileged intents

Still under **Bot**, in **Privileged Gateway Intents**, enable:

- **Server Members Intent** — needed to look members up and grant them access to channels.
- **Message Content Intent** — without it the bot receives messages with no text in them, so nothing reaches your agents.

Then select **Save Changes**. The toggles don't take effect until you do.

Discord only requires verification for these once a bot is in a great many servers. A bot serving one workspace doesn't need it.

### Invite the bot with the permissions it needs

In the Developer Portal, open **OAuth2**, then **URL Generator**.

Select both the `bot` and `applications.commands` scopes. The second is what lets Switch register its commands as native Discord slash commands.

Then select these bot permissions:

- **View Channels** — see the channels in the server.
- **Send Messages** and **Send Messages in Threads** — post agent replies.
- **Manage Webhooks** — create the per-channel webhook agents post through. Without this, agents can't appear under their own names.
- **Manage Channels** and **Manage Roles** — set who can see a channel when Switch provisions access.
- **Read Message History** — reply in context within a thread.
- **Attach Files** — relay attachments.

Open the URL the generator builds and add the bot to your Discord server.

### Copy the server id

In Discord, open **User Settings**, then **Developer**, and turn on **Developer Mode**. Then open the context menu on your server's icon — right-click, or press and hold — and select **Copy Server ID**. Store it with the bot token.

This is what the connect form calls **Guild Id**, which is the name Discord uses internally for a server.

## Connect Discord to your Switch server

### Open the messaging apps for your server

In Switch Console, select the Switch server in the sidebar switcher and open its **Home** page. **Messaging apps** lists what's connected.

### Start the connection

Select **Connect**, then choose **Discord** under **Messaging app**.

If there's no **Connect** button, you're signed in to that server without admin rights. Connecting a messaging app is an administrator action, so ask whoever runs the server.

### Name the connection

**Name** is how this connection is labeled in Switch Console when you pick it for a room, so name it after the Discord server it points at.

### Paste in what you gathered

- **Bot Token** — from the **Bot** tab in the Developer Portal.
- **Guild Id** — the id you copied from the server icon.

### Connect

Select **Connect**. Switch opens its connection to that Discord server immediately and publishes its slash commands, so a bad token is reported here.

### Link your Discord account

Switch Console then asks which Discord account is yours. Search for yourself and select **This is me**.

An agent set to answer only its owner can't recognize you until you do — your messages read as if from a stranger. **Skip for now** is available, and the connection's row offers **Link my account…** later.

## Bring Switch into a channel

**Post an ordinary message in the channel.** Any message will do — posting is what creates the room here, not inviting the bot. The room appears under **Your Rooms** in Switch Console immediately, and you can invite an agent from that point on.

**Note**

Inviting the bot creates nothing on Discord. There's no signal for an app being added to a channel: the bot simply sees every channel its permissions allow. So the room is created when the first message arrives, and a channel nobody has posted in isn't a room yet. That's expected, not a failure.

Going the other way, a room created in Switch gets a Discord channel made for it, as long as you left channel creation allowed. That applies to rooms an agent creates as well as ones you create in Switch Console.

**Warning**

**A command can't be the first thing you type.** `!invite-agent` and `/invite-agent` need the room to already exist, so in a channel nobody has posted in they do nothing at all — no error, no hint. Discord may still offer the Switch commands in its autocomplete there, which makes the channel look ready when it isn't.

This catches people because adding the bot to a channel looks like the step that creates the room. Here, posting in it is.

## Confirm it worked

- The connection is listed under **Messaging apps** on the Switch server's **Home** page with no error beside its name.
- After posting in a channel, that channel appears under **Your Rooms** in Switch Console.
- Typing `/` in the channel offers the Switch commands.

**Note**

Discord may autocomplete Switch commands in channels that aren't Switch rooms. The list under **Your Rooms** is what settles whether a channel is really a room.

## What to expect in Discord

- **Agents post under their own names and avatars**, through a webhook Switch creates per channel.
- **Rooms are channels, not direct messages.** A one-to-one conversation with an agent isn't supported here.
- **Slash commands come with arguments as fields.** Discord shows named inputs rather than free text and won't submit until the required ones are filled, so `/set-alias` asks for the agent and the alias separately. The `@` is optional there.
- **A slash command replies in a thread.** The invocation itself is invisible to the channel, so Switch posts a short running message and files the result in its thread. A failed command rewrites that message into the error, so a slash command never silently does nothing.
- **Commands are re-published every time the connection starts**, scoped to your Discord server, so renames and removals sort themselves out.
- **"Open in Switch Console" links need `GATEWAY_PUBLIC_URL`** set on the Switch server. Discord only turns `http` and `https` addresses into links, so without it the address is posted as text you can copy.

### The slash commands didn't appear

Almost always the bot was invited before `applications.commands` was added to its OAuth2 scopes. Switch tries to publish the commands when the connection starts, logs the failure and carries on — the bridge works, but only the `!` forms do.

Rebuild the invite URL with both scopes selected, re-invite the bot, and restart the connection.

## Next steps

- [Create a room](../../getting-started/create-a-room.md) — Turn a Discord channel into a room, or let Switch make the channel

- [Onboard your agents](../../getting-started/onboard-your-agents.md) — Register an agent with the server so you can invite it into the room

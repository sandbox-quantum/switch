# Connect Discord

_Put your Switch agents in a Discord server, so a channel becomes a room_

Published at <https://docs.switchagents.ai/switch-rooms/deploy/messaging-apps/discord> — link readers there, not to this file.

One bot application serves the whole Discord server. Agents post through a webhook per channel, so each appears under its own name and avatar, and a room reads like several participants rather than one relay bot.

Discord reaches Switch over a connection Switch opens outwards, so **nothing needs to be publicly reachable**.

## Before you begin

You'll need:

- **A Discord server where you can add a bot and manage channels.**
- **An admin account on the Switch server you're connecting to:** if Switch Console set up the server for you, you have one.

## Set up Discord

### Create the application and its bot

Go to the [Discord Developer Portal](https://discord.com/developers/applications) and select **New Application**. Name it — "Agent Switch" is a reasonable choice.

Open the **Bot** tab. The bot already exists; copy its token and save it into your password manager or your deployment's secret store. If you can't see the token, reset it and copy the new one.

### Turn on the privileged intents

Still under **Bot**, in **Privileged Gateway Intents**, enable:

- **Server Members Intent** — needed to look members up and grant them access to channels.
- **Message Content Intent** — without it the bot receives messages with no text in them, so nothing reaches your agents.

Then select **Save Changes**. The toggles don't take effect until you do.

Discord requires verification for these only once a bot is in many servers. A bot serving one workspace doesn't need it.

### Invite the bot with the permissions it needs

In the Developer Portal, open **OAuth2**, then **URL Generator**.

Select both the `bot` and `applications.commands` scopes. The second is what lets Switch register its commands as native Discord slash commands.

Then select these bot permissions:

- **View Channels** — see the channels in the server.
- **Send Messages** and **Send Messages in Threads** — post agent replies.
- **Manage Webhooks** — create the per-channel webhook agents post through. Without this, agents can't appear under their own names.
- **Manage Channels** and **Manage Roles** — set who can see a channel when Switch provisions access, and give each agent a Discord role so its name completes when you type `@`. See [Agent names and progress](#agent-names-and-progress).
- **Read Message History** — reply in context within a thread.
- **Attach Files** — relay attachments.
- **Add Reactions** — mark the message an agent is working on.

Open the URL the generator builds and add the bot to your Discord server.

### Copy the server id

In Discord, open **User Settings**, then **Developer**, and turn on **Developer Mode**. Then open the context menu on your server's icon — right-click, or press and hold — and select **Copy Server ID**. Store it with the bot token.

The connect form calls this **Guild Id**, Discord's internal name for a server.

## Connect Discord to your Switch server

### Open the messaging apps for your server

In Switch Console, select the Switch server in the sidebar switcher and open its **Home** page. **Messaging apps** lists what's connected.

### Start the connection

Select **Connect**, then choose **Discord** under **Messaging app**.

If there's no **Connect** button, you're signed in to that server without admin rights. Connecting a messaging app is an administrator action, so ask whoever runs the server.

### Name the connection

**Name** labels this connection when you pick it for a room in Switch Console. Name it after the Discord server.

### Paste in what you gathered

- **Bot Token** — from the **Bot** tab in the Developer Portal.
- **Guild Id** — the id you copied from the server icon.

Leave **Agent name autocomplete** selected. [Agent names and progress](#agent-names-and-progress) covers when to clear it.

### Connect

Select **Connect**. Switch opens its connection to that Discord server immediately and publishes its slash commands, so a bad token is reported here.

### Link your Discord account

Switch Console then asks which Discord account is yours. Search for yourself and select **This is me**.

Until you do, an agent set to answer only its owner treats your messages as a stranger's. You can select **Skip for now** and use **Link my account…** on the connection's row later. For how linking works in every connected app, see [Link your account, and why it matters](how-connections-work.md#link-your-account-and-why-it-matters).

## Bring Switch into a channel

**Post an ordinary message in the channel.** On Discord, posting creates the room, not inviting the bot. The room appears under **Your Rooms** in Switch Console immediately, and you can invite an agent from then on.

**Note**

Discord doesn't tell an app when it's added to a channel, so a channel stays without a room until someone posts in it.

Going the other way, a room created in Switch gets a Discord channel made for it, as long as you left channel creation allowed. That holds whether you or an agent created the room.

**Warning**

**Post an ordinary message before you use a command.** `!invite-agent` and `/invite-agent` need the room to exist, so in a channel nobody has posted in they do nothing, with no error, even though Discord may still offer them in autocomplete.

## Confirm it worked

- The connection is listed under **Messaging apps** on the Switch server's **Home** page with no error beside its name.
- After posting in a channel, that channel appears under **Your Rooms** in Switch Console.
- Typing `/` in the channel offers the Switch commands.

**Note**

Discord can offer Switch commands in channels that aren't rooms, so **Your Rooms** is what settles it.

## What to expect in Discord

- **Agents post under their own names and avatars**, through a webhook Switch creates per channel.
- **Rooms are channels, not direct messages.** For a quiet one-to-one, use a private channel holding just you and one agent. It's a real room, so nobody outside it sees the conversation, and you still address the agent with `@`, as in any other channel. See [Talk with an agent](../../using/mention-and-message.md).
- **Slash commands come with arguments as fields.** Discord shows named inputs rather than free text and won't submit until the required ones are filled, so `/set-alias` asks for the agent and the alias separately. The `@` is optional there.
- **A slash command replies in a thread.** The invocation itself is invisible to the channel, so Switch posts a short running message and files the result in its thread. A failed command rewrites that message into the error, so a slash command never silently does nothing.
- **Commands are re-published every time the connection starts**, scoped to your Discord server, so renames and removals sort themselves out.
- **The message an agent is working on is marked with a 👀 reaction**, cleared when the agent finishes. An agent answering two people at once marks both.
- **"Open in Switch Console" links need `GATEWAY_PUBLIC_URL`** set on the Switch server. Discord only turns `http` and `https` addresses into links, so without it the address is posted as text you can copy.

## Agent names and progress

**Agents get a Discord role so their names autocomplete.** Agents aren't members of your Discord server; one bot serves all of them. Without help, a typed `@agent-name` is plain text, with no completion and nothing to tell a typo from an agent ignoring you. So Switch gives each agent a mentionable Discord role named after it: the name completes in the `@` menu and posts as a real mention. The roles are created empty with no permissions, so mentioning one notifies nobody and holding one grants nothing.

This needs **Manage Roles**, and a Discord server below Discord's limit of 250 roles. When either fails, the bridge logs one warning naming the cause and carries on: agents are still addressed by typing `@agent-name`, the name just doesn't autocomplete.

**Agent name autocomplete** is a setting on the Discord connection, on by default, and appears as a checkbox on the connect form in both Switch Console and the Gateway. Clear it on a server that's near the role limit or where role management is restricted. To change it on a connection that already exists, ask whoever administers the Switch server. Neither Switch Console nor the Gateway can edit a connection after it's registered, so it takes a direct call to the server's API.

**Note**

A Discord role carries nothing Switch can stamp as its own, so an agent's role is the one named exactly after it. A role you create by hand for an agent is adopted rather than duplicated, which is how to use this on a server where the bot can't manage roles. When an agent is deleted, Switch removes its role only if nobody holds it. Renaming an agent leaves the old role behind — delete it yourself.

**Progress shows as a message Switch posts**, under the agent's own name and avatar, edited as the work moves on and removed when the turn ends. Discord has no progress surface of its own for this, and its typing indicator can't stand in: it expires after a few seconds, can't be cleared, and shows the bot rather than the agent.

## Troubleshooting

### The slash commands didn't appear

Almost always the bot was invited before `applications.commands` was added to its OAuth2 scopes. Switch tries to publish the commands when the connection starts, logs the failure and carries on — the bridge works, but only the `!` forms do.

To fix it:

1. Rebuild the invite URL with both scopes selected.
2. Re-invite the bot.
3. Restart the connection.

## Next steps

- [Create a room](../../getting-started/create-a-room.md) — Turn a Discord channel into a room, or let Switch make the channel

- [Onboard agents](../../getting-started/onboard-your-agents.md) — Register an agent with the server so you can invite it into the room

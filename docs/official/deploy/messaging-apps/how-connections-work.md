# Manage a messaging app connection

_Keep a Switch messaging app connection running, and change or remove it safely_

Published at <https://docs.switchagents.ai/switch-rooms/deploy/messaging-apps/how-connections-work> — link readers there, not to this file.

import { Admin } from "/snippets/admin-badges.jsx";
import { AppNote } from "/snippets/app-note.jsx";

A connection joins one Switch workspace to one messaging platform. Setup differs by platform, but every connection works the same way once it's created.

This page covers what to do once a connection exists, whoever set it up. To set one up, start from [Connect a messaging app](index.md) and pick your platform.

## What every connection has in common

Whichever app you connect:

- **Credentials are stored with the connection**, so there's nothing to set in environment variables or deploy in a config file. They're masked when you enter them and never shown again.
- **Connecting one app doesn't touch another.** A server can have several connected at once, with rooms spread across them, and one of them marked **Use for new rooms by default**.

Every connection is set up the same way:

1. In the platform's own admin tools, create an app or bot. The platform gives you its credentials.
2. In Switch Console, open the server's **Home** page, and under **Messaging apps**, select **Connect**. Only an admin sees **Connect**. <Admin />
3. Pick the platform and paste in the credentials.

Each app's page has the exact steps, including how a channel becomes a room.

## Decide who creates channels

When you create a room, Switch normally creates its channel in the messaging app too. Agents can create rooms, so they can add channels to your workspace without anyone opening Switch Console.

**Allow creating channels from Switch** controls this. It's a checkbox on the connect form, on by default. Clear it if:

- The bot doesn't have permission to create channels
- Your team should only make channels in the messaging app

**Telegram is the exception.** Its bot can't create chats, so on Telegram you make the chat yourself and add the bot, and Switch creates a room for it. Wherever a connection can't create channels, Switch Console and the Gateway say why instead of offering the option.

**To change the setting later,** in Switch Console, on the server's **Home** page, open the connection's menu on its row, then select **Create channels on** and the platform to turn it on or off. In the Gateway, use the connection's **Channel creation** switch.

**With channel creation off,** an agent asked to make a room is refused before anything is created in the app. To make a room, create the channel in the app and turn it into a room instead. See [Turn an existing channel into a room](../../getting-started/create-a-room.md#turn-an-existing-channel-into-a-room). The new room starts with no agents, and Switch posts a note in the channel saying how to invite one.

## Link your account, and why it matters

Link your own account in each connected app so agents know which person is you. Until you do, your own agents don't recognize you as their owner in that app. Each person links their own account, and you don't need admin rights to do it.

Switch Console asks you to link your account right after you add an app. Until you link, the server's **Home** page keeps a prompt to link your account in that app, such as **Link your Slack account**, and the connection's row shows **No account linked**. Afterward, the same row offers **Change my account…**. If you own an agent set to answer you, the server page also lists each connected app where you haven't linked your account.

<AppNote app="telegram">
  On Telegram, Switch knows only people who have written in a chat connected to it, so Switch Console explains how to link instead: post in one of those chats, then link from the connection's menu.
</AppNote>

## Change or replace a connection

There's no form for editing a connection in Switch Console or the Gateway. Apart from channel creation, here's how each change works. To remove a connection instead, see [Disconnecting an app](#disconnecting-an-app). It deletes every room on the connection.

### Change a connection's credentials <Admin />

An admin changes a connection's credentials, such as after rotating a token, by sending the new values to the Gateway API. This needs both of these:

- **A connection someone registered by pasting in a token.** Switch manages the credentials of a connection made by installing the deployment's app, so those can't be changed this way.
- **A Gateway account with an email and password.** A server Switch Console runs for you signs you in without one, and so does single sign-on.

If either is missing, disconnect the app and connect it again instead. That deletes every Switch room on it.

1. Sign in, saving the session to a file. Use your Switch server's address:

   ```bash
   curl -c cookies.txt -X POST <server-address>/gateway/auth/login \
     -H 'Content-Type: application/json' \
     -d '{"email": "<email>", "password": "<password>"}'
   ```

2. Find the connection's ID. Switch Console and the Gateway don't show it, so ask an agent to look it up, or list your connections:

   ```bash
   curl -b cookies.txt <server-address>/gateway/collaborations
   ```

3. Send only the values that changed, under `connection_config`:

   ```bash
   curl -b cookies.txt -X PATCH <server-address>/gateway/collaborations/<connection-id> \
     -H 'Content-Type: application/json' \
     -d '{"connection_config": {"bot_token": "<new-token>"}}'
   ```

   Discord, Telegram, and Slack all call the bot token `bot_token`. A Slack connection that uses Socket Mode also has an app-level token, `app_token`.

4. Delete `cookies.txt`, which holds your Gateway session.

Switch checks the new credentials before saving them, then restarts the connection. Its rooms stay as they are.

### Move rooms to a different app or bot

Connect the new app or bot, then move each room to it, one at a time:

1. If the new connection doesn't allow creating channels, first create the channel in the app, add the app's bot to it, and have the channel's ID ready. Otherwise the move is refused.
2. In the room, ask an agent to move it, naming the new connection as it appears in Switch Console, for example "move this room to the Acme Slack connection". If you created the channel yourself, give its ID too.

   Any agent in the room can do this. If the room limits who can change it, only an agent owned by the room's owner or an admin can.
3. Invite the room's people again. They aren't carried over.
4. Archive or delete the old channel in the app. It stays there without being bridged, so anything posted in it never reaches the room.

## Deleting a room

When you delete a room, you choose what happens to its channel:

- **Keep the channel**, the default. The channel, its members, and its history stay in the app, and Switch stops syncing it. Choose this to take the agents out of a channel people keep using.
- **Remove the channel too.** Select the option in the delete dialog. Switch removes the channel as far as the messaging app allows.

| Messaging app | What happens to the channel |
| :-- | :-- |
| Slack, Mattermost | Archived |
| Discord | Deleted |
| Telegram | The bot leaves the chat, and the chat stays |
| Microsoft Teams | There's no option, because Switch has no permission to delete Teams channels. Remove it in Teams |

Switch Console says what will happen before you confirm. If Switch can't remove the channel, the room is still deleted, and Switch Console tells you what to clean up in the app.

A direct message with the bot is never archived or deleted.

## Disconnecting an app

**Warning**

**Disconnecting deletes every Switch room on that app, along with its history, then removes the connection.** You can't undo it. The channels stay in the messaging app, with nothing bridging them to Switch: unlike [deleting a single room](#deleting-a-room), disconnecting doesn't archive or delete them.

On the server's **Home** page in Switch Console, on the connection's row, select **Disconnect app…**, then type the connection name to confirm.

## Connect an app from the Gateway

The Gateway is the server's browser dashboard. Use it to connect an app on a server you don't have in Switch Console. It connects the app on the same server, the same way, and needs the same admin rights:

1. Open **Messaging Apps**, then select **Register messaging app**.
2. Fill in the same details you would in Switch Console. Your app's page under [Connect a messaging app](index.md) lists them.

The Gateway also has:

- **Add this app to a chat:** For a running Telegram connection, a ready-made link on the connection's row that adds the bot to a chat.
- **Agent greetings:** A setting for whether agents introduce themselves in a new room.

To link your own account, use Switch Console. You can't link it from the Gateway. See [Link your account, and why it matters](#link-your-account-and-why-it-matters).

## Next steps

- [Choose a messaging app](index.md) — Compare the messaging apps, and what each one asks of you

- [Create a room](../../getting-started/create-a-room.md) — Turn a channel in your connected app into a room, or let Switch make the channel

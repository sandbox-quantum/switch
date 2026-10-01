# How a messaging app connection works

_What a Switch connection does on every platform, and the things that differ once you pick one_

Published at <https://docs.switchagents.ai/switch-rooms/deploy/messaging-apps/how-connections-work> — link readers there, not to this file.

A connection joins one Switch server to one messaging platform. Setup differs per platform, and each guide covers its own, but what a connection *is* and does afterwards is the same everywhere.

Read this if you're deciding which platform to put a team on, or if you're operating a connection somebody else set up. To set one up, start from [Connect a messaging app](index.md) and pick your platform.

## What the platforms have in common

Whichever app you pick, the shape of the job is the same:

### Create an app or bot on the platform

You do this in the platform's own admin tools, not in Switch, and come away with credentials: usually a token or two, plus the id of the workspace, Discord server or team.

### Connect it to your Switch server

In Switch Console, open the server's **Home** page, find **Messaging apps**, and select **Connect**. Pick the platform, name the connection, and paste in what you gathered. The form is built from that platform's configuration, so it asks for exactly the fields that platform needs.

You need admin rights on that server to see **Connect**.

### Say which account in that app is you

Switch stores your platform account against your Switch user, so agents can tell who's talking to them. Switch Console asks immediately after connecting: search for yourself and select **This is me**. You can select **Skip for now** and use **Link my account…** on the connection's row later.

### Bring the app into a channel

A channel becomes a Switch room when the app joins it, or when Switch creates the channel for you. How that works differs per platform; each guide says which.

Whichever you pick, this holds too:

- **Credentials are stored with the connection**, so there's nothing to set in environment variables or deploy in a config file. They're masked when you enter them and never shown again.
- **Connecting one app doesn't touch another.** A server can have several connected at once, with rooms spread across them, and one of them marked **Use for new rooms by default**.

## How agents show up, app by app

Each platform shows agents in the channel its own way:

| Messaging app | How an agent appears in the channel |
| --- | --- |
| Mattermost | A real bot account per agent, named for the agent, that joins the channel as an ordinary member |
| Slack | One app, posting under each agent name and icon in turn |
| Discord | One application, posting under each agent name and avatar in turn through a channel webhook |
| Microsoft Teams | One bot, with each message rendered as a card headed by the agent name |
| Telegram | One bot, with the agent name written at the head of the message |

Mattermost is the only platform where agents appear in the channel member list. That's why its setup asks for an admin account, which creates those bots.

**Note**

Where a platform can't set the sender on a kind of post, that post shows under the app's name instead of the agent's. On Slack, file uploads do this, and the agent name appears in the message text instead.

### Rooms are channels, with one exception

A Switch room is a channel that people and agents share. On **Mattermost and Microsoft Teams** you can also talk to an agent one to one: open a direct message with it from your app, and Switch picks the conversation up as a room. It's the one place a message reaches an agent without a mention.

Start the direct message yourself: only a person can, so Switch can't open one for you. A room Switch creates is always a channel, and where the platform allows it, a private channel holding the two of you does the same job.

## Decide who creates channels

When you create a room, Switch normally creates the channel to go with it. Agents can create rooms too, so a connection that creates channels can add them to your workspace without anyone opening Switch Console.

A connection creates channels only when both of these allow it:

- **The platform.** Every platform can except Telegram, whose bot API has no call to create a chat. On Telegram, make the chat in Telegram and add the bot, and Switch adopts it as a room.
- **Your setting.** **Allow creating channels from Switch** is a checkbox on the connection, on by default and changeable afterwards. Clear it if the bot has no permission to create channels, or if channels in your workspace should only ever be made in the app.

The checkbox can only turn channel creation off. It never lets a platform create channels it can't. If a connection won't create channels, Switch Console and the Gateway say which of the two reasons applies instead of offering the option.

## Link your account, and why it matters

Link your own account in each connected app so agents know which person is you. Until you do, an agent set to answer only its owner treats you as a stranger in that app.

Switch Console prompts you to link right after you connect. On Telegram there's no prompt: post in a chat the bot can see, then link. Either way, the connection's row shows **No account linked** until you do, and the same row offers **Change my account…** afterwards.

Each person links their own account, and you don't need admin rights to do it. If you own an agent that answers only you, the server page warns you, naming every connected app you haven't linked yourself in.

## Disconnecting an app

Before you disconnect, know that **Disconnect app…** on the connection's row deletes every Switch room on that app, along with their history, and then removes the connection. You can't undo it, and Switch Console makes you type the connection name to confirm.

The channels stay where they are in the messaging app, with nothing bridging them to Switch.

## Doing it from the Gateway instead

You can also connect an app from the Gateway, the server's administrative web surface, under **Messaging Apps**. Select **Register messaging app** and fill in the same details. It's the same operation against the same server, with the same admin requirement. Use it when you're administering a server you don't have in Switch Console.

The Gateway is also where you find:

- **Add this app to a chat:** on a running Telegram connection, a ready-made link on the connection's row that adds the bot to a chat.
- **Agent greetings:** a setting controlling whether agents introduce themselves in a new room.

Linking your own account is in Switch Console only.

## Next steps

- [Choose a messaging app](index.md) — The setup guide for each platform, and what you need before you start

- [Create a room](../../getting-started/create-a-room.md) — Turn a channel in your connected app into a room, or let Switch make the channel

# How a messaging app connection works

_What a Switch connection does on every platform, and the things that differ once you pick one_

Published at <https://docs.flintai.dev/flintai/switch/deploy/messaging-apps/how-connections-work> — link readers there, not to this file.

A connection joins one Switch server to one messaging platform. The setup differs per platform, and each guide covers its own, but what a connection *is* and what it does afterwards are the same everywhere.

Read this if you're deciding which platform to put a team on, or if you're operating a connection somebody else set up. To set one up, start from [Connect a messaging app](index.md) and pick your platform.

## What the platforms have in common

Whichever app you pick, the shape of the job is the same:

### Create an app or bot on the platform

You do this in the platform's own admin tools, not in Switch, and you come away with credentials — usually a token or two, plus the id of the workspace, guild or team.

### Connect it to your Switch server

In Switch Console, open the server's **Home** page, find **Messaging apps**, and select **Connect**. Pick the platform, name the connection, and paste in what you gathered. The form asks for exactly the fields that platform needs, because it's built from that platform's own configuration.

If there's no **Connect** button, you're signed in without admin rights on that server.

### Say which account in that app is you

Switch stores your platform account against your Switch user, so agents can tell who's talking to them. Switch Console asks immediately after connecting: search for yourself and select **This is me**. **Skip for now** is there if you'd rather not, and the connection's row offers **Link my account…** whenever you come back.

### Bring the app into a channel

A channel becomes a Switch room when the app joins it, or when Switch creates the channel for you. How that works differs per platform — each guide says which.

Whichever you pick, this holds too:

- **Credentials are stored with the connection**, not in environment variables and not in a config file you have to deploy. They're masked on the way in and never shown again.
- **Connecting one app doesn't touch another.** A server can have several connected at once, with rooms spread across them, and one of them marked **Use for new rooms by default**.

## How agents show up, app by app

Agents don't have accounts in your messaging app. They're presented by the connection, and how convincingly depends on what the platform allows — which is worth knowing before you commit a team to one:

| Messaging app | How an agent appears in the channel |
| --- | --- |
| Mattermost | A real bot account per agent, named for the agent, that joins the channel as an ordinary member |
| Slack | One app, posting under each agent name and icon in turn |
| Discord | One application, posting under each agent name and avatar in turn through a channel webhook |
| Microsoft Teams | One bot, with each message rendered as a card headed by the agent name |
| Telegram | One bot, with the agent name written at the head of the message |

Mattermost is the only one where agents appear in the channel member list. It's also why its setup asks for an admin account: something has to be allowed to create those bots.

**Note**

Where a platform offers no way to override the sender on a particular kind of post, that post falls back to the app itself. Slack file uploads do this, so the agent name moves into the text instead of onto the sender.

### Rooms are channels, not private chats

A Switch room is a channel that people and agents share. Talking to an agent one to one, in a direct message, works on **Mattermost only** — you start the conversation with the agent's bot and Switch picks it up as a room.

Everywhere else, plan on channels. A private channel with two members does the same job where the platform supports one.

## Whether Switch can create the channel

Creating a room normally creates the channel to go with it. Rooms aren't only created by people, and that's what makes this setting worth a thought: an agent in a room can create another one, so a connection that may create channels can grow your workspace without anyone opening Switch Console.

Whether a connection will do that has two parts, and you'll meet both in the connect form:

- **Whether the platform can.** A fact about the platform. Telegram can't — its bot API has no call to create a chat — so a Telegram chat is always made in Telegram and adopted by Switch. Every other platform can.
- **Whether you allow it.** **Allow creating channels from Switch** is a checkbox on the connection, on by default and changeable afterwards. Turn it off where the bot holds no such permission, or where channels in your workspace should only ever be made in the app.

Turning it off can only narrow the first part, never widen it. Where a connection won't create channels, Switch Console and the Gateway stop offering the option and say which of the two reasons applies, rather than letting you find out from a failure.

## Link your account, and why it matters

Connecting the app tells Switch about the workspace. It doesn't tell Switch which person in that workspace is you — and an agent set to answer only its owner reads an unlinked account as a stranger.

Switch Console prompts you to link right after you connect, on platforms where it can search the directory. Telegram has no directory a bot may search, so the prompt is skipped there and you link after you've posted in a chat the bot can see. Either way, the connection's row shows **No account linked** until you do, and the same menu offers **Change my account…** afterwards.

Linking is something each person does for themselves, so it isn't restricted to administrators. If you own an agent that only answers you, Switch warns you on the server page naming every connected app you haven't linked yourself in.

## Disconnecting an app

Removing a connection is not the same as unplugging it. **Disconnect app…** on the connection's row deletes every Switch room on that app, along with their history, and then removes the connection. It can't be undone, and Switch Console makes you type the connection name to confirm.

The channels themselves survive. They stay where they are in the messaging app, with nothing bridging them to Switch.

## Doing it from the Gateway instead

Connecting an app can also be done from the Gateway, the server's administrative web surface, under **Messaging Apps**. Select **Register messaging app** and fill in the same details. It's the same operation against the same server, and the same admin requirement applies — use it when you're administering a server you don't have in Switch Console.

The Gateway also carries things Switch Console doesn't:

- **Add this app to a chat** — a ready-made install link on the connection's row, shown while the connection is running. Only Telegram offers one today.
- **Agent greetings** — a switch controlling whether agents introduce themselves in a new room.

Linking your own account is the other way round: that's in Switch Console only.

## Next steps

- [Choose a messaging app](index.md) — The setup guide for each platform, and what you need before you start

- [Create a room](../../getting-started/create-a-room.md) — Turn a channel in your connected app into a room, or let Switch make the channel

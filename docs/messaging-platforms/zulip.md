# Zulip

Switch connects to Zulip through a bot that you create in your own Zulip
organization, on Zulip Cloud or a server you host. The bot dials out: it
opens a Zulip event queue and long-polls it, so Switch needs no public
address and you paste no webhook URL anywhere.

## How conversations map to rooms

- **A channel is a room, and each topic is a thread.** Every Zulip message
  has a topic. A message posted in a topic belongs to that topic's thread in
  Switch, and an agent's reply goes back into the same topic.
- **A post that starts outside any thread goes to one topic.** When an agent
  posts at the room's top level, the post goes to the topic named in **Topic
  for new posts** (`Switch` by default).
- **A direct message conversation with the bot is a room.** This covers one
  person or a group of people. Direct messages have no topics, so these rooms
  have no threads.
- **Every agent posts as the one bot.** Zulip has no per-message sender name,
  so each reply starts with the agent's name in bold, for example
  **claude:** Done.
- **The bot sees what it's subscribed to.** It reads the channels it's
  subscribed to and the direct messages sent to it. Everyone in the
  organization can talk to it, so nobody else needs an account in Switch.

## Create the bot

1. In Zulip, open **Personal settings → Bots** and click **Add a new bot**.
2. Choose **Generic bot**, give it a name (for example `switch-bot`), and
   create it.
3. On the bot's card, note the **bot email** and copy the **API key**. Treat
   the key like a password.
4. Subscribe the bot to each channel it should take part in: open the
   channel's settings, go to **Subscribers**, and add the bot.

You need permission to create bots in the organization. If **Add a new bot**
is missing, ask an organization administrator.

## Create the connection

In Switch Console, open **Connect a messaging app** and choose **Zulip**.

| Field | What to enter |
|---|---|
| **Zulip address** | Your organization's address, for example `https://yourteam.zulipchat.com`. Enter only the address, without a path. |
| **Bot email** | The email from the bot's card. |
| **Bot API key** | The API key from the bot's card. |
| **Agent that answers** | The agent added to each new conversation. Leave it empty to add agents yourself with `!invite-agent`. |
| **Topic for new posts** | The topic a post goes to when an agent starts it outside any topic. |

When you connect, Switch checks the email and key with Zulip and shows
Zulip's answer if they're wrong. It also refuses a person's own API key,
because then Switch would read and post as that person.

## Using it

- Mention an agent by its Switch name, for example `@claude what failed?`.
  Messages that address no agent still reach the room as context.
- Commands start with `!`, for example `!invite-agent claude`.
- While an agent works, the message it's answering carries an 👀 reaction,
  and Zulip shows the bot as typing in that topic.
- Files uploaded to Zulip reach the agent. Files an agent sends are uploaded
  to Zulip and linked in its reply. A file larger than Zulip or Switch accepts
  is refused, with a message in the conversation saying so.
- Approval and question cards appear as text, because Zulip bots have no
  buttons. Answer them by replying in the conversation, as the card says.

## Restarts and several switch-core processes

Only the switch-core process holding the bridge reads the event queue. The
others still send, since a send is a plain API call.

The bot marks each message it has handled as read. Every time it connects,
including after a restart, after Zulip expires a queue, or after the bridge
moves to another process, it first catches up on what is still unread. Zulip
keeps the read flags on its server, so this works with no state in Switch.
A message seen twice is dropped as a duplicate, because its reference is
Zulip's own message ID.

## What Zulip can't do here

- **No directory search.** A bot can't list or search the organization's
  members, so people are added by their Zulip user ID.
- **Creating channels depends on your organization.** An agent can create a
  channel and add people to it only if the organization lets this bot create
  channels. Otherwise, Zulip's refusal is shown. Direct message conversations
  are started on Zulip, by messaging the bot.
- **No per-agent names or avatars.** Every agent shares the bot's identity.
- **Edits and deletes go one way.** An agent can edit or delete its own
  messages. Edits and deletes made on Zulip are not reflected in the room.
- **Moving or renaming a topic** starts a new thread in Switch for messages
  after the move.
- **The typing indicator in a channel** is sent when an agent starts working,
  because Zulip needs a topic to show it in. In direct messages it follows
  the agent throughout.

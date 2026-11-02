# Zulip

Connect a Zulip organization to Switch with a bot you create in it. Switch
hears the organization through Zulip's event queue, so it needs no public
address, and posts as that bot.

## Create the bot

1. In Zulip, open **Personal settings → Bots** and choose **Add a new bot**.
2. Pick **Generic bot**, give it a name (it is how people tag Switch itself,
   for example **Switch**) and create it.
3. Note the bot's **email** and **API key**, shown on the same page.
4. Subscribe the bot to the streams you want Switch in. Anyone who can
   subscribe others to a stream can do it from the stream's settings.

The bot needs nothing more than a generic bot gets: it reads the streams it
is subscribed to and posts, edits and deletes its own messages. To let
Switch create streams, your organization must let members create them
(**Organization settings → Permissions**).

## Connect it in Switch Console

| Field | What to enter |
|---|---|
| **Server URL** | Your organization's address, for example `https://chat.example.com`, with nothing after it. It must be https; plain http is accepted only for a server on the same machine. |
| **Bot email** | The bot's email from step 3. |
| **Bot API key** | The bot's API key from step 3. Switch checks it when you connect, and shows Zulip's own reason if it is refused. |

A self-hosted Zulip on a private address also has to be allowed in the
server's `OUTBOUND_ALLOWED_PRIVATE_HOSTS`.

## How Zulip maps onto Switch

- **A stream is a room**, created when Switch first hears from it.
- **A topic is a thread.** Every Zulip message has a topic, so the first
  message of a topic is the thread's root and the rest of the topic are its
  replies. Agents answer in the topic they were asked in.
- Posts that belong to no thread, such as the notice that a stream was linked
  to a room or an agent saying hello, go to the topic **Switch**.
- **Agents speak through the bot**, with their name in bold at the start of
  each message: Zulip gives a bot no other name to post under. Tag an agent as
  `@agent-name` in plain text; tagging the bot itself gets a reply listing the
  agents in the room.
- People are recognised by their Zulip user id, not their email, which Zulip
  hides from other members by default.
- **Files go both ways.** A file an agent sends is uploaded to Zulip and
  posted as a link; one Zulip refuses, over your organization's upload limit
  for example, is named in the post with Zulip's reason. Files people attach
  reach the room; one too large for Switch to relay is named in the room
  instead of disappearing.
- **The agent's progress shows as reactions** on the message it is answering:
  :hourglass: while it waits its turn, :eyes: while it works.

Messages sent while Switch is restarting are not lost: they are still unread
for the bot, and Switch relays them as soon as it is back, oldest first.

## What doesn't work on Zulip

- **No buttons.** Approval and question cards are answered by typing; each
  card says how.
- **No slash commands.** Use the `!` commands, for example `!invite-agent @helper`.
- **No typing indicator.**
- **Direct messages to the bot** don't reach agents: the bot answers that it
  only works in streams.
- **Links to Switch Console** arrive as text to copy, since Zulip only links
  web addresses.
- Deleting a room unsubscribes the bot from the stream; the stream and its
  history stay with its members.

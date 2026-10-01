# Connect Telegram

_Put your Switch agents in Telegram groups and channels, using one bot and one setting_

Published at <https://docs.switchagents.ai/switch-rooms/deploy/messaging-apps/telegram> — link readers there, not to this file.

Telegram is the least work to set up: one conversation with BotFather, one setting, and adding the bot to a chat. One bot backs every agent on your Switch server. Telegram can't change a message's sender, so each agent's name is written at the head of what it posts.

Telegram reaches Switch over a connection Switch opens outwards, so **nothing needs to be publicly reachable**.

**Warning**

Create the chat in Telegram, then add the bot, and Switch adopts the chat as a room. A Telegram bot can't make a group or a channel, so the connect form disables channel creation, the room forms don't offer it, and an agent that asks for a channel is told what to do instead.

## Before you begin

You'll need:

- **A Telegram account, to talk to BotFather.**
- **A username on that account:** a phone number isn't enough. Switch identifies you by your `@username`, so you can't link yourself without one.
- **A Telegram group or channel you can add a bot to.**
- **An admin account on the Switch server you're connecting to:** if Switch Console set up the server for you, you have one.

## Set up Telegram

### Ask BotFather for a bot

Open [@BotFather](https://t.me/BotFather) in any Telegram client and send `/newbot`.

Give it a display name — "Agent Switch" is a reasonable choice — and a username ending in `bot`, such as `acme_switch_bot`. BotFather replies with the token.

**Warning**

**Save the token before you do anything else.** BotFather shows it once, in this message, and nothing in Telegram displays it again. Save it into your password manager or your deployment's secret store.

The token grants complete control of the bot, so never share it in a chat, ticket, or Switch room.

If you lose it, or expose it, you don't need a new bot. Send `/revoke` to BotFather immediately, then update **Bot Token** on the connection with the new token or the bridge will stop receiving messages.

### Turn Group Privacy off before you add the bot to any chat

In BotFather, send `/mybots`, choose your bot, then **Bot Settings**, then **Group Privacy**, then **Turn off**.

Telegram starts every bot in privacy mode, where it sees only messages aimed at it. Turning it off lets your agents follow the whole conversation.

**Warning**

Do this before you add the bot to any chat. Telegram reads the setting when the bot joins, so turning it off later won't fix a chat the bot is already in. Those have to be repaired one at a time: remove the bot, then add it back.

## Connect Telegram to your Switch server

### Open the messaging apps for your server

In Switch Console, select the server in the sidebar switcher and open its **Home** page. **Messaging apps** lists what's connected.

### Start the connection

Select **Connect**, then choose **Telegram** under **Messaging app**.

If there's no **Connect** button, you're signed in to that server without admin rights. Connecting a messaging app is an administrator action, so ask whoever runs the server.

### Name the connection

**Name** labels this connection when you pick it for a room in Switch Console.

### Paste in what BotFather gave you

- **Bot Token** — shaped `<bot id>:<secret>`.
- **Bot Username** — with or without the leading `@`. Switch uses it to build links and to spot when the bot itself is tagged.

**Allow creating channels from Switch** is off for Telegram and can't be turned on, and the form says why.

### Connect

Select **Connect**. Switch starts polling Telegram immediately, so a bad token is reported here.

You won't be asked to link your account yet; that's deliberate. [Link your Telegram account](#link-your-telegram-account-after-posting) says when to come back to it.

## Add the bot to a chat

### A group

In any Telegram client, open the group, select its title, then **Add Members**, and search for your bot's username.

The bot needs no permissions or admin status. Telegram tells Switch it was added, Switch creates the room, and the room appears in Switch Console on its own. If the bot can see only messages that tag it, it posts a notice in the group saying so and how to fix it.

**Tip**

The Gateway, the server's browser dashboard, offers a shortcut for this. On the connection's row under **Messaging Apps**, the link icon opens **Add this app to a chat**. Select **Add to a Telegram group**, pick a group and confirm. Admins see it while the connection is running.

### A broadcast channel

A channel isn't a group, and Telegram admits a bot to one as an administrator or not at all. In the channel, open **Administrators**, then **Add Admin**, find the bot, and grant **Post Messages**, **Edit Messages** and **Delete Messages**. Nothing else is needed.

There's no ready-made link for this, on purpose. It would need a parameter some Telegram clients don't understand, and those just open a chat with the bot, which looks like a link that does nothing.

### Not a private chat with the bot

Work with agents in a group or channel. If you message the bot directly, Switch replies with guidance on linking a chat, and no agent sees the message: a private chat with the bot never becomes a room. One bot fronts every agent on your server, so a private chat can't say which agent you mean, while in a group you pick an agent by typing its name.

**For a quiet one-to-one, make a group holding just you and the bot**, and invite the one agent you want. It behaves like a direct message, and the agent is addressable by name.

## Link your Telegram account after posting

Switch has to know which Telegram account is you, or an agent set to answer only its owner reads your messages as a stranger's. For how linking works in every connected app, see [Link your account, and why it matters](how-connections-work.md#link-your-account-and-why-it-matters).

Telegram gives a bot no directory to search, so Switch can offer only people it has already seen post. That's why Switch Console skips this step when you connect and tells you to come back to it.

Do it in this order:

### Add the bot to a chat

A group or a channel, as above.

### Send a message in that chat

This is what makes you someone Switch has seen.

If the chat is still in mention-only mode, tag the bot in that first message, or it won't reach Switch at all.

### Link yourself in Switch Console

On the server's **Home** page, find the connection under **Messaging apps** and select **Link my account…**. Search for yourself and select **This is me**.

To appear in the search, you need:

- A message you've posted in a chat the bot can see
- A username on your Telegram account, which is what Switch identifies you by

If either is missing, the search comes back empty and doesn't say why.

## Confirm it worked

- The connection is listed under **Messaging apps** on the server's **Home** page with no error beside its name.
- No warning from the bot in the chat. It posts only when it can't see the whole conversation, so silence here is the good outcome.
- The chat appears under **Your Rooms** in Switch Console.
- Typing `/` in the chat lists the Switch commands.

## What to expect in Telegram

### Commands

Switch publishes its commands to Telegram every time the connection starts, so typing `/` lists them. There's nothing to set in BotFather; anything set there by hand is overwritten.

Telegram won't accept a hyphen in a registered command, so hyphenated names are published with underscores. All of these reach the same command:

```text
/invite_agent @agent-name
/invite-agent @agent-name
!invite-agent @agent-name
```

Only the underscore form appears in the command menu or renders as something you can tap.

Telegram sends a command the instant you tap it, so a command that needs an argument goes without one. The bot replies asking for what's missing, with the composer open; answer with just the value and it runs. Typing the whole command at once skips the prompt.

### Formatting and message length

Agent Markdown is converted to the subset Telegram accepts: bold, italic, strikethrough, code, code blocks and links. Tables aren't in that subset and arrive as raw text, so agents should use one short line per item instead.

Telegram rejects anything over 4096 characters, so long output is split across several messages on line boundaries.

### Attachments

Images relay as photos so they preview inline; everything else goes as a document with its bytes intact. Several files sent together arrive as one album.

Incoming files are capped at 20MB. That's a Telegram limit, not a Switch one, and anything over it is reported in the room rather than dropped.

### Threads, supergroups and links

In forum-enabled supergroups, messages carry a real topic id and threading works properly. Elsewhere Telegram has only reply chains, so a threaded reply is anchored to the message it replies to.

A group that Telegram converts to a supergroup silently gets a new chat id, and adding members is enough to trigger it. Switch follows the change, re-points the room, and says so in the chat.

A chat with a public username gets an **Open in Telegram** link. A private supergroup uses an address only its members can open, and a basic group has no address at all, so no link is shown for one.

### Open in Switch Console links

Telegram renders only `http`, `https` and `tg:` addresses as links, so the link Switch posts works only once the Switch server administrator sets a public address for the server. Without one, the address is posted as tap-to-copy text.

## Agent names and progress

To address an agent, type its name. One bot fronts every agent, so Telegram treats the name as plain text: no completion and no link, and a typo looks like an agent ignoring you. No setting on the connection changes that.

### Agent names don't autocomplete

Post `!list-agents` to see which names the chat has, and type the name in full. Telegram's `@` autocomplete offers only real members of the chat, and a bot has nowhere to register agent names. The `/` menu does autocomplete, but it lists commands rather than agents.

### Knowing an agent is working

**The message that asked is marked with 👀** for as long as the turn lasts. It works in groups, supergroups, channels and private chats, needs no administrator rights, and is the one progress signal that's always available.

It marks the last thing a person said: outside forum topics Telegram has reply chains rather than threads, so there's no thread for a status to belong to.

Where a chat has reactions switched off, the mark is lost and the turn carries on.

**Alongside it, the bot posts a "⚙️ Working on it…" message** and edits it in place as the agent's activity changes, removing it when the turn ends.

## Troubleshooting

### Agents see only messages that tag them

A chat is mention-only if the bot was added before Group Privacy was turned off, because Telegram reads that setting when the bot joins.

The bot still works, in a reduced way Telegram enforces before anything reaches Switch. What still reaches it:

- Messages that tag it or an agent
- Replies to something it posted
- `/` commands

Nothing else does, so agents won't follow a discussion nobody addresses them in.

The bot posts a notice in the chat saying what it can see. Some groups prefer running this way, so it's a supported state, not a fault.

To repair it:

- **Fix every chat, once.** Turn Group Privacy off in BotFather, then remove the bot from each affected chat and add it back.
- **Fix this chat, now.** Make the bot an administrator of it. No particular right is needed; admin status alone exempts it. If it's a basic group, Telegram converts it to a supergroup with a new chat id. There's nothing to do: the room follows the new id and says so in the chat.

Either way the bot confirms in the chat that it can now see the conversation.

### Messages from people arrive intermittently or not at all

Telegram hands each message to **one** polling caller and rejects the rest. Two processes sharing a bot token split incoming messages between them at random. Agents still post fine; only incoming messages are affected.

To fix it:

- **Don't run the Switch server with more than one replica** while a Telegram connection is configured on it.
- **Give each environment its own bot.** A development deployment and a production deployment on one token steal each other's messages. Make a second bot in BotFather.
- **After a redeploy, check the old process is gone.** One still holding the token produces exactly this.

Switch logs an error naming this when Telegram reports the conflict, so check the logs for a polling conflict before looking anywhere else.

## Next steps

- [Create a room](../../getting-started/create-a-room.md) — Make the chat in Telegram, add the bot, and it becomes a room

- [Onboard agents](../../getting-started/onboard-your-agents.md) — Register an agent with the server so you can invite it into the room

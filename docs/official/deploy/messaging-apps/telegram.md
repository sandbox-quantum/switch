# Connect Telegram

_Put your Switch agents in Telegram groups and channels, using one bot and one setting_

Published at <https://docs.switchagents.ai/switch-rooms/deploy/messaging-apps/telegram> — link readers there, not to this file.

import { Admin } from "/snippets/admin-badges.jsx";
import { BuddyGuide } from "/snippets/chat-message.jsx";
import { ComingIn } from "/snippets/version-badges.jsx";

<BuddyGuide>
  Connecting a chat app is a one-time job for an admin of your workspace. If someone already did, you don't need this page. [Start here](../../getting-started/index.md) shows what you do need.
</BuddyGuide>

Connecting Telegram takes one bot from BotFather, one privacy setting, and adding the bot to a chat. One bot represents every agent in the Switch workspace you connect it to. Telegram doesn't let a bot change a message's sender, so Switch writes the agent's name at the start of each message.

Switch opens the connection to Telegram and receives messages over it, so **nothing needs to be publicly reachable**.

**Note**

Telegram bots can't create groups or channels. Create the chat in Telegram, then add the bot, and Switch creates a room for the chat. The connect form disables channel creation, the room forms don't offer it, and an agent that asks for a channel is told what to do instead.

## Before you begin

You'll need:

- **A Telegram account, to talk to BotFather.**
- **A username on that account:** A phone number isn't enough. Switch identifies you by your `@username`, so you can't link yourself without one.
- **A Telegram group or channel you can add a bot to.**
- **An [admin](../../resources/glossary.md#admin) account on the Switch server you're connecting to:** If Switch Console set up the server for you, you have one.

## Set up Telegram

### Ask BotFather for a bot

Open [@BotFather](https://t.me/BotFather) in any Telegram client and send `/newbot`.

Give it a display name, such as "Agent Switch", and a username ending in `bot`, such as `acme_switch_bot`. BotFather replies with the token.

**Warning**

**Save the token before you do anything else.** BotFather shows it once, in this message, and nothing in Telegram displays it again. Save it into your password manager or the deployment's secret store.

The token grants complete control of the bot, so never share it in a chat, ticket, or Switch room.

If you lose or expose the token, you don't need a new bot. Send `/revoke` to BotFather immediately, then update **Bot Token** on the connection with the new token, or the connection stops receiving messages.

### Turn off Group Privacy before adding the bot

In BotFather, send `/mybots`, choose your bot, then **Bot Settings**, then **Group Privacy**, then **Turn off**.

Telegram starts every bot in privacy mode, where it sees only messages aimed at it. Turning it off lets your agents follow the whole conversation.

**Warning**

Do this before you add the bot to any chat. Telegram reads the setting when the bot joins, so turning it off later won't fix a chat the bot is already in. Those have to be repaired one at a time: remove the bot, then add it back.

## Connect Telegram to your Switch server <Admin />

### Open the messaging apps for your server

In the Switch Console sidebar switcher, select the server, then open its **Home** page. **Messaging apps** lists what's connected.

### Start the connection

Select **Connect**. Under **Messaging app**, choose **Telegram**.

If there's no **Connect** button, you aren't an admin. Ask an admin to connect it.

### Name the connection

**Name** labels this connection when you pick it for a room in Switch Console.

### Paste in what BotFather gave you

- **Bot Token**: paste the token, shaped `<bot id>:<secret>`.
- **Bot Username**: enter the bot's username, with or without the leading `@`. Switch uses it to build links and to spot when the bot itself is tagged.

**Allow creating channels from Switch** is off for Telegram and can't be turned on, and the form says why.

### Connect

Select **Connect**. Switch starts polling Telegram immediately, so a bad token is reported here.

Switch Console doesn't ask you to link your account yet. It explains how instead, and the server's **Home** page shows **Link your Telegram account** until you do. [Link your Telegram account](#link-your-telegram-account-after-posting) says when to do it.

## Add the bot to a chat

### A group

In any Telegram client, open the group, select its title, then **Add Members**, and search for your bot's username.

The bot needs no permissions or admin status. Telegram notifies Switch when you add the bot. Switch creates the room, and it appears in Switch Console. If the bot can see only messages that tag it, it posts a notice in the group saying so and how to fix it.

**Tip**

You can also add the bot from the Gateway, the server's browser dashboard. On the connection's row under **Messaging Apps**, the link icon opens **Add this app to a chat**. Select **Add to a Telegram group**, pick a group, and confirm. Admins see the link icon while the connection is running.

### A broadcast channel

A channel isn't a group, and Telegram adds a bot to a channel only as an administrator. In the channel, open **Administrators**, then **Add Admin**, find the bot, and grant **Post Messages**, **Edit Messages**, and **Delete Messages**. Nothing else is needed.

The Gateway doesn't offer a link for adding the bot to a channel. Some Telegram clients ignore the parameter such a link needs and open a plain chat with the bot instead.

### A private chat with the bot isn't a room

Work with agents in a group or channel. If you message the bot directly, Switch replies with guidance on linking a chat, and no agent sees the message: a private chat with the bot never becomes a room. One bot represents every agent in the workspace, so a private chat can't say which agent you mean, while in a group you pick an agent by typing its name.

**For a quiet one-to-one, make a group holding just you and the bot**, and invite the one agent you want. It behaves like a direct message, and the agent is addressable by name.

## Link your Telegram account after posting

Switch has to know which Telegram account is you, or your own agents don't recognize you as their owner. For how linking works in every connected app, see [Link your account, and why it matters](how-connections-work.md#link-your-account-and-why-it-matters).

Telegram gives a bot no directory to search, so Switch can offer only people it has already seen post in a chat. For that reason, Switch Console skips this step when you connect and tells you how to come back to it.

Do it in this order:

### Add the bot to a chat

A group or a channel, as above.

### Send a message in that chat

Switch can find you only after you've posted in a chat the bot can see.

If the chat is still in mention-only mode, tag the bot in that first message, or it won't reach Switch at all.

### Link yourself in Switch Console

On the server's **Home** page, select **Link account** on the **Link your Telegram account** prompt, or find the connection under **Messaging apps** and select **Link my account…**. Search for yourself and select **This is me**.

To appear in the search, you need:

- A message you've posted in a chat the bot can see
- A username on your Telegram account, which is what Switch identifies you by

If either is missing, the search returns no results and doesn't say why.

## Confirm it worked

- The connection is listed under **Messaging apps** on the server's **Home** page with no error beside its name.
- The bot hasn't posted a warning in the chat. The bot posts only when it can't see the whole conversation, so no warning means it can.
- The chat appears under **Your Rooms** in Switch Console.
- Typing `/` in the chat lists the Switch commands.

## What to expect in Telegram

### Commands

Switch publishes its commands to Telegram every time the connection starts, so typing `/` lists them. There's nothing to set in BotFather. Anything set there by hand is overwritten.

Telegram won't accept a hyphen in a registered command, so hyphenated names are published with underscores. These forms run the same command:

```text
/invite_agent @agent-name
/invite-agent @agent-name
!invite-agent @agent-name
```

Only the underscore form appears in the command menu or renders as something you can tap.

Telegram sends a command the instant you tap it, so a command that needs an argument goes without one. The bot asks for the missing value and opens the composer. Reply with just the value to run the command. Typing the whole command at once skips the prompt.

### Formatting and message length

Agent Markdown is converted to the subset Telegram accepts: bold, italic, strikethrough, code, code blocks, and links. Tables aren't in that subset and arrive as raw text, so agents should use one short line per item instead.

Telegram rejects anything over 4096 characters, so long output is split across several messages on line boundaries.

### Attachments

Images relay as photos so they preview inline. Everything else goes as a document with its bytes intact. Several files sent together arrive as one album.

Incoming files are capped at 20MB. That's a Telegram limit, not a Switch one, and anything over it is reported in the room rather than dropped.

### Threads, supergroups and links

In forum-enabled supergroups, messages have a real topic id and threading works properly. Elsewhere Telegram has only reply chains, so a threaded reply is anchored to the message it replies to.

A group that Telegram converts to a supergroup silently gets a new chat id, and adding members is enough to trigger it. Switch follows the change, re-points the room, and says so in the chat.

A chat with a public username gets an **Open in Telegram** link. A private supergroup uses an address only its members can open, and a basic group has no address at all, so no link is shown for one.

### Group titles

Changing a group's title renames its room. <ComingIn version="Switch 0.33" /> A title changed while the Switch server was stopped is picked up with the next message in the group.

Once someone renames the room in Switch, it keeps that name. A room renamed in Switch 0.31 or earlier wasn't marked as renamed, so while its name still matches the group's, it follows the next rename. Rename it again in Switch to keep your name. Its settings in Switch Console then show the group's current title, with **Use channel name** to take it.

### Open in Switch Console links

The link works only once the administrator of the Switch server sets the server's public address, and so do the links agents post to Switch Console pages. Without it, Telegram posts the address as tap-to-copy text, and an agent's link to a page arrives as the page's name in words. See [Set the server's public address](../self-host.md#set-the-servers-public-address).

## Agent names and progress

To address an agent, type its name. One bot represents every agent, so Telegram treats the name as plain text: no completion and no link, and a typo looks like an agent ignoring you. No setting on the connection changes that.

### Agent names don't autocomplete

Post `!list-agents` to see which names the chat has, and type the name in full. Telegram's `@` autocomplete offers only real members of the chat, and a bot has nowhere to register agent names. The `/` menu does autocomplete, but it lists commands rather than agents.

### See when an agent is working

**The message that asked is marked with 👀** for as long as the turn lasts. It works in groups, supergroups, channels, and private chats, and needs no administrator rights.

It marks the last thing a person said: outside forum topics Telegram has reply chains rather than threads, so there's no thread for a status to belong to.

Where a chat has reactions turned off, the mark is lost and the turn continues without it.

**Alongside it, the bot posts a status message** and edits it in place as the agent's activity changes. It reads `Working…` and the time so far while the turn runs, and `Worked for` and the total when it finishes. The status message stays in the chat afterwards.

## Troubleshooting

### Agents see only messages that tag them

**The bot was added before Group Privacy was turned off, so the chat is mention-only.** Telegram reads that setting when the bot joins.

The bot still works, but Telegram forwards it only these messages:

- Messages that tag it or an agent
- Replies to something it posted
- `/` commands

Nothing else does, so agents won't follow a discussion nobody addresses them in.

The bot posts a notice in the chat saying what it can see. Mention-only is a supported configuration, not a fault.

To repair it:

- **Fix every chat, once.** Turn Group Privacy off in BotFather, then remove the bot from each affected chat and add it back.
- **Fix this chat, now.** Make the bot an administrator of it. No particular right is needed. Admin status alone exempts it. If it's a basic group, Telegram converts it to a supergroup with a new chat id. You don't need to do anything: Switch moves the room to the new id and says so in the chat.

Either way the bot confirms in the chat that it can now see the conversation.

### Messages from people arrive intermittently or not at all

**Two processes are probably sharing the bot token.** Telegram hands each message to **one** polling caller and rejects the rest, so two processes split incoming messages between them at random. Agents still post fine. Only incoming messages are affected.

To fix it:

- **Give each environment its own bot.** A development deployment and a production deployment on one token split incoming messages between them. Make a second bot in BotFather.
- **After a redeploy, check the old process is gone.** An old process still holding the token causes the same problem.

Switch logs an error naming this when Telegram reports the conflict, so check the logs for a polling conflict before looking anywhere else.

## Next steps

- [Create a room](../../getting-started/create-a-room.md) — Make the chat in Telegram, add the bot, and it becomes a room

- [Add a custom agent](../../getting-started/add-a-second-agent.md) — Register an agent with the server so you can invite it into the room

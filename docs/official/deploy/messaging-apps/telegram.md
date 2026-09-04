# Connect Telegram

_Put your Switch agents in Telegram groups and channels, using one bot and one setting_

Published at <https://docs.flintai.dev/flintai/switch/deploy/messaging-apps/telegram> — link readers there, not to this file.

Telegram is the least work to set up: one conversation with BotFather, one setting, and adding the bot to a chat. One bot backs every agent on your Switch server, and because Telegram has no way to change the sender of a message, each agent is identified by its name written at the head of what it posts.

Telegram reaches Switch over a connection Switch opens outwards, so **nothing needs to be publicly reachable**.

**Warning**

Telegram can't create chats. A bot has no way to make a group or a channel, so on Telegram the chat always exists first and Switch adopts it. Switch says so rather than letting you find out from a failure: the connect form disables channel creation, the room forms don't offer it, and an agent asking for a channel is told what to do instead.

## Before you begin

- **A Telegram account**, to talk to BotFather.
- **A username on that account**, not just a phone number. Switch identifies you by your `@username`, so you can't link yourself to it without one.
- **A Telegram group or channel** you can add a bot to.
- **An admin account on the Switch server** you're connecting to. If Switch Console set that server up for you, you have one.

## Set up Telegram

### Ask BotFather for a bot

Open [@BotFather](https://t.me/BotFather) in any Telegram client and send `/newbot`.

Give it a display name — "Agent Switch" is a reasonable choice — and a username ending in `bot`, such as `acme_switch_bot`. BotFather replies with the token.

**Warning**

**Save the token before you do anything else.** BotFather's message is the only time you're shown it — nothing in Telegram displays an existing token again. Save it into your password manager or your deployment's secret store.

The token grants complete control of the bot, so never share it in a chat, ticket, or Switch room.

If you lose it, or expose it, you don't need a new bot. Send `/revoke` to BotFather immediately, then update **Bot Token** on the connection with the new token or the bridge will stop receiving messages.

### Turn Group Privacy off before you add the bot to any chat

In BotFather, send `/mybots`, choose your bot, then **Bot Settings**, then **Group Privacy**, then **Turn off**.

Turn it off so your agents can follow the conversation. Telegram starts every bot in privacy mode, which means the bot only sees messages aimed at it. Everything else said in the chat is invisible to your agents.

**Warning**

Do this before you add the bot to any chat. Telegram reads the setting when the bot joins, so turning it off later won't fix a chat the bot is already in. Those have to be repaired one at a time: remove the bot, then add it back.

## Connect Telegram to your Switch server

### Open the messaging apps for your server

In Switch Console, select the server in the sidebar switcher and open its **Home** page. **Messaging apps** lists what's connected.

### Start the connection

Select **Connect**, then choose **Telegram** under **Messaging app**.

If there's no **Connect** button, you're signed in to that server without admin rights. Connecting a messaging app is an administrator action, so ask whoever runs the server.

### Name the connection

**Name** is how this connection is labeled in Switch Console when you pick it for a room.

### Paste in what BotFather gave you

- **Bot Token** — shaped `<bot id>:<hmac>`.
- **Bot Username** — with or without the leading `@`. Switch uses it to build links and to spot when the bot itself is tagged.

**Allow creating channels from Switch** is off and can't be turned on, with Telegram named as the reason. That's the platform, not a setting.

### Connect

Select **Connect**. Switch starts polling Telegram immediately, so a bad token is reported here.

You won't be asked to link your account yet, and that's deliberate — [Link your Telegram account](#link-your-telegram-account-after-youve-posted) says when to come back to it.

## Add the bot to a chat

### A group

In any Telegram client, open the group, select its title, then **Add Members**, and search for your bot's username.

That's the whole of it. The bot needs no permissions and no admin status — it's a member like anyone else. Telegram tells Switch it was added, Switch creates the room, and the room appears in Switch Console on its own. If the bot can only see messages that tag it, it posts a notice in the group saying so, and how to fix it.

**Tip**

The Gateway offers a shortcut for this. On the connection's row under **Messaging Apps**, the link icon opens **Add this app to a chat**, with **Add to a Telegram group** — pick a group and confirm. It's shown to admins while the connection is running.

### A broadcast channel

A channel isn't a group, and Telegram admits a bot to one as an administrator or not at all. In the channel, open **Administrators**, then **Add Admin**, find the bot, and grant **Post Messages**, **Edit Messages** and **Delete Messages**. Nothing else is needed.

There's deliberately no ready-made link for this. Adding a bot to a channel needs a parameter that not every Telegram client understands, and the ones that don't just open a chat with the bot — which looks exactly like a link that does nothing.

### Not a private chat with the bot

Messaging the bot directly never makes a room. Switch replies with guidance on linking a real one and stops there — nothing is provisioned and no agent sees the message.

That's structural, not unfinished. One bot fronts every agent on your server, so a private chat has no way to say which agent you mean — every agent you own would share the one conversation. A group has the handle a private chat lacks: messages are labeled with the agent's name, and typing a name picks out who you're addressing.

**For a quiet one-to-one, make a group holding just you and the bot**, and invite the one agent you want. It behaves like a direct message, and the agent is addressable by name.

## Link your Telegram account, after you've posted

Switch has to know which Telegram account is you, or an agent set to answer only its owner reads your messages as a stranger's.

Telegram gives a bot no directory to search, so Switch can only offer you people it has already seen speak. That's why Switch Console skips the step when you connect and tells you to come back to it.

The order that works:

### Add the bot to a chat

A group or a channel, as above.

### Send a message in that chat

This is the step that makes you someone Switch has seen. Nothing before it puts you within reach.

If the chat is still in mention-only mode, tag the bot in that first message — otherwise it won't reach Switch at all.

### Link yourself in Switch Console

On the server's **Home** page, find the connection under **Messaging apps** and select **Link my account…**. Search for yourself and select **This is me**.

Only people who've posted in a chat the bot can see are listed. The following aren't linked:

- A member who's never spoken.
- Anyone whose Telegram account has no username, because that's what Switch identifies them by.

In both cases the search comes back empty and doesn't say why.

## Confirm it worked

- The connection is listed under **Messaging apps** on the server's **Home** page with no error beside its name.
- No warning from the bot in the chat. It posts only when it can't see the whole conversation, so silence here is the good outcome.
- The chat appears under **Your Rooms** in Switch Console.
- Typing `/` in the chat lists the Switch commands.

## What to expect in Telegram

### Commands

Switch publishes its commands to Telegram every time the connection starts, so typing `/` lists them. There's nothing to set in BotFather — anything set there by hand is overwritten.

Telegram won't accept a hyphen in a registered command, so hyphenated names are published with underscores. All of these reach the same command:

```text
/invite_agent @agent-name
/invite-agent @agent-name
!invite-agent @agent-name
```

Only the underscore form appears in the command menu, or renders as something you can tap.

Telegram also sends a command the instant you tap it, with no chance to type an argument. So tapping a command that needs one sends it bare, and the bot replies asking for what's missing with the composer already open — answer with just the value and it runs. Typing the whole command at once skips the prompt.

### Formatting and message length

Agent Markdown is converted to the subset Telegram accepts: bold, italic, strikethrough, code, code blocks and links. Tables aren't in that subset and arrive as raw text, so agents should use one short line per item instead.

Telegram rejects anything over 4096 characters, so long output is split across several messages on line boundaries.

### Attachments

Images relay as photos so they preview inline; everything else goes as a document with its bytes intact. Several files sent together arrive as one album.

Incoming files are capped at 20MB. That's a Telegram limit, not a Switch one, and anything over it is reported in the room rather than dropped.

### Threads, supergroups and links

In forum-enabled supergroups, messages carry a real topic id and threading works properly. Elsewhere Telegram has only reply chains, so a threaded reply is anchored to the message it replies to.

A group that Telegram converts to a supergroup gets a brand new chat id, silently — adding members is enough to trigger it. Switch follows the change, re-points the room, and says so in the chat.

A chat with a public username gets an **Open in Telegram** link. A private supergroup uses an address only its members can open, and a basic group has no address at all, so no link is shown for one.

### Open in Switch Console links

Telegram renders only `http`, `https` and `tg:` addresses, so the link Switch posts is only a real link once the server has a public address configured. Without one, the address is posted as tap-to-copy text instead. The public address is set on the Switch server by the server administrator.

## Agent names and progress

Agents aren't registered as Telegram users — one bot fronts all of them. So an agent's name is text that happens to be a name: Telegram doesn't complete it, doesn't turn it into a link, and a typo looks exactly like an agent ignoring you. The addressing works; the confirmation you'd expect doesn't, and no setting on the connection changes that.

### Agent names don't autocomplete

Telegram's `@` autocomplete offers only real members of the chat, and an agent isn't one. There's no user group or alias a bot can register names in, so this isn't something configuration can fix.

Address an agent by typing its name, and post `!list-agents` to see which names the chat has. The `/` menu is the only autocompleting thing Telegram offers a bot, and it lists commands rather than agents.

### Knowing an agent is working

**The message that asked is marked with 👀** for as long as the turn lasts. It works in groups, supergroups, channels and private chats, needs no administrator rights, and is the one progress signal that's always available.

It marks the last thing a person said: outside forum topics Telegram has reply chains rather than threads, so there's no thread for a status to belong to.

Where a chat has reactions switched off, the mark is lost and the turn carries on.

**Alongside it, the bot posts a "⚙️ Working on it…" message** and edits it in place as the agent's activity changes, removing it when the turn ends.

## Mention-only chats, and how to repair one

You'll land here if the bot was added to a chat before Group Privacy was turned off, because Telegram reads that setting when the bot joins.

The bot still works, in a reduced way Telegram enforces before anything reaches Switch. What still reaches it: messages that tag it or an agent, replies to something it posted, and `/` commands. Nothing else does, so agents won't follow a discussion nobody addresses them in.

This is disclosed rather than left to be discovered: the bot posts a notice in the chat saying what it can see. Some groups prefer running this way, so it's a supported state rather than a fault.

Repair every chat once, or just this one:

- **Fix every chat, once.** Turn Group Privacy off in BotFather, then remove the bot from each affected chat and add it back.
- **Fix this chat, now.** Make the bot an administrator of it. No particular right is needed — admin status alone is the exemption. If it's a basic group, Telegram converts it to a supergroup and issues a new chat id at that moment. That's expected and there's nothing to do: the room follows the new id and says so in the chat.

Either way the bot confirms in the chat that it can now see the conversation.

## Run one bridge per bot

Telegram hands each message to **one** polling caller and rejects the rest. Two processes sharing a bot token therefore split the incoming messages between them at random, and the symptom is confusing: agents still post fine, but messages from people arrive intermittently or not at all.

So:

- **Don't run the Switch server with more than one replica** while a Telegram connection is configured on it.
- **Give each environment its own bot.** A development deployment and a production deployment on one token steal each other's messages. Make a second bot in BotFather.
- **After a redeploy, check the old process is gone.** One still holding the token produces exactly this.

Switch logs an error naming this when Telegram reports the conflict, so check the logs for a polling conflict before looking anywhere else.

## Next steps

- [Create a room](../../getting-started/create-a-room.md) — Make the chat in Telegram, add the bot, and it becomes a room

- [Onboard your agents](../../getting-started/onboard-your-agents.md) — Register an agent with the server so you can invite it into the room

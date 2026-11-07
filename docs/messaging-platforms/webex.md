# Connect Webex

_Put your Switch agents in Cisco Webex spaces, using one bot and one setting_

One Webex bot speaks for every agent on your Switch server. Each message starts
with the name of the agent that wrote it. Requests that need an answer arrive
as cards with a button for each option.

Switch listens to Webex over the same kind of connection the Webex apps use: it
opens a socket to Webex, and Webex sends events down it. **Nothing needs to be
publicly reachable.** There is no webhook to register, no public address and no
tunnel, so a Switch running on a laptop connects the same way as one running in
a cluster.

## Before you begin

- **A Webex account.** A free one is enough. Sign in at
  [developer.webex.com](https://developer.webex.com) with it.
- **A Webex space** you can add people to, or you can let Switch create spaces
  for you.
- **An admin account on the Switch server** you're connecting to.

## Create the bot

1. Sign in at [developer.webex.com](https://developer.webex.com), open the menu
   under your avatar, and choose **My Webex Apps**.
2. Select **Create a New App**, then **Onboard Bot** on the **Bot** card.
3. Fill in the form:
   - **Bot name**: what people see beside its messages, for example
     "Switch".
   - **Bot username**: its address, which ends in `@webex.bot`. People use
     it to add the bot to a space.
   - **Icon**: upload one or pick one of Webex's.
   - **App Hub Description**: one sentence about what it does.
4. Select **Add Bot**. The next page shows the **Bot access token**.

> **Save the token now.** Webex shows it only on this page. Put it in your
> password manager or your deployment's secret store. It is the bot's whole
> identity, so never paste it into a chat or a Switch room.
>
> If you lose it or it leaks, open the bot under **My Webex Apps** and select
> **Regenerate Access Token**. The old token stops working immediately, so
> update **Bot access token** on the Switch connection right after.

A bot token doesn't expire. A personal access token, the one shown on Webex's
"Getting started" page, does, and it would post as you. Switch refuses a
personal token when you connect.

## Connect Webex to your Switch server

1. In Switch Console, select the server and open its **Home** page.
   **Messaging apps** lists what's connected.
2. Select **Connect**, then choose **Webex**.
3. **Name** is how the connection is labelled in Switch Console.
4. **Bot access token** is the token from the step above. Pasting it with a
   leading `Bearer ` is fine.
5. Select **Connect**. Switch checks the token with Webex first, so a token
   that's wrong, revoked or personal is reported here, not hours later.

Once connected, Switch registers one device for the bot with Webex, named
`switch-webex-bridge`, and opens its socket. A restart reuses the device.
Deleting the connection removes it.

## Add the bot to a space

### A group space

In Webex, open the space, select **People**, then **Add people**, and search
for the bot's address (`…@webex.bot`). Switch is told the bot was added and
creates the room on its own. It appears in Switch Console under **Your Rooms**.

### Let Switch create the space

**Allow creating channels from Switch** works on Webex. When a room is created
in Switch, the bot creates a Webex space with the room's name and posts the
room's topic as its first message. Switch then adds the people you choose.

### A 1:1 space

Write to the bot directly from Webex. The first message makes a room for that
conversation, and you don't have to mention the bot there.

## Talking to agents

In a **group space**, start the message with the bot's mention, for example
`@Switch fix the failing test`. The message goes to the room's agent. In a room
with several agents, name one after the bot's mention, as in
`@Switch @coder fix the failing test`.

In a **1:1 space**, every message reaches the bot, so no mention is needed.

Commands work as in every other app: `!help`, `!invite-agent @name` and the
rest. `/help` works as well. A `/` followed by anything that isn't a Switch
command, such as a path like `/tmp/build`, is treated as ordinary text.

## Link your Webex account

Switch needs to know which Webex account is yours. Without that, an agent set
to answer only its owner treats your messages as a stranger's.

On the server's **Home** page, find the connection under **Messaging apps** and
select **Link my account…**. Search with your **email address**. That always
works.

Searching by name depends on your Webex organisation, because some
organisations don't let a bot search their people by name. In those, a name
finds only the people Switch has already seen post. An email address finds
anyone.

## What to expect in Webex

- **Agent messages** start with the agent's name in bold. Long replies are
  split into several messages at paragraph breaks, because Webex caps a
  message at 7,439 bytes. A code block that is split is closed in one message
  and reopened in the next.
- **Mentions.** When an agent writes `@ada`, Ada gets a real Webex mention,
  provided Switch knows her. Mention markup an agent writes itself, such as
  `<@personEmail:…>` or `<@all>`, is shown as plain text and notifies no one.
- **Requests** are Adaptive Cards with one button per option. A press goes back
  to Switch, which checks it against the request. Once it's answered, the card
  is redrawn without buttons that says what was chosen and by whom,
  for example "Chosen by Ada Lovelace from Webex". You can also answer by
  typing the option's number.
- **A turn in progress** is one message that's edited as the turn moves, then
  edited once more to say how it ended.
- **Files** go both ways. Webex carries up to 100 MB in one file, and what
  Switch takes in is capped by the server's own attachment limit. Webex scans
  every file for malware before it can be downloaded, so a file can reach the
  agent a few seconds after the message it came with.

### If the connection drops

When the socket comes back after a drop, Switch reads the messages sent while
it was down and hands them on. After a restart it does the same for the last
five minutes, in the spaces it already knows. Switch stores each Webex message
once, however many times it's delivered, so reading back a message that was
already handled does nothing.

## What Webex doesn't allow a bot

These are limits of Webex bots rather than settings in Switch. The adapter
declares each one, so Switch Console and the agents work around them instead of
failing.

- **In a group space, a bot sees only the messages that mention it.** Webex
  gives bots no way to read the rest of a group conversation, so agents don't
  follow what's said around them. Mention the bot in any message meant for an
  agent. A 1:1 space has no such limit.
- **One identity for every agent.** Every message comes from the one bot, with
  the agent's name at the top. Webex has no way to post under another name.
- **No typing indicator and no reactions.** A bot can do neither, so you won't
  see an agent "typing" or reacting with an emoji to show it has started.
- **Ten edits per message.** Webex refuses the eleventh. A running turn's
  status stops updating after eight edits and keeps the last ones for how the
  turn ends. Because of this, the elapsed-time clock isn't redrawn on its own.
- **A card can't mention anyone.** Webex refuses mentions in a message that
  carries a card. When a request needs someone's answer, the mention goes in a
  short message right after the card.
- **Some organisations won't let a card be edited.** There, Webex refuses any
  edit to a message that carries a card. After the first refusal, Switch posts
  the changed card again in the same thread and deletes the old one, so the
  card moves to the bottom of the thread. It does the same for a card that has
  used its ten edits.
- **One file per message.** Several files from an agent arrive as several
  messages.
- **Deleting a room takes the bot out of the space.** A bot can't delete or
  archive a Webex space. The space and its history stay with the people in it.

## Confirm it worked

- The connection is listed under **Messaging apps** with no error beside it.
- After you add the bot to a space, the room appears under **Your Rooms**.
- `@Switch !help` in the space gets the list of commands back.

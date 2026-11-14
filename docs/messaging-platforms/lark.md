# Lark (Feishu)

Connect a Lark or Feishu tenant to Switch with a custom app you create in
your own tenant. Every agent speaks through the app's bot, with its name as
the title of each message. A group chat with the bot in it is a Switch room,
a chat with the bot is a direct room, and a reply in a thread stays in that
thread on both sides.

Lark is one of the newer platforms a server offers only with the
`additional_messaging_platforms` feature flag on (`FEATURE_FLAGS_ENABLED`, or
`featureFlags.enabled` in the Helm chart). With it off, Lark is missing from
Switch Console's list of messaging apps.

Switch receives events over Lark's **persistent connection**: switch-core
dials out to Lark, so the server needs no public address, no tunnel and no
webhook to secure.

Lark (larksuite.com) and Feishu (feishu.cn) are separate platforms with the
same API. Create the app on the one your tenant uses, and pick it as the
connection's region.

## Create the app

In the developer console ([open.larksuite.com/app](https://open.larksuite.com/app),
or [open.feishu.cn/app](https://open.feishu.cn/app) for Feishu):

1. **Create Custom App.** Its name is what people see on the bot.
2. **Add Features → Bot → Add.**
3. **Permissions & Scopes → Add scopes.** Add these:

   | Scope | Why |
   |---|---|
   | `im:message` | Read and send messages |
   | `im:message:send_as_bot` | Post as the bot |
   | `im:message.group_at_msg:readonly` | Receive messages that mention the bot in groups |
   | `im:message.group_msg` | Receive every message in the groups the bot is in, so unaddressed messages still reach the room |
   | `im:message.p2p_msg:readonly` | Receive direct messages to the bot |
   | `im:chat` | Create group chats, add people, and leave a group when its room is deleted |
   | `im:chat:readonly` | Read a group's name and whether it is public or private |
   | `im:resource` | Download and upload images and files |
   | `im:message.reactions:write_only` | Show that an agent is working, as a reaction |
   | `contact:user.base:readonly`, `contact:contact.base:readonly` | Show people by name rather than by id |

4. **Credentials & Basic Info.** Copy the **App ID** (it starts with `cli_`)
   and the **App Secret**.
5. **Version Management & Release → Create a version → Publish.** As the
   tenant's admin you approve it yourself. Scopes and events apply only once a
   version is published.

## Connect it in Switch Console

**Connect a messaging app → Lark**, and fill in:

| Field | What it is |
|---|---|
| Name | How the connection is labelled in Switch Console |
| Region | `lark` for an app made at open.larksuite.com, `feishu` for open.feishu.cn |
| App ID | From Credentials & Basic Info |
| App Secret | From the same page |

Switch checks the ID and secret with Lark before it saves the connection. A
wrong secret is refused with Lark's own words ("app secret invalid"), and an
app without a bot is refused too. One connection per app: Lark hands each
event to one connection, so a second bridge on the same app is refused.

## Turn on events

Once the connection is saved, switch-core holds the app's persistent
connection, which Lark needs before it lets you choose that mode. Back in
the developer console:

1. **Events & Callbacks → Event Configuration → Subscription mode**: choose
   **Receive events through persistent connection** and save.
2. **Add Events**: `im.message.receive_v1`, `im.message.recalled_v1`,
   `im.chat.member.bot.added_v1`, `im.chat.member.user.added_v1`.
3. **Callback Configuration → Subscription mode**: **Receive events through
   persistent connection**, save, and add the callback `card.action.trigger`
   (the buttons on approval and question cards).
4. Publish a new version.

Then add the bot to a group: in the group's settings, **Group bots → Add
bot**. The group becomes a room the first time someone writes in it.

## Using it

- Address an agent as `@agent-name`, or mention the bot itself in a room with
  one agent. Messages that mention nobody still reach the room.
- `!commands` work from Lark: `!invite-agent @coder`, `!link-account <code>`,
  `!help`. A command may follow a mention of the bot.
- An agent's turn is a card, redrawn as it works, with **Stop current work**
  while it runs. Approval and question cards have a button for each option;
  the card is redrawn with the answer and who gave it.
- While an agent works on a message, the bot puts a reaction on it.
- To have your own agents recognise you, link your Lark account: **Link
  account** in Switch Console, then post the code it shows from Lark.

## What Lark can't do here

| | |
|---|---|
| Agent identities | One bot speaks for every agent; each message is titled with the agent's name |
| Directory search | Lark's contact search needs a person's own sign-in, not the app's, so Switch lists only people it has seen in a chat |
| Typing indicator | Lark shows a bot none; the working reaction says it instead |
| Edits and deletes made in Lark | An agent's own messages are edited and recalled in Lark. A message a person edits or recalls in Lark keeps its first version in Switch: Switch has no way yet to take an inbound edit |
| Slash commands | A custom app's bot has no slash commands; type `!commands` instead |
| Custom URL schemes | Lark links `http(s)` only |

Files: images up to 10 MB and other files up to 30 MB, Lark's own limits. A
larger file from an agent is named in the chat as not sent, and a file from
Lark larger than the server takes is named in the room as not relayed.

## Several pods

Only the pod holding the bridge opens the persistent connection; the other
pods run a quiet copy and call Lark's API themselves, which needs no
connection. Each event is acknowledged only after it is handled, Lark pushes
an unacknowledged event again, and a second delivery carries the same message
id, so a restart or a move to another pod loses and duplicates nothing.

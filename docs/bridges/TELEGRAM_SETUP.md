# Telegram collaboration bridge setup

Connects Telegram groups and channels to Switch. A **single bot** backs every
Switch agent. Telegram has **no per-message identity override** — nothing like a
Discord webhook's username/avatar — so an agent is identified by its **name
rendered at the head of each message**. Inbound events arrive by **long polling**
(an outbound connection), so **no public ingress is required**; outbound goes
through the Bot API.

Rooms are **adopted, never created**: the Bot API gives a bot no way to create a
chat. A chat's Switch room is provisioned when the bot is **added to the group**
(Telegram does signal this, unlike Discord) or on the first bridged message.

## Prerequisites

- A Telegram account, to talk to [@BotFather](https://t.me/BotFather).
- A Telegram group or channel where you can add and promote a bot.
- The Switch gateway reachable by an admin to onboard the bridge.

## 1. Create the bot

1. Open [@BotFather](https://t.me/BotFather) in any Telegram client and send
   `/newbot`.
2. Give it a display name (e.g. "Agent Switch") and a username ending in `bot`
   (e.g. `acme_switch_bot`). The username is the `bot_username`.
3. BotFather replies with the **token** — this is the `bot_token`. It has the
   shape `<bot id>:<hmac>`. Treat it like a password; anyone holding it controls
   the bot.

## 2. Disable privacy mode

**This is the step that breaks a bridge if you skip it.** By default a Telegram
bot in a group only receives messages that start with `/`, replies to its own
messages, and service messages. A bridge that cannot see ordinary conversation
is useless, so privacy mode must be turned off:

1. Send `/setprivacy` to BotFather.
2. Pick your bot.
3. Choose **Disable**.

This is Telegram's equivalent of Discord's Message Content Intent. If agents only
ever see messages that reply to them directly, this is why.

> Privacy mode is read when the bot **joins** a chat. If the bot was already in a
> group when you changed the setting, remove it and add it back.

To check the current setting without leaving the terminal:

```bash
curl -s "https://api.telegram.org/bot<your-token>/getMe" | grep -o '"can_read_all_group_messages":[a-z]*'
```

`true` means privacy mode is off and the bridge can see the conversation. The
bridge checks this itself at startup and logs a warning naming the fix when it
is still on, so a bridge that has quietly gone deaf says so in the logs rather
than just looking idle.

## 3. Add the bot to a group or channel

Add the bot as you would any member, then **promote it to administrator**. It
needs:

- **Send Messages** — post agent replies.
- **Delete Messages** — remove the "working on it…" status message when a turn
  ends. Without this the indicators accumulate.
- **Post Messages** / **Edit Messages** — required in channels (broadcast
  chats), where posting is admin-only.

A bot cannot be added to a chat by Switch, and it cannot add anyone else: people
join from a Telegram client or an invite link.

## 4. Onboard the bridge in Switch

As a gateway admin, onboard the bridge from the **operator dashboard**:
**Messaging Apps → Add bridge → Telegram**, give it a display name (e.g. "Acme
Telegram"), and fill in the fields below.

Fields (`TelegramConnectionConfig`):

| Field | Required | Description |
| --- | --- | --- |
| `bot_token` | yes | Bot token from BotFather, shaped `<bot id>:<hmac>`. |
| `bot_username` | yes | The bot's username, with or without the leading `@`. Used to build `t.me` links and to spot when the bot itself is tagged. |

On success the bridge starts polling. Add the bot to a group and its Switch room
is created straight away; post a message and agents can be addressed by
`@mention` as on any other platform.

## Clickable "Open in SwitchDash" links (`GATEWAY_PUBLIC_URL`)

Telegram only linkifies `http(s)`, so a raw `switchdash://session?…` deeplink
renders as plain text. Set **`GATEWAY_PUBLIC_URL`** on switch-core to the Switch
API's public origin — scheme + host only, **no path** — the same host SwitchDash
reports as its `server` (distinct from the operator UI):

```dotenv
# .env / deployment env
GATEWAY_PUBLIC_URL=https://switch-api.acme.com
```

When set, Switch rewrites the deeplink to a clickable
`https://<switch-api-host>/deeplink/session?…` redirect (a `302` back to the
`switchdash://` scheme) at runtime-state ingestion — so both the bridged
working/awaiting-input status message **and** the `!status` command surface a
clickable link. When unset, the raw `switchdash://` link is posted as before
(disclosed fallback).

The value is validated at startup: it must be scheme + host only. A URL carrying
a path is rejected, because the redirect is served at `/deeplink/session` on the
API root (the agent-bridge app, **not** under the `/gateway` mount) and a path
prefix would build links that 404.

## One instance per bot token

Telegram delivers each update to **one** long-polling caller and rejects the
others with a `Conflict`. Two processes sharing a bot token therefore split the
inbound traffic between them at random, which looks like this: the bridge still
sends fine, agents still post, but messages from people are seen intermittently
or not at all.

So:

- **Do not run switch-core with more than one replica** while a Telegram bridge
  is configured on it.
- **Give each environment its own bot.** A dev deployment and a production
  deployment on the same token will steal each other's messages. Make a second
  bot in BotFather for dev.
- After a redeploy, make sure the previous instance is actually gone — an old
  process still holding the token produces exactly this symptom.

The bridge logs an error naming this when Telegram reports the conflict, so
check the logs for "Another process is polling Telegram" before looking
anywhere else.

## Notes

- **Commands.** Both `/invite-agent @agent-name` and `!invite-agent @agent-name`
  work. `/` is Telegram's own convention — the client makes it tappable and
  offers autocomplete — and it is the form that still works if privacy mode is
  left enabled, since a `/`-prefixed message is then the only text the bot
  receives in a group.
- **Room icon.** SwitchDash shows a Telegram icon for Telegram rooms
  (`telegram.svg`, keyed to `bridge_type` `"telegram"`).
- **Message formatting.** Agent Markdown is converted to the HTML subset Telegram
  accepts (bold, italic, strikethrough, code, pre, links). Telegram's own
  MarkdownV2 is deliberately not used: it requires escaping ordinary punctuation
  and rejects an entire message over one stray character. If Telegram ever
  refuses the markup anyway, the message is re-sent unformatted and a warning is
  logged — it is never dropped.
- **No tables.** Telegram does not render Markdown tables; they arrive as raw
  `| … |` text. Use one short line per item with bold labels, as on Slack.
- **Message length.** Telegram rejects anything over 4096 characters, so long
  agent output is split across several messages on line boundaries.
- **Threads.** In forum-enabled supergroups, messages carry a real topic id and
  threading works properly. Elsewhere Telegram has only reply chains, so a
  threaded reply is anchored to the message being replied to.
- **Attachments.** Images relay as photos so they preview inline; everything else
  goes as a document with its bytes intact. Several files sent together arrive as
  one album (Telegram allows 2–10 items of the same kind). Inbound files are
  capped at **20MB** — a Bot API limit, regardless of the bridge's own ceiling —
  and anything over it is disclosed in the room rather than dropped.
- **Mentions.** People with a public `@username` are mentioned by handle.
  Everyone else is mentioned by numeric id, which works because Switch supplies
  the bridge with the known user mapping up front.
- **DMs.** A 1:1 chat with the bot is bridged, but Switch cannot start one —
  Telegram DMs are opened by the user. Message the bot first and the conversation
  is picked up.
- **Creating channels.** Switch cannot provision a Telegram chat. Attempting it
  fails with an error telling you to create the chat and add the bot.

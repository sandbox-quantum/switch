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

Setup is two steps: make a bot, then click a link. Nothing in BotFather has to
be reconfigured, and the bot does not have to be promoted by hand.

## Prerequisites

- A Telegram account, to talk to [@BotFather](https://t.me/BotFather).
- A Telegram group or channel you can add a bot to.
- The Switch gateway reachable by an admin to onboard the bridge.

## 1. Create the bot and onboard the bridge

1. Open [@BotFather](https://t.me/BotFather) in any Telegram client and send
   `/newbot`.
2. Give it a display name (e.g. "Agent Switch") and a username ending in `bot`
   (e.g. `acme_switch_bot`). The username is the `bot_username`.
3. BotFather replies with the **token** — this is the `bot_token`. It has the
   shape `<bot id>:<hmac>`. Treat it like a password; anyone holding it controls
   the bot. Do not paste it into a chat, a ticket or a room, and revoke it with
   BotFather's `/revoke` if you ever do.
4. As a gateway admin, onboard the bridge from the **operator dashboard**:
   **Messaging Apps → Register messaging app → Telegram**, give it a display
   name (e.g. "Acme Telegram"), and fill in the fields below.

Fields (`TelegramConnectionConfig`):

| Field | Required | Description |
| --- | --- | --- |
| `bot_token` | yes | Bot token from BotFather, shaped `<bot id>:<hmac>`. |
| `bot_username` | yes | The bot's username, with or without the leading `@`. Used to build `t.me` links and to spot when the bot itself is tagged. |

On success the bridge starts polling.

## 2. Add the bot to a chat, from the dashboard

On the bridge's row in **Messaging Apps**, the link icon opens **Add to a chat**
with two links:

- **Add to a Telegram group** — opens Telegram, asks which group, and adds the
  bot as an administrator with the one right the bridge uses. One confirmation.
- **Add to a Telegram channel** — the same for a broadcast channel, which needs
  the rights that posting and editing there require.

Switch creates the room the moment the bot lands in the chat, and the bot says
in the chat what it can see.

**Why administrator.** Telegram runs bots in *privacy mode* by default: a
non-admin bot in a group is only given messages that start with `/`, replies to
its own messages, and messages that tag it. Telegram exempts a bot that is an
administrator of the chat, which is what these links grant — so a bridge that
sees the whole conversation needs no BotFather change at all. (Disabling privacy
mode globally with `/setprivacy` also works, and the bridge honours it, but then
the setting is only re-read when the bot **joins**, so the bot must be removed
from each existing group and added back. The link is the shorter path.)

**Which rights are asked for.** In a group, only **Delete Messages** — a bot may
always delete its own messages there, but only for 48 hours, and a "working on
it…" indicator can outlive that. In a channel, **Post Messages**, **Edit
Messages** and **Delete Messages**, because a channel is a broadcast chat where
posting is admin-only. Nothing else is requested.

A bot cannot be added to a chat by Switch, and it cannot add anyone else: people
join from a Telegram client or an invite link.

## Running without administrator: mention-only

A bot that is neither an administrator nor exempted by `/setprivacy` still
works, in a reduced way Telegram enforces before anything reaches Switch. It
receives:

- messages that tag it (`@acme_switch_bot`) or tag an agent whose name appears
  in the same message,
- replies to its own messages,
- `/` commands.

It does **not** receive ordinary conversation, so agents will not follow a
discussion nobody addresses them in. This is a supported way to run — some
groups would rather not grant a bot admin — and it is disclosed rather than left
to be discovered: the bot posts a one-off notice in the chat saying it can only
see messages that tag it, and the bridge logs a warning naming each mention-only
chat at startup.

To upgrade a chat later, promote the bot to administrator in Telegram's group
settings, or re-run the dashboard's **Add to a Telegram group** link and pick
the same group — Telegram combines the new rights with the existing ones.

## Clickable "Open in Switch Console" links (`GATEWAY_PUBLIC_URL`)

Telegram only linkifies `http(s)`, so a raw `switchdash://session?…` deeplink
renders as plain text. Set **`GATEWAY_PUBLIC_URL`** on switch-core to the Switch
API's public origin — scheme + host only, **no path** — the same host Switch Console
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

## Slash commands

`/` is Telegram's own command convention, and the bridge publishes the in-room
command set to Telegram on every start, so typing `/` in the chat lists them
with descriptions. Nothing to do in BotFather — `/setcommands` is not needed,
and anything set there by hand is overwritten on the next start.

Telegram will not accept a hyphen in a registered command, so the hyphenated
names are published in their underscore spelling. Both resolve to the same
command, and so does the `!` form:

- `/invite_agent @agent-name` — as offered by the menu
- `/invite-agent @agent-name` — typed in full
- `!invite-agent @agent-name` — Switch's own prefix, works on every platform

The `/` forms matter beyond convenience: in a mention-only chat, a `/`-prefixed
message is one of the few things the bot receives at all.

`/start` is Telegram's own handshake rather than a Switch command — it is what
the dashboard's install links send once the bot has been added — so the bridge
answers it itself instead of passing it on as an unknown command.

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

- **Room icon.** Switch Console shows a Telegram icon for Telegram rooms
  (`telegram.svg`, keyed to `bridge_type` `"telegram"`).
- **"Open in Telegram".** A chat with a public username links straight to
  `t.me/<name>`. A private supergroup uses Telegram's internal address, which
  only opens for members of that chat. A **basic group** — one Telegram has
  never upgraded to a supergroup — has no address at all, so no button is
  shown; adding enough members, or setting a public link, converts it and the
  button appears.
- **A group that becomes a supergroup keeps its room.** Telegram issues a brand
  new chat id at that moment, and it does it silently — promoting a bot or
  adding members is enough to trigger it. The bridge follows the change and
  re-points the room at the new id, then says so in the chat. Before that was
  automatic the symptom was one-way traffic: sends still arrived, because
  Telegram forwards them to the new chat, while nothing anyone typed reached
  Switch again.
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
  fails with an error telling you to create the chat and add the bot with the
  dashboard's link.

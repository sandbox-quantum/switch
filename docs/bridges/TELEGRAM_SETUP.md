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

Setup is one BotFather setting, once, and then adding the bot to each chat. The
bot is never promoted, and needs no permissions in a group.

## Prerequisites

- A Telegram account, to talk to [@BotFather](https://t.me/BotFather).
- A Telegram group or channel you can add a bot to.
- The Switch gateway reachable by an admin to onboard the bridge.

## 1. Create the bot and turn Group Privacy off

1. Open [@BotFather](https://t.me/BotFather) in any Telegram client and send
   `/newbot`.
2. Give it a display name (e.g. "Agent Switch") and a username ending in `bot`
   (e.g. `acme_switch_bot`). The username is the `bot_username`.
3. BotFather replies with the **token** — this is the `bot_token`. It has the
   shape `<bot id>:<hmac>`. Treat it like a password; anyone holding it controls
   the bot. Do not paste it into a chat, a ticket or a room, and revoke it with
   BotFather's `/revoke` if you ever do.
4. **Turn Group Privacy off**, before adding the bot anywhere:
   `/mybots` → the bot → **Bot Settings** → **Group Privacy** → **Turn off**.

**Why, and why now.** Telegram runs bots in *privacy mode* by default: in a
group a bot is given only messages that start with `/`, replies to its own
messages, and messages that tag it. A bridge that cannot see the conversation is
a bridge in name only. Telegram reads this setting **when the bot joins a chat**,
so doing it first means every group you add the bot to afterwards just works;
doing it later means removing the bot from each existing group and adding it
back.

There is one alternative, and it is worse for most people: a bot that is an
**administrator** of a chat is exempt from privacy mode whatever the setting
says. That is a promotion per group instead of a setting per bot, it converts a
basic group into a supergroup, and Telegram's "add as admin" chat picker leaves
basic groups out — so it is offered as a repair for a single chat (below), not
as the way in.

5. As a gateway admin, onboard the bridge from the **operator dashboard**:
   **Messaging Apps → Register messaging app → Telegram**, give it a display
   name (e.g. "Acme Telegram"), and fill in the fields below.

Fields (`TelegramConnectionConfig`):

| Field | Required | Description |
| --- | --- | --- |
| `bot_token` | yes | Bot token from BotFather, shaped `<bot id>:<hmac>`. |
| `bot_username` | yes | The bot's username, with or without the leading `@`. Used to build `t.me` links and to spot when the bot itself is tagged. |

On success the bridge starts polling.

## 2. Link a chat to Switch — from Telegram

**This is the normal way, and it needs nothing from Switch.** In any Telegram
client:

1. Create a group, or open one you already have.
2. Add the bot to it like any other member: the group's title → **Add Members**
   → search for `@acme_switch_bot` → confirm.
3. That is the whole of it. Telegram tells the bridge it was added, Switch
   creates a room for the chat, and the bot posts in the group saying whether
   it can see the conversation. The room appears in the dashboard and in
   Switch Console on its own.

The bot needs **no permissions and no admin status** in a group. It is a
member, like anyone else.

A room made this way is a room like any other — add agents to it with
`!invite-agent @agent-name` in the chat (see [Slash commands](#slash-commands)
for the `/` forms), or from the dashboard.

**Nothing is created from the Switch side.** Switch cannot make a Telegram
chat — the Bot API has no call for it — so the chat always exists first and
Switch adopts it. That is recorded against the connection rather than left to
be discovered: a Telegram connection reports that it cannot create channels,
the room forms in the dashboard and Switch Console do not offer the option, and
an agent calling `create_room` on it is told the same in the error rather than
getting a failure it cannot interpret. See
[Channel creation](README.md#channel-creation) for the setting that carries
this, which applies to every platform.

## 3. Or add the bot from the dashboard

The same thing, one click, when you would rather start from Switch.

On the bridge's row in **Messaging Apps**, the link icon opens **Add to a chat**
with a single link: **Add to a Telegram group**. It lists every group you can add
a member to. Pick one and confirm — again, no permissions. Switch creates the
room as the bot lands.

The icon is shown to admins, and only while the bridge is running — the link is
built by the live bridge, so a bridge that failed to start offers none.

There is deliberately **no one-click link for a channel**. Telegram's
`?startgroup` link needs no special parameter and works everywhere, but adding a
bot to a channel requires the `admin=` parameter, which not every Telegram
client implements — the ones that do not simply open a chat with the bot, which
is indistinguishable from a link that does nothing. Rather than ship a link that
works for some people, channels are added by hand (below).

## 4. Adding the bot to a broadcast channel

A channel is not a group, and Telegram admits a bot to one as an administrator
or not at all. In the channel: **Administrators** → **Add Admin** → search for
the bot → grant **Post Messages**, **Edit Messages** and **Delete Messages**.
Nothing else is needed, and Switch adopts the channel as a room the moment the
bot lands.

A bot cannot be added to a chat by Switch, and it cannot add anyone else: people
join from a Telegram client or an invite link.

## Mention-only chats, and how to repair one

A chat where privacy mode is still in force still works, in a reduced way
Telegram enforces before anything reaches Switch. The bot receives:

- messages that tag it (`@acme_switch_bot`) or tag an agent whose name appears
  in the same message,
- replies to its own messages,
- `/` commands.

It does **not** receive ordinary conversation, so agents will not follow a
discussion nobody addresses them in. That is a supported way to run — some
groups would rather the bot saw only what is aimed at it — and it is disclosed
rather than left to be discovered: the bot posts a notice in the chat saying it
can only see messages that tag it, and the bridge logs a warning naming each
such chat at startup.

You will land here if the bot was added to the chat **before** Group Privacy was
turned off, since Telegram reads that setting at join time. Two ways out:

- **Every chat, once** — turn Group Privacy off (step 1), then remove the bot
  from the affected chat and add it back.
- **This chat, now** — make the bot an administrator of it. No particular right
  is needed; admin status alone is the exemption. If the chat is a basic group,
  Telegram converts it to a supergroup and issues a new chat id at that moment —
  expected, and nothing to do: the room follows the new id and says so.

Either way the bot confirms in the chat that it can now see the conversation,
and a demotion is announced the same way.

## Clickable "Open in Switch Console" links (`GATEWAY_PUBLIC_URL`)

**Set this one.** On Telegram it is what makes the "Open in Switch Console"
link a link at all, not a refinement — the bridge logs a warning at startup
when it is missing.

Telegram renders only `http(s)` and `tg:` URLs. A `switchdash://session?…`
deeplink is neither, and Telegram does not ignore it politely: depending on the
client it drops the link and leaves the words behind, or the API rejects the
whole message. So without this set, the bridge does not offer Telegram a link
it cannot render — it posts the address as a tap-to-copy code span instead,
which works but is not a link. With it set, the link is a real one and opens
Switch Console from the Telegram app and from Telegram Web alike.

Set **`GATEWAY_PUBLIC_URL`** on switch-core to the Switch
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
clickable link. When unset, the address is posted as a code span — visible and
tap-to-copy, and disclosed as the fallback it is.

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

- `/invite_agent @agent-name` — as offered by the menu, and the form the bot
  advertises in a room with no agents in it: it is the only one Telegram will
  autocomplete or render as a tappable command
- `/invite-agent @agent-name` — typed in full; accepted, but Telegram's client
  tokenises the command as `/invite` and will not offer it
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
- **Creating channels.** Switch cannot provision a Telegram chat, and says so
  before you try: the connection reports that it cannot create channels, so the
  room forms omit the option and `list_bridges` tells an agent the same. Calling
  it anyway is a `400` naming the chat to make and the bot to add, not a 500.

# Zulip

Switch connects to Zulip with a bot on your own organization. The bot dials
out: it registers an event queue and long-polls it
(`/api/v1/register` + `/api/v1/events`), so Switch needs no public address
and Zulip needs nothing pasted into it.

## Mapping: streams, topics, and threads

**A Zulip stream (channel) is a Switch room. A topic within it is a
thread.** Every stream message carries a topic, so a reply posted in reply
to one goes back into that same topic; a message that starts no thread (an
approval card with nothing to reply to, say) goes to the connection's
**Topic for new posts**.

A thread is identified by its topic's name, not by a message id — a topic
is already a stable, named thing on Zulip, so there is nothing else to
track. One consequence: **renaming a topic on Zulip starts a new thread on
the Switch side**, because the old and new names are different threads.
This is a fact about the mapping, not a bug — if you need a thread to
survive a rename, don't rename the topic.

A direct message conversation (one person, or several) is also a room, but
has no topics, so it has no threads: every reply in it is top-level.

## What's supported

| Capability | Status |
| --- | --- |
| Mention → reply under the agent's name | Supported — one bot speaks for every agent, so each reply opens with the agent's name in bold |
| Unaddressed messages reaching the room | Supported |
| Threads (topics) | Supported, both ways |
| Edits (agent's own message, outbound) | Supported — `PATCH /messages/{id}` |
| Deletes (agent's own message, outbound) | Supported — `DELETE /messages/{id}` |
| Edits/deletes a person makes on Zulip, mirrored into the room | **Not supported.** Switch's adapter interface has no inbound edit/delete contract yet, for any platform — Zulip does receive `update_message`/`delete_message` events, but nothing in Switch today would know what to do with one |
| Attachments, both ways | Supported, through `/user_uploads`; a file over the organization's `max_file_upload_size_mib` is refused with a visible note instead of being sent |
| Formatting | Supported — Zulip's Markdown already spells bold and code the way Switch does |
| Long replies | Split under the organization's `max_message_length`, on line or word boundaries, never inside a fenced code block or a multi-byte character |
| `!commands` | Supported |
| The agent shows it's working / answering a question or approval card | A 👀 reaction while working, an ⏳ reaction while queued, and the request/answer as plain text (Zulip bots have no buttons) |
| Channel creation | Supported, where the organization lets the bot create streams |
| Restart recovery | **Nothing is lost or duplicated** — see below |
| Slash commands | **Not supported.** Zulip has no slash-command registration for bots; use `!commands` |
| User directory search | **Not supported in this adapter.** Only people who have posted in a connected stream or DM are known to Switch |
| Reactions on a message other than the agent's own working/queued mark | **Not mirrored.** There is no Switch contract yet for an inbound reaction event |

## Restarting loses and duplicates nothing

Switch keeps no cursor of its own for this. Instead, a message the bot
receives is marked read on Zulip's own server only *after* it has reached
the room — never before. Every time Switch opens a fresh event queue (on
startup, after Zulip expires one with `BAD_EVENT_QUEUE_ID`, or because a
different pod just took this bridge's lease), it first asks Zulip for
whatever is still unread and delivers that, oldest first, before opening
the live queue. Since the read flag lives on Zulip rather than in Switch,
whichever process picks the bridge up next resumes exactly where the last
one left off — and since `message_ref` is Zulip's own message id, a message
that happens to arrive from both the catch-up and the live queue is written
once.

One consequence worth knowing: the **first** time you connect a bot that
already has old unread messages in its streams, Switch will deliver that
backlog too. A bot created fresh for this integration starts with none.

## Creating the bot

1. In Zulip, go to **Personal settings → Bots → Add a new bot**, and choose
   **Generic bot**. Give it a name and, optionally, an avatar.
2. Copy its **API key** from the bot's settings — you'll paste this into
   Switch Console, never anywhere else.
3. Note the bot's **email address** (shown on the same page) and your
   organization's **URL** (the address you use to open Zulip in a browser,
   e.g. `https://your-org.zulipchat.com`).
4. **Subscribe the bot to every stream you want it in.** From the bot's own
   settings, or from each stream's settings, add the bot as a subscriber.
   The bot needs to be subscribed before Switch can relay anything in that
   stream — Switch does not subscribe it for you except when an agent
   creates a new channel.

## Connecting in Switch Console

Open **Connect a messaging app → Zulip** and fill in:

| Field | Meaning |
| --- | --- |
| Site | Your organization's base URL, e.g. `https://your-org.zulipchat.com`. Must be `https`, with no path and no embedded username/password |
| Bot email | The bot's email address from its settings page |
| API key | The bot's API key |
| New topic | Where a message with no thread to reply to is posted (default: `Switch`) |

Click **Connect**. A wrong API key, a wrong site, or an account that turns
out not to be a bot are all checked immediately and refused with a clear
reason before the connection is saved.

**Disconnecting** stops the bot's queue; it stays subscribed to its
streams. Deleting a room unsubscribes the bot from that one stream, leaving
the stream itself (and its history) exactly as it was.

## Limits worth knowing before you connect

- **One bot, one identity, every agent.** Zulip has no per-message identity
  override, so, like Telegram, every agent's name is written into the
  message body rather than carried by a separate bot account.
- **No slash commands and no buttons.** `!commands` and typed replies to a
  card stand in for both.
- **No directory search.** Someone has to have posted in a stream or DM the
  bot can see before Switch can name them.

## Troubleshooting

- **"Zulip refused these credentials"** — the API key or bot email is
  wrong, or the key was regenerated on Zulip after it was entered here.
- **"This is a person's account, not a bot"** — a human's own email and API
  key were entered. Create a bot under **Personal settings → Bots** instead
  and use its credentials.
- **Messages never arrive in a stream** — the bot must be subscribed to
  that stream; being an organization admin does not imply a subscription.
- **A reply lands in the wrong topic, or a new one** — check whether the
  topic it was replying to was renamed on Zulip; see "Mapping" above.

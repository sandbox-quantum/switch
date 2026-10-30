# Zulip

Zulip connects to Switch with a bot of your own. Switch does not wait for Zulip
to call it: the bot opens an event queue on your organization and long-polls it,
so you do not need a public address, a tunnel or an HTTPS certificate to try it.

## What you create on Zulip

You need a Zulip account that can create bots in the organization you want to
connect — normally any member can.

1. In Zulip, open **Settings → Bots** (in a personal settings menu, sometimes
   **Personal settings → Bots**).
2. Choose **Add a new bot**.
3. Give it a name Switch agents can be recognised by, for example `switch`, and
   pick the bot type **Generic bot** — the incoming-webhook type cannot read
   messages.
4. Create it, then copy the bot's **email address** (it looks like
   `switch-bot@your-org.zulipchat.com`) and its **API key**.

The address in the form is the bot's, not yours: the two differ, and a wrong one
fails as "unauthorized" rather than as a wrong address.

The bot needs to be subscribed to the streams it should read. It subscribes to
the stream of any room Switch creates; for a room you make on Zulip first,
subscribe the bot to that stream in Zulip's stream settings, or add it from the
room with `!invite-agent` once it is in one stream.

## Connecting

In Switch Console, open **Connect a messaging app**, choose **Zulip**, and fill
in:

| Field | What it is |
|---|---|
| **Organization address** | Your organization's address, e.g. `https://acme.zulipchat.com`. Only the address: Switch adds `/api/v1` itself. |
| **Bot address** | The bot's Zulip email address. |
| **API key** | The bot's API key. Zulip shows it in the bot's settings. |
| **Default topic** | The topic a message lands in when it is not a thread reply. Defaults to `Switch`. Every room keeps this topic for its top-level conversation. |
| **Verify TLS** | Leave on. Turn it off only for a self-hosted Zulip with a certificate your server does not trust. |

Switch checks the credentials before saving them, so a mistyped key is refused
there rather than when the first message is due.

## How rooms and threads map

- **A stream is a room.** A room's external channel id is the stream's id, so
  renaming a stream on Zulip does not move the room.
- **A topic is a thread.** A message in a topic other than the default one is a
  reply in that thread; a message in the default topic is top-level. An agent's
  reply in a thread is posted back into the same topic.
- **Renaming a topic on Zulip starts a new Switch thread.** The topic name is
  what both sides identify the thread by, so a rename cannot be followed: the
  messages already relayed stay in the old thread, and the next reply opens the
  new one. Zulip keeps the history either way.
- **A direct message is not a room.** Switch rooms are streams, so a private
  conversation between two accounts is not relayed into one.

## What works, and what does not

Works:

- messages both ways, with an agent's name and a stable mark at the head of each
  message (one bot posts for every agent — Zulip bots are separate accounts, and
  making one per agent would need organization administration);
- thread replies in both directions;
- editing and deleting a message Switch posted;
- attachments both ways. Outbound files are uploaded to the organization and
  linked from the message; inbound files are downloaded, and a file over the
  deployment's media limit is refused in the room rather than dropped quietly;
- long replies, split at 10,000 characters — Zulip's cap — with code blocks
  closed and reopened so a long answer stays formatted;
- `!commands` from the room, exactly as on the other platforms;
- the typing indicator (Zulip expires it itself; there is no stop to send);
- creating a room: the bot subscribes to a new stream of that name, private when
  the room is private, if the organization lets members create streams;
- adding people to a room, where the bot has permission to subscribe others;
- directory search over the organization's members, so somebody who has never
  posted can still be found.

Does not work, and why:

- **Approval and question cards arrive as text.** Zulip messages can carry no
  buttons, so a card is posted as its text form — the question, its numbered
  options and the reply grammar — and answering is typing that reply in the
  room. Nothing about the answer is lost; only the buttons are.
- **No reactions.** Switch does not use activity reactions on this platform, so
  an agent working is shown in the room's text, not as an emoji on a message.
- **Inbound edits and deletes are not mirrored.** If somebody edits or deletes a
  message on Zulip after sending it, Switch keeps what was said when it arrived.
- **No session activity cards.** Turn activity is posted as text.
- **Per-agent identities.** Every agent posts as the one bot, with its name in
  the message.

## Running several pods

The event queue is a long-lived connection, so it is opened only on the pod
holding the bridge (`keeps_quiet_unless_listening`). Any other pod runs a quiet
copy that still answers Console and serves room operations. A message that is
delivered twice is dropped by the platform's message id, which is the same on
every delivery, so a queue that is re-opened after a restart neither loses nor
duplicates anything.

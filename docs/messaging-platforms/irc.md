# IRC

Switch joins an IRC network as one bot: a nick that sits in the channels you
name and speaks for every agent there. Each agent's lines start with its name,
so a reply from the agent `helper` reads `[helper] On it.`

## On the network

1. **Pick a nick for the bot**, such as `acme-switch`. On networks that have
   services (Libera.Chat, OFTC and most others), connect with any IRC client
   using that nick and register it, so nobody else can take it:

   ```
   /msg NickServ REGISTER <password> <email>
   ```

   Follow the confirmation the network sends. Libera.Chat's guide:
   <https://libera.chat/guides/registration>.

2. **Create or choose the channels** the bot should sit in, such as `#acme`.
   If a channel is invite-only or needs a key, let the bot in first (for
   example, add it to the channel's access list with ChanServ). The bot joins
   with no key.

3. Nothing else: IRC has no apps or tokens to create.

## In Switch Console

Under **Connect a messaging app**, pick **IRC** and fill in:

| Field | What it is |
|---|---|
| Server | The network's server host, such as `irc.libera.chat`. |
| Port | `6697` for TLS on most networks; `6667` without. |
| Use TLS | Leave on. Turn it off only for a network that offers no TLS. |
| Nick | The bot's nick from step 1. |
| Account | The services account, if it is not the nick. Usually left empty. |
| Password | The account's password. Switch logs in with SASL PLAIN where the network offers it, and sends `IDENTIFY` to NickServ otherwise. Leave empty for a nick that is not registered. |
| Channels | The channels to join, such as `#acme`. |

Switch signs the bot in once before saving, so a nick that is already in use,
a wrong password or an unreachable server is reported right away.

## Talking to agents

- Mention an agent with `@name`, as on the other platforms:
  `@helper why is the build red?`. A message that mentions nobody still
  reaches the room.
- `!commands` work as typed: `!invite-agent @helper`, `!help`.
- A private message to the bot opens a direct room with you.
- Long replies are cut into lines the network relays whole, at most 15 to a
  reply and paced so the network does not disconnect the bot for flooding.
  A longer reply says how many lines it left out; the whole reply is in
  Switch.
- Agents have no nicks of their own; the bot posts for them.

## Who is who

When the network says a person is logged in to a services account (the
IRCv3 `account-tag`, offered by Libera.Chat and most modern networks), Switch
knows them by that account, whatever nick they use. Otherwise it knows them by
their nick, and such a nick **cannot be linked** to a Switch user: anyone can
take a nick once it is free. Log in to your account on the network before
using `!link-account`.

## What IRC can't do

IRC is plain text in channels, so these are switched off, and Switch falls
back as described:

- **Threads:** none. A reply lands in the channel, not under the message.
- **Edits and deletes:** none either way. A line once sent stays as it was,
  and an edit on the IRC side does not exist.
- **Attachments:** none. A file an agent sends is named in the channel instead
  of uploaded.
- **Cards and buttons:** approval and question cards arrive as text; answer
  them in Switch Console, or by typing the answer the card asks for.
- **Typing and reactions:** the bot shows no "working" status.
- **Channel creation and directory search:** the bot joins only the channels
  in its connection, and cannot look people up or bring them into a channel.

## Several switch-core pods

Only the pod holding the bridge keeps the IRC connection. Another pod asked to
post a line hands it to that pod. If the connection drops, the bot signs in
again with growing pauses; IRC does not keep messages for a client that was
away, so what was said while it was disconnected does not reach Switch.

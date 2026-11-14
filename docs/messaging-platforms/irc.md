# IRC

Connect Switch to an IRC network through a bot. Switch dials out to the
network over TLS and logs the bot in to its account, so the network never has
to reach Switch: no webhook, public address or tunnel is needed.

Tested with Ergo 2.19. Any network that speaks RFC 2812 works. Logging in
needs SASL PLAIN or NickServ, and reading back missed messages needs the IRCv3
`draft/chathistory` and `draft/read-marker` capabilities (see
[Running Switch on several pods](#running-switch-on-several-pods)).

## How it works

- **One bot speaks for every agent.** IRC has no way to send under another
  name, so each line starts with the agent's name, for example
  `<coder> The build is green.` Notices from Switch itself have no name.
- **Rooms.** Each channel the bot is in becomes a Switch room, and so does a
  conversation someone starts with the bot directly.
- **Talking to agents.** Address an agent with `@`, for example
  `@coder is the build green?`, as on any other platform. Addressing the bot
  by its nick (`switch-bot: …`) counts as mentioning the bot.
- **Formatting.** Bold, italics and strike-through become IRC's formatting
  codes, and a link keeps its address in the text. Code is sent as written: a
  code block loses its ``` fences, and each of its lines keeps its indentation.
  Asterisks in globs and paths, such as `src/**/*.py` or `*.md`, are left as
  written.
- **Long replies.** IRC limits a message to one line of 512 bytes, including
  the bot's own address that the network adds. A longer reply is sent as
  several lines, in order. Prose is wrapped at a space; a code line is never
  re-flowed, and is cut only when it alone is longer than a line. Multi-byte
  characters are never cut in half.
- **Flood limits.** The bot sends five lines at once, then one a second, which
  keeps it inside the flood limits of common networks. A 30-line reply takes
  about 25 seconds to arrive.
- **Approvals and questions.** A request is posted as text with its handle,
  for example `A7`. Answer it by typing the handle and your choice, as the
  card says, for example `A7 1`. Once it is settled, the outcome is posted
  below it.
- **Problems.** When a turn needs someone to act, for example because the
  agent went offline, that is posted as a line of its own.

## 1. Create the bot's account

Pick a nick for the bot, for example `switch-bot`, and register it with the
network's services. On most networks:

1. Connect with any IRC client using the bot's nick.
2. Send `/msg NickServ REGISTER <password> <email>`, and confirm the email if
   the network asks you to.
3. On Ergo, also send `/msg NickServ SET always-on true`. Ergo keeps an
   account's read markers across connections only for an always-on client,
   and Switch reads back what it missed from those markers.
4. Disconnect.

The bot can also run without an account. People then see it under its nick
only, and the nick is not protected: anyone can take it while the bot is
offline.

## 2. Connect it in Switch Console

Open **Connect a messaging app**, choose **IRC** and fill in:

| Field | What it is |
|---|---|
| Server | The network's server hostname, for example `irc.example.net`. No scheme and no port. |
| Port | `6697` for TLS on most networks. |
| Use TLS | Leave it on. Turn it off only for a server on your own network that has no TLS. Without TLS the bot cannot log in, because its password would cross the network unencrypted. |
| Verify TLS certificate | Leave it on. Turn it off only for a server with a self-signed certificate you trust. |
| Nick | The bot's nick. |
| Account name | The services account to log in to. Leave it blank when it is the bot's nick. |
| Account password | The account's password. Leave it blank for a bot without an account. |
| Channels | Channels the bot joins, separated by commas, for example `#ops, #deploys`. |

Switch connects and logs the bot in before saving. It tells you if the network
refuses the nick or the password, if the certificate cannot be verified, or if
the server cannot be reached.

Switch logs in with SASL PLAIN where the network offers it, and otherwise by
sending `IDENTIFY` to NickServ and waiting for the network to confirm the
login. That sends the password to whoever is called NickServ, so on a network
without SASL, give the bot a password only if the network runs services.

Switch connects to the server from inside your network. If that is a private
address, such as `localhost` in development, it must be listed in
`OUTBOUND_ALLOWED_PRIVATE_HOSTS`.

If the nick is taken when the bot connects (for example, by a connection that
has not timed out yet), the bot registers as the nick with up to three
underscores added. It asks for its nick back each time the server pings it,
and so gets it back within a few minutes of it being free.

## 3. Rooms and channels

- **Channels in the connection's list** are joined on every connect. Each one
  gets a room as soon as the bot is in it.
- **Binding a room to a channel** that already exists makes the bot join it
  straight away, whichever pod the request reached. Give the channel's name in
  lower case, for example `#deploys`.
- **Rooms Switch creates** get a new channel named after the room, with a short
  suffix so it never walks into a channel someone else uses, for example
  `#release-train-3f9a`. The bot creates it by joining it, and sets the room's
  description as the topic. A private room's channel is secret (`+s`) and
  invite-only (`+i`). The bot changes a channel's modes and topic only when it
  is the one that created it; a channel that already existed is left as it is.
- **Adding someone to a room** sends them an IRC invitation. It reaches them
  only while they are online under that nick; they join from their client.
  Someone not logged in to an account is invited by the nick they last used.
- **Deleting a room** makes the bot leave its channel. A conversation with one
  person is left as it is.

## Commands

Type in-room commands with `!` followed by the command's name, for example
`!invite-agent @coder`. A message that starts with `!` but not with a word,
such as `!!!` or `! look`, is an ordinary message. To link
your IRC account to Switch, log in to your network account first: Switch
links only people who are logged in, since anyone can use a nick that is not.

## What IRC cannot do here

- **Threads.** IRC has none. Every message goes to the channel.
- **Edits and deletions.** IRC cannot change or take back a message. An agent's
  edit is not shown, and Switch logs that it was not. A request's card is not
  redrawn: its outcome is posted once it is settled.
- **Progress of a turn.** On other platforms this is one message that is
  redrawn at every step. IRC cannot redraw a line, and posting each step would
  flood the channel, so it is not shown. The agent's reply still arrives as a
  message.
- **Reactions and typing.** IRC has neither, so the working indicator is not
  shown.
- **Attachments.** IRC has no file sharing. A file an agent sends is replaced
  by a line naming it.
- **User search.** The network can say who is online, not who exists, so
  Switch lists only people who have written in a channel the bot is in.
- **Deep links.** IRC has no web address for a channel.

## Running Switch on several pods

Only the pod holding the bridge connects to the network: a second connection
would be a second user wanting the same nick. The other pods hand anything
that needs the connection to the holder, which does it: sending a message,
joining a channel, creating one, inviting someone and leaving a channel. The
holder keeps a message it cannot send yet, because it is reconnecting, and
sends it once it is connected. One it was still keeping when it stopped is
lost, and logged as an error.

After relaying a channel message, Switch moves the bot's read marker in that
channel (`draft/read-marker`). The marker is kept by the network, so whichever
pod holds the bridge next reads back from the same point. Every time the bot
joins a channel, Switch asks the network for what was said since the marker
(`draft/chathistory`):

- Messages sent while Switch was restarting, or while the bridge moved between
  pods, are relayed once Switch is back.
- A message Switch could not take keeps the channel's marker before it. While
  the connection stays up, Switch reads the channel back from the marker after
  5 seconds, 30 seconds, 2 minutes and then every 5 minutes until the message
  is taken; a reconnect reads it back too.
- A message relayed twice is recognised by the network's message ID and
  dropped.
- Switch reads back at most the last 24 hours, and logs a warning when the
  marker is older than that.
- A channel the bot has never read is not read back. Direct messages are not
  read back.

If the connection drops while a long reply is being sent, the lines already
sent stay and are not sent again; once the bot is connected again it says that
the rest of the message did not arrive. A connection that drops right after the
network welcomes the bot (a ban, a flood limit) is dialled again less and less
often, up to once a minute.

On a network without these capabilities, anything said while no pod was
connected is not relayed. Switch logs a warning each time it connects to such
a network. Ergo has both, and keeps the marker across connections for an
always-on account (step 1); for one that is not, every reconnect starts from
no marker, so nothing is read back.

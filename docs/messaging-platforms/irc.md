# Connect IRC

_Put your Switch agents in IRC channels on any network, with one bot_

IRC is one of the newer platforms a server offers only with the
`additional_messaging_platforms` feature flag on (`FEATURE_FLAGS_ENABLED`, or
`featureFlags.enabled` in the Helm chart). With it off, IRC is missing from
Switch Console's list of messaging apps.

IRC is still home to many open source projects. Switch connects to your
network as one bot: you give it a server, a nick and, if the nick is
registered, its services account. Every agent on your Switch server speaks
through that bot, with the agent's name at the start of each line:

```
<switchbot> <coder> The tests pass now. I changed two files.
```

Switch connects outwards to the network over TLS, so **nothing on your Switch
server needs to be publicly reachable**.

Each channel the bot is in is a room. A private conversation with the bot is
a direct room.

## Before you begin

- **A network and a nick for the bot**, such as `switchbot` on Libera.Chat,
  OFTC or a server you run.
- **A services account for that nick (recommended).** Register the nick with
  the network's services, so nobody else can take it and so the bot can log
  in. On most networks, connect with your own client as the bot's nick and
  send:

  ```
  /msg NickServ REGISTER <password> <email>
  ```

  Follow the network's own instructions to confirm it. Switch logs in with
  SASL where the network offers it, and with NickServ `IDENTIFY` where it
  does not.
- **An admin account on the Switch server** you're connecting.

### On Ergo: keep the bot always on

If your network runs [Ergo](https://ergo.chat), turn on *always-on* for the
bot's account, so the network keeps the bot's read markers while it is
offline:

```
/msg NickServ SET always-on true
```

That is what lets Switch read back what was said while it was restarting
(see [Missed messages](#missed-messages)).

## Connect IRC to your Switch server

1. In Switch Console, open the server's **Home** page. **Messaging apps** lists
   what's connected.
2. Select **Connect**, then choose **IRC** under **Messaging app**.
3. Fill in the form:

| Field | What to enter |
|---|---|
| **Server** | The network's server name alone, such as `irc.libera.chat`. |
| **Port** | `6697` for TLS on most networks; `6667` without. |
| **Use TLS** | Leave on. Switch refuses a password without TLS, so it never crosses the network in clear text. |
| **Check the server's certificate** | Leave on. Turn off only for a server you run yourself with a self-signed certificate. |
| **Nick** | The bot's nick. |
| **Services account** and **Services password** | The account the nick logs in to, and its password. Leave both empty for a bot without one. |
| **Channels** | Channels to join, separated by commas, such as `#project, #ops`. Each becomes a room. |
| **Join when invited** | Join a channel when someone invites the bot with `/invite`. On by default. |

4. Select **Connect**. Switch connects, logs in and leaves again before
   saving, so a wrong password, a nick in use, a certificate it cannot
   verify or a server it cannot reach is reported here, in the network's own
   words.

## Add the bot to a channel

Any of these works:

- List the channel under **Channels** on the connection.
- Invite the bot from the channel: `/invite switchbot`.
- Create a room in Switch Console on this connection. Switch joins a fresh
  channel named after the room, such as `#release-train-3f9a`, so it never
  takes over a channel somebody else uses. For a private room the channel is
  made secret and invite-only (`+si`), and the people you add are invited.

## Talk to your agents

- **Address an agent** with `@coder` anywhere in a line. Messages that address
  no agent still reach the room.
- **Commands** start with `!`, for example `!invite-agent coder` or
  `!link-account`.
- **Address the bot itself** the IRC way, `switchbot: …`, or as
  `@switchbot`; Switch then helps you pick an agent.
- **Approvals and questions** are posted as text with a short handle and
  numbered options. Answer by typing the handle and your choice:

  ```
  A7 1
  ```

  IRC cannot change a line once it is sent, so the card is said again once,
  when it is answered, naming how it was settled.

### Link your IRC account

Answering a card needs a known person, so link your IRC account to your Switch
account. Switch can link only a sender who is logged in to the network's
services (Switch sees the account through IRCv3 `account-tag`): anyone can use
a nick that is not logged in. Log in with your own services account before
you link, and stay logged in when you answer cards.

## Missed messages

Where the network supports read markers and history (IRCv3
`draft/read-marker` and `draft/chathistory`, as Ergo does), Switch moves the
channel's read marker as it relays each message. After a restart, or when
another Switch process takes over the connection, it reads back from that
marker, so nothing said while it was away is lost or relayed twice. Read-back
reaches back at most 24 hours.

On a network without them, what is said while no Switch process is connected
is not relayed, and Switch logs that on every connect.

## Running several Switch processes

Only the process holding the connection is connected to the network; a second
connection would be a second user with the same nick. The others hand it what
needs the connection: messages, cards, joining and leaving channels, invites.

## What IRC can't do

| Feature | On IRC |
|---|---|
| Threads | IRC has none. Replies go to the channel, in order. |
| Edits and deletes | IRC cannot change or take back a line. An agent's edit is not mirrored; a card is said again once it is answered. |
| Reactions and typing | None. The agent's reply is the sign it has finished; a problem someone has to act on is said once, in its own message. |
| Attachments | IRC has no file sharing. A file an agent sends is named in the channel instead. |
| Formatting | Bold, italic, strikethrough and monospace use IRC's formatting codes; links are written out as `text (url)`. Code blocks keep their indentation. |
| Long replies | Split into lines that fit IRC's 512-byte limit, at word boundaries, and sent at a pace the network's flood protection accepts. |
| Directory search | The network can say who is online, not who exists. |
| Channel deletion | A channel ends when its last member leaves. Deleting a room makes the bot leave its channel. |
| `switchdash://` links | IRC clients open http(s) links only. Set `GATEWAY_PUBLIC_URL` on the server so Switch rewrites them. |

A line written at the very moment a connection drops can be lost: IRC does not
acknowledge what it receives. Lines still queued when a connection drops are
sent on the next one.

## Troubleshooting

| Message | What to do |
|---|---|
| *SASL authentication failed* or *NickServ refused the login* | Check the services account and password. |
| *The nick … and its fallbacks are in use* | Another client holds the nick. Register it with services so the network can free it for the bot. |
| *The certificate of … could not be verified* | The server's TLS certificate is not trusted. Fix it on the server, or, for a server you run yourself, turn off **Check the server's certificate**. |
| *Could not reach …* | Check the server name and port, and that the Switch server can make outbound connections to it. |

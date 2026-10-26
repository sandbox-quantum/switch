# IRC

Bridge Switch rooms to channels on any IRC network — Libera.Chat, OFTC, or a
server of your own. The bridge connects as one nickname, joins the channels its
rooms are bound to, and every agent speaks through that nickname with its name
at the start of each line:

```
<switch-bot> deployer: Rolled out api v2.14 to staging.
<switch-bot> reviewer: Two comments on the migration, see the room.
```

## What to set up on the network

1. **Pick a nickname** for the bridge, e.g. `acme-switch`. On networks with
   services (Libera.Chat, OFTC) register it so nobody else can take it:
   connect with any client as that nick and run
   `/msg NickServ REGISTER <password> <email>`, then confirm the email.
2. **Create or choose channels.** Channels the bridge creates for new rooms are
   named after the room (`#release-planning`). For an existing channel, invite
   the bridge (`/invite acme-switch #ops`) once it is connected, or list the
   channel under *Channels*.
3. If the channels need a registered nick to join (`+r`) or you want
   operator rights for the bridge, give its account access with ChanServ as you
   would for any user.

No special permissions are needed: the bridge is an ordinary IRC client.

## Connection fields

| Field | Meaning |
|---|---|
| **Server** | The server's hostname alone, e.g. `irc.libera.chat`. |
| **Port** | `6697` (TLS, the default) or `6667` (plain text). |
| **TLS** | Connect with TLS. Leave on; passwords are refused without it. |
| **Verify TLS** | Check the server's certificate. Turn off only for a private server with a self-signed certificate you trust. |
| **Nickname** | The bridge's nickname. If it is taken, the bridge tries it with `_` appended. |
| **Channels** | Channels to join and bridge as soon as the bridge connects, separated by commas: `#ops, #deploys`. Each becomes a room. |
| **SASL username / password** | The services account to log in with (SASL PLAIN). Recommended on public networks: it protects the nickname and lets the bridge join `+r` channels. |
| **Server password** | Only for a private server that asks for a connection password (`PASS`). |

Registering the bridge connects once to check these: a wrong SASL password,
a ban or an unreachable server is reported then, in the server's words.

## Talking to agents

- `@agent do the thing` or the IRC way, `agent: do the thing`.
- `!command args` runs a Switch command, e.g. `!agents`.
- A private message to the bridge's nickname opens a direct room with it.
- `/me` actions are relayed as italics.

Formatting is translated both ways: **bold** and *italics* become IRC's bold
and italic codes, links become `text (url)`, and code blocks are sent as plain
lines. Long messages are split into lines that fit IRC's 512-byte limit, at
word boundaries, and paced (a short burst, then about one line every two
seconds) so the network's flood protection does not disconnect the bridge.

## Who sent a message

IRC nicknames are not accounts: while someone is offline, anyone can use their
nick. When the network tags messages with the sender's services account
(IRCv3 `account-tag`, offered by Libera.Chat, OFTC and most modern servers),
Switch identifies people by that account. Otherwise it falls back to the
nickname, so on such a server keep rooms that can approve agent requests in
channels limited to registered users (`+R`/`+r` or an invite list).

## What IRC cannot do

- **No edits or deletions.** A line sent on IRC is final, so a message an agent
  edits or deletes in Switch keeps its first version in the channel.
- **No buttons.** Requests for approval arrive as text and are answered by
  typing, as the message explains.
- **No threads, reactions, files or avatars.** Replies arrive in the channel;
  attachments are not relayed.
- **No message history.** The bridge sees what is said while it is connected.
- **Typing indicators** only where the server supports IRCv3 message tags.
- **Searching the network's users** is not available: invite people by nick.
- One nickname per server: two bridges cannot share a nick, and Switch refuses
  the second at registration.

Under several Switch processes, only the one holding the bridge connects to
the network; the others pass their messages to it.

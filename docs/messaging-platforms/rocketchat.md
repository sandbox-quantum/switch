# Rocket.Chat

Connects Switch to your own Rocket.Chat server through one bot user. Tested on
Rocket.Chat 8.9.

The bot speaks for every agent: each message shows the agent's name and icon.
Switch keeps a connection open to your server, so nothing has to reach Switch
from outside and you need no public address or tunnel.

## Create the bot

You need an administrator on the Rocket.Chat server. The steps below use the
web client.

1. Go to **Administration → Users → New user**. Give it a username such as
   `switchbot`, a name, an email, and a password. Under **Roles**, keep only
   `bot`. Tick **Verified** on the email so the account can sign in.
2. Go to **Administration → Permissions** and add the `bot` role to these
   two permissions. Neither is on it by default.
   - **Create Personal Access Tokens**, so the bot can make its token in step 3.
     You can take it off again afterwards.
   - **Delete Own Message**, so that an agent deleting its message works. Without
     it the connection in Switch Console shows a notice, and the agent's messages
     stay in the channel.
3. Sign in to Rocket.Chat as the bot, in a private window. If the server sends a
   sign-in code by email, you need access to the address from step 1.
4. Open **Profile → Personal Access Tokens**, name a token and tick **Ignore Two
   Factor Authentication**. Rocket.Chat shows the token and the bot's user ID
   once. Copy both, then sign out.

Add the bot to any channel you want connected, as you would add a person.

## Connect it in Switch Console

Open **Connect a messaging app**, choose **Rocket.Chat** and fill in:

| Field | What it is |
|---|---|
| Server URL | The address of your server, such as `https://chat.example.com`. If Rocket.Chat is served under a path, include the path. |
| Bot user ID | The user ID shown with the token. |
| Personal access token | The token. Replace it here if it ever changes, without disconnecting. |
| Public URL | Optional. The address people open Rocket.Chat at, when that is not the server URL. Links to channels use it. |
| Verify TLS certificate | Leave on. Turn off only for a self-signed certificate you trust. |

Switch checks the token before saving, and refuses an account that may not post
under another name (the `message-impersonate` permission, which the `bot` role
has).

A server on a private address needs that address in
`OUTBOUND_ALLOWED_PRIVATE_HOSTS` on your Switch deployment.

Links to Switch Console need `GATEWAY_PUBLIC_URL` set, because Rocket.Chat only
opens http(s) links.

## Using it

- **Channels and private groups** become rooms as soon as the bot is added.
- **Direct messages** with the bot become rooms when someone writes.
- **Threads** stay threads on both sides.
- **Address an agent** by typing `@name`, its name in Switch. Agents have no
  Rocket.Chat accounts, so the name does not autocomplete.
- **Commands** such as `!help` work in any room the bot is in. The answer arrives
  in a thread under the command.
- **Approvals and questions** appear as cards with buttons. A button posts the
  card's answer, such as `R42 1`, as whoever pressed it, so it stays visible in
  the channel. You can also type that yourself. Anyone in a room can post a
  message with buttons of their own, so press only the buttons on a card from an
  agent.
- **Rooms Switch creates** are owned by the bot, which can invite people to them
  and archive them. Deleting such a room in Switch archives the channel. In a
  room somebody else created, the bot can do neither: an owner has to.
- **Files** go both ways. A file over the limit on either side is reported in the
  channel rather than dropped. A file is relayed only if it was uploaded in the
  room it was posted in.
- While an agent works, its message carries 👀, or ⏳ while it is queued.

When Switch restarts, it reads back what was said in connected rooms while it
was away, from the bot's read position on each room. So don't use the bot's
account in a client: reading a channel there moves that position. The position
stays on the last message Switch received, so the bot's rooms always show as
unread. A restart reads the last two seconds before that position again, which
can repeat a notice about a blocked message but posts nothing twice. The one
message that can be missed is one delivered more than two seconds after a newer
message in its room, just as the connection is lost.

## What doesn't work

- **`/` commands.** Registering one takes a server-side Rocket.Chat app, which a
  bot user cannot do. Use the `!` form, such as `!invite-agent`.
- **Edits and deletions made in Rocket.Chat** do not reach the room. An agent's
  own edits and deletions do reach Rocket.Chat. A message someone else changed
  while Switch was away is not read back, so it is not relayed under its
  author's name.
- **`@all` and `@here` from an agent.** The `bot` role is not allowed to use them,
  so they are written as plain text and notify nobody. The agent is told so.
- **Stop and activity buttons** on an agent's status message. A bot is not told
  about a press, so only buttons that post text are possible.
- **Several files in one message.** Each file arrives as its own message.
- **End-to-end encrypted rooms.** The bot cannot read them, and Switch logs a
  warning.
- **Rooms with very long gaps.** At most the latest 500 messages per room are read
  back after an outage, and Switch logs a warning when it leaves any out.
- **Separate accounts for agents.** All agents share the bot's account, so they
  share its reactions.
- **Very large directories.** Searching for a person in Switch Console looks at the
  first 2000 users.

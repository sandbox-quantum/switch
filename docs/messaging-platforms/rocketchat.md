# Rocket.Chat

Connect Switch to your own Rocket.Chat server through a bot user. Switch
listens on Rocket.Chat's realtime WebSocket and acts through its REST API, so
your server never has to reach Switch: no webhook, public address or tunnel is
needed.

Tested with Rocket.Chat 8.9. Any 8.x server should work. 7.x servers are not
supported, because they predate the upload API Switch uses.

## How it works

- **One bot speaks for every agent.** Each message carries the agent's name and
  icon in place of the bot's, so agents read as themselves while sharing one
  account.
- **Rooms.** Public channels, private channels and direct messages with the bot
  each become a Switch room. Threads stay threads on both sides.
- **Formatting.** Replies keep their formatting. A reply longer than a
  Rocket.Chat message is split into several messages, in order and in the same
  thread, and a code block is never cut in half.
- **Working indicator.** While an agent works on a message it reacts with 👀,
  or ⏳ while the message is queued behind other work.
- **Approvals and questions.** Requests are posted as text. Answer one by
  replying in its thread, for example `approve`, or with its handle when you
  answer from elsewhere.
- **Files** go both ways. A file larger than Switch's limit, or larger than your
  server's upload limit, is refused with a message in the room saying so.

## 1. Create the bot user

As a Rocket.Chat administrator:

1. Go to **Administration → Workspace → Users → New user**. Give it a name and a
   username (for example `switch`), an email address and a password. Under
   **Roles**, choose **bot** and remove **user**. Leave **Join default channels**
   off.
2. Go to **Administration → Workspace → Permissions** and give the **bot** role
   these two permissions, which it lacks by default:
   - **Create Personal Access Tokens** (`create-personal-access-tokens`), so the
     bot can have a token.
   - **Delete Own Message** (`delete-own-message`), so Switch can take back
     a message it posted.

   The bot role already has everything else Switch uses:
   - **message-impersonate**: post under each agent's name and icon.
   - **create-c** and **create-p**: create channels.
   - **create-d**: open direct messages.

   If an administrator has removed **message-impersonate**, messages still
   arrive, but with the agent's name written at the start of the text. Switch
   logs a warning when this happens.

## 2. Create its personal access token

1. Sign in to Rocket.Chat as the bot.
2. Open **Avatar → Preferences → Personal Access Tokens**.
3. Add a token named `switch`. If your server enforces two-factor
   authentication, tick **Ignore Two Factor Authentication**: Switch cannot
   answer a second factor.
4. Rocket.Chat shows the **token** and the bot's **user ID** once. Copy both.

A personal access token does not expire. To revoke it, remove it on the same
page, then put a new one into Switch.

## 3. Connect it in Switch Console

Open **Connect a messaging app**, choose **Rocket.Chat** and fill in:

| Field | What it is |
|---|---|
| Server URL | The address of your Rocket.Chat server as you open it in a browser, for example `https://chat.example.com`. Include the path if Rocket.Chat is served under one. |
| Bot user ID | The user ID shown beside the token. |
| Personal access token | The token itself. |
| Verify TLS certificate | Leave it on. Turn it off only for a server with a self-signed certificate you trust. |

Switch checks the token before saving it. It tells you if Rocket.Chat rejects
the token, if the account is not a bot, if the account is deactivated, or if
the server cannot be reached.

Switch connects to the server URL from inside your network. If that is a
private address, such as `localhost` in development or a host on your
intranet, it must be listed in `OUTBOUND_ALLOWED_PRIVATE_HOSTS`.

## 4. Add the bot to rooms

- **To bridge an existing room,** add the bot to it in Rocket.Chat. Switch
  creates its room straight away.
- **To bring someone into a room,** add them on either side. A person added in
  Rocket.Chat joins the Switch room too.
- **Direct messages:** a direct message with the bot becomes a room the first
  time someone writes in it.
- **Rooms Switch creates** are created by the bot. Switch can invite people to
  those rooms and archive them when the Switch room is deleted. For a room
  someone else created, the bot can do neither unless it is made an owner or
  moderator of that room.

## Commands

Type in-room commands with `!`, for example `!invite-agent @coder`.

## What Rocket.Chat cannot do here

- **Slash commands.** A custom slash command can only be registered by an app
  installed on the server, not by a bot user. Use the `!` form instead.
- **Buttons on approval cards.** When someone presses a message button, it is
  posted as their own message, and only a server app is told about the press.
  Answer a card by replying in its thread instead.
- **Typing indicator.** Rocket.Chat has no API call for it, so the 👀 reaction
  is shown instead.
- **Edits and deletions made in Rocket.Chat.** These are not mirrored into
  Switch, because Switch has no event for either yet. Editing a message after
  it was relayed does not change what agents saw.
- **Agents' own accounts.** Agents share the bot account. A file an agent sends
  is posted by the bot, with the agent's name in the caption.

## Running Switch on several pods

Only the pod holding the bridge keeps the WebSocket open. Every other pod still
sends, edits and creates rooms through the REST API.

After relaying a message, Switch marks the room read for the bot. That read
marker is kept by Rocket.Chat, so whichever pod takes the bridge next reads
back from the same point. On every reconnect, Switch relays what was said in
the bot's rooms since each room was last read:

- Messages sent while Switch was restarting, or while the bridge moved between
  pods, are relayed once Switch is back.
- A message edited during that gap arrives with its latest text.
- A message Switch could not take keeps its room unread from that point, and
  is read back on the next reconnect.
- A message that would be relayed twice is recognised by its Rocket.Chat ID and
  dropped.

Switch reads back at most the last 24 hours. A room the bot sat in for longer
than that before the bridge was connected is not replayed in full, and
neither is anything said during an outage longer than a day. Switch logs a
warning when a room has unread messages older than that. Archived rooms are
not read back.

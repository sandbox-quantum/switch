# Rocket.Chat

Connect Switch to your own Rocket.Chat server with a bot user. Switch listens
over Rocket.Chat's realtime (WebSocket) API and answers over its REST API, so
the server needs no inbound address and no public exposure. Switch only has to
reach the server.

Switch needs a Rocket.Chat server it can open an https (or http) connection to.
The adapter has been written against the documented REST and realtime APIs;
state the server release you tested on when you report a problem.

## Create the bot

1. **Create a user for the bot.** In **Administration > Users > New**, give it a
   name such as `switch-bot`, tick **Verified**, untick **Require password
   change**, and give it the **bot** role (plus **user**). The bot role is what
   lets one account post under each agent's name and picture; without it,
   Rocket.Chat refuses the post with a message naming the missing permission.
2. **Make a personal access token for it.** Sign in as the bot, open
   **My Account > Personal Access Tokens**, give the token a name and tick
   **Ignore Two Factor Authentication** (a bot cannot answer a second factor).
   Rocket.Chat shows the **Token** and the **User Id** once. Copy both.
3. **Add the bot to channels.** Switch hears only the rooms the bot is a member
   of. Invite it with `/invite @switch-bot`, or from the channel's member list.
   When the bot is added to a channel, Switch creates the room for it.

## Connection fields

| Field | What to enter |
|---|---|
| `url` | The server's address, for example `https://chat.example.com`. This is where Switch connects, so it may be an internal address. |
| `user_id` | The **User Id** shown with the token. |
| `auth_token` | The personal access token. Stored masked. |
| `public_url` | Optional. The address people open Rocket.Chat at, when it differs from `url`. Used for links only. |
| `default_member` | Optional. A username to add to every channel Switch creates, so a channel an agent creates is not readable by the bot alone. |
| `verify_tls` | Leave on. Turn off only for a self-signed certificate on a server you trust. |

Switch checks the credentials when you save them. A wrong user id, a wrong
token, or a token that belongs to a different user is refused with a message
saying which.

### Permissions the bot needs

The **bot** role covers these on a default server. If you use a custom role,
grant:

| Permission | Why |
|---|---|
| `create-c`, `create-p` | Create public and private channels for rooms agents create. |
| `add-user-to-any-c-room`, `add-user-to-any-p-room` (or be owner of the room) | Add people to rooms Switch creates. |
| `view-outside-room` and `view-d-room` | Search the directory when a person links their account. |
| Whatever your server requires to override a post's alias and avatar (the **bot** role has it on a default server) | Post under each agent's name and picture. |

## How it behaves

- **Mention an agent** by typing `@agent-name` in the message. Agents are not
  Rocket.Chat users, so Rocket.Chat does not autocomplete them, but Switch reads
  the name from the text. Messages that mention nobody still reach the room.
- **Replies come back under the agent's name and picture**, posted by the bot
  account. This is a display override on each post, not a Rocket.Chat user per
  agent, so you cannot mention an agent from Rocket.Chat's own autocomplete or
  see agents in its member list.
- **Threads map to threads.** A reply in a Rocket.Chat thread stays in that
  thread in the room, and the agent's answer is posted into the same thread.
- **Edits and deletes** made by an agent in Switch are applied to the post in
  Rocket.Chat. An edit or delete a person makes in Rocket.Chat is not carried
  into Switch, as on the other platforms.
- **Attachments** work both ways. A file larger than Switch's attachment limit
  is not relayed, and the room is told so. A file an agent sends is uploaded
  with the agent's name in its caption, because Rocket.Chat uploads cannot
  carry an alias.
- **Formatting** is Markdown, which Rocket.Chat renders. A reply longer than
  4,000 characters is split on line breaks, and a code block cut by the split
  is closed and reopened so both halves render.
- **`!commands`** (`!interrupt`, `!link-account CODE` and the rest) work in any
  channel the bot is in, and in threads.
- **Working indicator.** While an agent works on a message, the bot reacts
  with an hourglass reaction; a message waiting its turn gets an eyes reaction. Both are removed when the agent
  finishes.
- **Channels.** An agent can create a public or private channel; the bot is its
  owner. Switch can add people to it, and any it cannot add are reported.

## What does not work

- **Approval and question cards.** Rocket.Chat has no buttons a bot can answer
  through this connection, so cards arrive as plain text and are answered by
  replying in the room (or from Switch Console).
- **Typing indicator.** Rocket.Chat offers it only as a realtime method call,
  which it is retiring. The hourglass reaction shows that the agent is working.
- **Slash commands such as `/invite-agent`.** Not registered; use `!commands`.
- **One account per agent.** See above: agents share the bot account.
- **Messages sent while Switch was down.** If the realtime connection drops
  while Switch is running, Switch replays what was said meanwhile when it
  reconnects. If the Switch process itself is stopped, messages posted during
  that time are not replayed.

## Running several Switch pods

Only the pod that holds the bridge opens the realtime connection. The others
keep the bridge ready to serve requests (sending, editing, creating channels)
but listen to nothing, so a message is never handled twice. Messages are
deduplicated by Rocket.Chat's own message id.

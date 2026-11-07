# Connect Matrix

Put your Switch agents in rooms on a Matrix homeserver you already use, with
Element or any other Matrix client.

Switch signs in to your homeserver as a **bot account that you create** and
reads and posts in the rooms that account is invited to. This page is about
that external homeserver only. It has nothing to do with Switch's own message
bus, which is PostgreSQL: Switch does not run a Matrix server, and the
`matrix_*` names you may see inside Switch are only kept identifiers.

Matrix reaches Switch over a connection Switch opens outwards (`/sync`), so
**nothing needs to be publicly reachable** from the internet.

## Before you begin

- **A Matrix homeserver** your Switch server can reach over HTTP(S): your own
  Synapse, Conduit, Tuwunel or Dendrite, or a hosted one such as matrix.org.
- **A new account on it for Switch to use as a bot.** Use an account of its
  own, not a person's, for the reason in
  [Do not use the bot account elsewhere](#do-not-use-the-bot-account-elsewhere).
- **An admin account on the Switch server** you are connecting to.

If the homeserver is on a private address (a tailnet host, `localhost` while
developing), the Switch server must allow it: list its host in
`OUTBOUND_ALLOWED_PRIVATE_HOSTS`. Link-local addresses are always refused.

## Create the bot account

1. Register a new account on your homeserver, for example
   `@switch-bot:example.org`. In Element: **Create account** on your
   homeserver (or ask its admin to create one), then sign in as it.
2. Give it a display name and, if you like, an avatar. This is what people see
   as the sender of the bot's invitations; each agent's own name is written at
   the head of its messages.
3. Get an access token for it. In Element, signed in as the bot:
   **Settings → Help & About → Advanced → Access Token → copy**. Or, from a
   terminal:

   ```bash
   curl -sS -X POST https://matrix.example.org/_matrix/client/v3/login \
     -H 'Content-Type: application/json' \
     -d '{"type":"m.login.password","identifier":{"type":"m.id.user","user":"switch-bot"},"password":"<password>","initial_device_display_name":"Switch"}'
   ```

   The answer holds an `access_token`. Treat it like a password.

Switch needs no admin rights on the homeserver and no special scopes. The bot
needs only what any member has: to join rooms it is invited to, to send
messages, to upload files, and to create rooms if you want agents to create
them.

## Connect it in Switch Console

1. Select the server in the sidebar switcher and open its **Home** page.
   **Messaging apps** lists what is connected.
2. Select **Connect**, then choose **Matrix** under **Messaging app**. If there
   is no **Connect** button you are signed in without admin rights.
3. **Name** the connection after the homeserver, "Acme Matrix".
4. Fill in the connection details:
   - **Homeserver URL**: the address Switch connects to, such as
     `https://matrix.example.org`. No user name, password, query or fragment.
   - **Bot user ID**: the bot's Matrix ID, such as `@switch-bot:example.org`.
   - **Bot access token**: the token from the previous step.
5. Select **Connect**. Switch asks the homeserver who the token belongs to
   before it saves anything, so a wrong token, a token for a different
   account than the ID you entered, or an unreachable homeserver is reported
   here, in words, and nothing is stored.

## Bring Switch into a room

In Element, open the room, **Invite** the bot's ID. Switch accepts the invite
and creates the room in Switch. Then add agents from inside the room:

```text
!invite-agent @agent-name
```

Matrix has no native slash commands for bots, so the `!` form is the one that
works, and it must be the first thing in the message. Element's own `/`
commands are handled by Element and never reach Switch.

To go the other way, create the room in Switch: Switch creates the Matrix room
with the bot, invites the people you chose and posts there. That applies to
rooms an agent creates too, unless you withheld channel creation from the
connection.

## How it behaves

- **Agents speak under their own name.** Every agent posts through the one bot
  account, so an agent's name is written in bold at the head of its message.
  Element shows the bot as the sender.
- **Mention an agent** by typing `@agent-name` in the message. Agents are not
  Matrix accounts, so Element will not offer them in its mention picker; the
  plain text is what Switch reads. Messages that mention no one still reach
  the Switch room.
- **Threads.** A Matrix thread is a Switch thread, both ways. A reply to a
  message that is not in a thread (Element's plain "Reply") is treated as a
  thread on the message it replies to.
- **Formatting.** Agents write Markdown and Matrix clients show it as rich text
  (bold, lists, code blocks, tables, links). Raw HTML is shown as text, images
  are not embedded and only `http`, `https` and `mailto` links are links.
- **Long replies** are split between lines into several messages, never in the
  middle of a code block.
- **Edits and deletes.** When Switch changes or deletes a message it posted,
  the Matrix message is edited (`m.replace`) or removed (redacted). What people
  do the other way is not mirrored: an edit to a message already relayed, or a
  deletion of it, does not change the Switch room.
- **Files.** Files in a room reach the agent, and agents can send files. A file
  bigger than the limit your Switch server allows is not relayed, and the room
  is told so. A file bigger than the homeserver's upload limit is not sent,
  and the room is told that too.
- **Working indicator.** While an agent works on your message, the bot puts 👀
  on it (⏳ if the agent has not started yet) and removes it when the turn
  ends. The bot also shows as typing.
- **Approvals and questions.** Matrix has no buttons a bot can put on a
  message, so an approval or a question is posted as text with numbered
  options. Answer by typing the option or its number in the room, as the
  message says.
- **People.** A person is addressed by the local part of their Matrix ID
  (`@alice:example.org` is `alice`). Someone on another server is addressed as
  `alice_other.org`, so two people called `alice` stay two people.

## Encrypted rooms

**End-to-end encrypted rooms are not supported.** Switch would need device keys
that survive restarts and are shared by every Switch process, and it does not
have them. So Switch refuses such a room, clearly:

- If the bot is **invited to an encrypted room**, it joins, posts a plain notice
  that encrypted rooms are not supported, and leaves. The room is not
  connected.
- If **encryption is turned on in a room that is connected**, the bot posts the
  same notice and leaves. The room stays in Switch with its history but no
  longer relays. Encryption cannot be turned off again in Matrix, so create a
  new room without encryption and invite the bot there.

Create rooms for Switch with **Enable end-to-end encryption** switched off.
Direct messages in Element are encrypted by default; turn that off when you
start one with the bot.

## Restarting and running more than one Switch pod

- Only one Switch process holds the connection and reads the homeserver. If it
  stops, another takes over.
- Where it stopped is remembered **on the homeserver**: after it has relayed a
  room's messages, the bot's own `m.fully_read` marker for that room is moved
  forward. A new holder reads the marker and relays only what came after it,
  including anything sent while Switch was down. If a restart repeats a
  message, Switch recognises it by its Matrix event ID and writes nothing
  twice.
- A room the bot has never read starts from when the bot joined it. History
  from before that is not imported.

### Do not use the bot account elsewhere

The marker lives in the bot's own account, so reading the bot's rooms in
Element as the bot moves it. Do not sign in as the bot in a client, and do not
sign the Switch session out: either can lose messages or end the token. Use a
person's account for talking to your agents.

## What does not work on Matrix

These are declared by the adapter, so Switch and Console know them without
asking:

| What | On Matrix |
|---|---|
| End-to-end encrypted rooms | Refused, with a notice (above) |
| Agents as separate accounts | No. One bot posts for every agent, under the agent's name in the text |
| Native slash commands | None. Use `!command` |
| Buttons on approvals and questions | None. Answer by typing |
| Mirroring edits and deletes made on Matrix | Not mirrored into Switch |
| Notifying a whole room (`@room`) | No. The bot has no room-wide mention |
| `switchdash://` links | Not clickable. Links to Switch Console pages are rewritten to https, which needs `GATEWAY_PUBLIC_URL` on the Switch server |
| Private notices to one person | None. They are posted in the room |
| Directory search | The homeserver's user directory, which by default lists only people who share a room with the bot or are in a public room |
| The same bot account in two connections | Refused: one account is connected once on a Switch instance |

## Confirm it worked

- The connection is listed under **Messaging apps** with no error beside it.
- The room appears under **Your Rooms** in Switch Console after you invite the
  bot.
- A message with `@agent-name` in the room gets a reply headed by the agent's
  name.

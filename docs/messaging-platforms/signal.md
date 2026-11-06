# Signal

Signal has no bot API, so Switch connects to Signal through
[signal-cli](https://github.com/AsamK/signal-cli), an unofficial command-line
Signal client that you run next to Switch. signal-cli holds the Signal
account and its keys. Switch only talks to signal-cli's HTTP daemon: it sends
through the daemon's JSON-RPC endpoint and reads incoming messages from its
event stream. Switch never sees the account's keys.

## How conversations map to rooms

- **A direct chat with the account is a room.** When an allowed person
  messages the account, Switch makes a room for that chat. The agent named in
  **Agent that answers** joins the room and replies in the same chat.
- **A Signal group is a room.** Add the account to a group on Signal. The
  first message from an allowed person in the group creates the room.
- **Every agent posts as the one account.** Each reply starts with the agent's
  name in bold, for example **claude:** Done.
- **Replies are threads.** Signal has no threads. A message that quotes an
  earlier message counts as a reply in that message's thread. When an agent
  answers in a thread, its reply quotes the thread's first message.
- **Only people on the allow-list reach Switch.** Signal messages from anyone
  else are ignored. Unlike a Slack workspace, anyone who knows the number can
  write to it, so the allow-list is required.

## Before you begin

You need:

- Java 21 or later and signal-cli, on the machine that runs Switch or on a
  machine Switch can reach over a private network. On macOS, run
  `brew install signal-cli`. For other systems, see
  [signal-cli's install guide](https://github.com/AsamK/signal-cli#installation).
- A Signal account for signal-cli. You can use either of these:
  - **A number of its own (recommended).** Register a second number with
    `signal-cli -a +15551234567 register`, then
    `signal-cli -a +15551234567 verify <code>`. People then message that
    number to reach the agents.
  - **Your own account, linked as a second device.** Run
    `signal-cli link -n Switch`. It prints a `sgnl://linkdevice?...` address.
    Turn that address into a QR code (for example with `qrencode -t ansi`),
    then scan it on your phone in **Settings → Linked devices → Link new
    device**. No new number is needed. Read
    [Using your own account](#using-your-own-account) before you choose this
    option.

## Start the daemon

Start the daemon without `-a`, so that it serves every account it knows:

```bash
signal-cli daemon --http 127.0.0.1:8080
```

**The daemon has no login.** Anyone who can reach its port can read and send
messages as the account. Keep it on `127.0.0.1` or on a private network. Never
expose it to the internet. If Switch runs in Docker and signal-cli runs on the
host, `http://host.docker.internal:8080` is usually the address that reaches
it.

Leave the daemon running for as long as the bridge is connected. If the
daemon stops, Switch tries to reconnect. Messages delivered while Switch is not
connected to the daemon may not reach Switch.

## Create the connection

In Switch Console, open **Connect a messaging app** and choose **Signal**.

| Field | What to enter |
|---|---|
| **signal-cli daemon address** | Where the daemon listens, for example `http://localhost:8080`. Enter only the address, without `/api/v1/...` after it. |
| **Signal account** | The number signal-cli is registered or linked as, in E.164 form, for example `+15551234567`. |
| **Allowed people** | The phone numbers (E.164) or Signal account IDs of the people whose messages should reach Switch, separated by commas. |
| **Agent that answers** | The agent added to each new conversation. Leave it empty to add agents yourself with `!invite-agent`. |

When you connect, Switch checks that a signal-cli daemon answers at that
address and that it serves the account. If the check fails, the error says
what to fix.

## Using your own account

If signal-cli is linked to your own Signal account, every chat on your phone
also reaches signal-cli. Switch handles those chats like this:

- A message **someone else sends you** reaches Switch only if the sender is
  on the allow-list.
- A message **you write** reaches Switch only if you sent it to **Note to
  Self**, or to a direct chat with someone on the allow-list. To talk to agents
  from your phone, add your own number to the allow-list and write in Note to
  Self. Agents answer there.
- Messages you write in groups, and messages you send to anyone not on the
  allow-list, never reach Switch.

Replies come from your own account, so the people you chat with see them as
messages from you.

## What Signal can't do

- **No rooms created from Switch.** Signal has no way for the account to start
  a conversation with people it doesn't know. Message the account, or add it
  to a group, and the room appears.
- **No directory.** Switch can't search for Signal users or add them to a
  room. Add people to groups on Signal.
- **One identity for every agent.** Agents share the account's name and
  picture. Their name is written at the start of each reply.
- **Plain formatting.** Bold, italic, strikethrough and monospace are shown as
  Signal text styles. Headings are shown as plain text, and links are written
  out with their address. Long replies are split into several messages of up
  to 2,000 characters each.
- **No buttons.** Approval and question cards appear as text. Answer them by
  replying in the chat.
- **Edits and deletes go one way.** An agent can edit or delete its own
  messages (Signal allows edits for up to 24 hours). Edits and deletes made on
  Signal are not reflected in the room.

## Risks of an unofficial client

signal-cli is not made by Signal. Keep it up to date: an old version can stop
working when Signal changes its servers. Signal can rate-limit or block
accounts that send a lot of automated messages, so avoid using a number that
you can't afford to lose.

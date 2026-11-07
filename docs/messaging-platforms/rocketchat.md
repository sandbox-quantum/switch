# Rocket.Chat Collaboration Bridge

This page explains how to connect a Rocket.Chat bot user to Switch.

## Prerequisites

- A Rocket.Chat server (self-hosted or Rocket.Chat Cloud) that Switch can reach over HTTP/HTTPS.
- A dedicated bot user on that server. Do not use a personal account: the bot
  user posts as every agent, with the agent's name at the head of each message.

## Creating the bot user

1. In the Rocket.Chat admin panel, create a user for the bot (Users → Add
   user), with a username such as `switch-bot`.
2. Set a strong password for that user; you will enter it in Switch Console.
3. Add the bot user to the channels and private groups Switch should bridge
   (or create rooms from Switch, which adds the bot automatically).

## Connection Configuration

In Switch Console, add a new Rocket.Chat bridge with these fields:

| Field | Description | Required |
|-------|-------------|----------|
| **Server URL** | The Rocket.Chat server base URL, the root only (e.g. `https://chat.example.com`) | Yes |
| **Username** | The bot user's username | Yes |
| **Password** | The bot user's password | Yes |

Switch verifies the credentials with a login call before saving the bridge.

## How It Works

- **Outbound** messages, edits, deletes, reactions and channel management go
  through the Rocket.Chat REST API, authenticated as the bot user.
- **Inbound** messages arrive on Rocket.Chat's realtime (DDP) WebSocket. The
  adapter subscribes to every channel and private group the bot is in when it
  connects, and again on every reconnect, so a group the bot is added to is
  picked up the next time the connection re-establishes.
- **Threads** are Rocket.Chat's own: a reply in a Switch thread is posted as a
  threaded message, and a threaded message on Rocket.Chat arrives in that
  thread.
- **Commands** work with the `!command` syntax (e.g. `!help`).
- **Approval and question cards** are rendered as plain text with the
  typed-answer grammar (`A1 yes`, etc.). Answer by replying with the option
  handle.
- **Working indicator**: the agent's turn is marked with a 👀 reaction on the
  message that asked for it.
- **Long messages** are split cleanly below Rocket.Chat's message size limit.

## Supported Features

| Feature | Status |
|---------|--------|
| Channel and private group messaging | ✅ |
| Threads | ✅ (native) |
| Text formatting | ✅ (Rocket.Chat Markdown) |
| Attachments (to and from) | ✅ |
| Edits and deletes (outbound) | ✅ |
| Channel creation from Switch | ✅ |
| Archiving a room's channel on delete | ✅ |
| Add people to a channel | ✅ |
| Reactions as activity indicator | ✅ |
| `!commands` | ✅ |
| Approval/question cards (typed answers) | ✅ |
| Direct messages | ❌ (1:1 chats are not bridged) |
| Directory search | ❌ |
| Typing indicator | ❌ (reaction used instead) |
| Slash commands | ❌ (use `!command`) |

## Unsupported / Known Limitations

- **No direct messages**: only channels and private groups are bridged.
- **No directory search**: only people who have spoken in a bridged room can be
  named.
- **New rooms on reconnect**: the bot subscribes to its rooms when the realtime
  connection establishes. A room the bot joins while the connection stays up is
  picked up on the next reconnect, not immediately.
- **Single bot identity**: every agent posts as the one bot user and is
  distinguished by the name at the head of its messages. Rocket.Chat has no
  per-message identity override for a bot user.

## Troubleshooting

| Issue | Resolution |
|-------|------------|
| `Could not reach the Rocket.Chat server` | Check the server URL, network connectivity, and that the server is up. |
| Credentials rejected on login | Check the bot user's username and password in Switch Console. |
| Bot is in no channels or groups | Add the bot user to a channel on Rocket.Chat; the adapter logs a warning until then. |
| Messages not appearing | Check that the bot user is a member of the room and that the realtime connection is up in the switch-core logs. |

## Connecting in Switch Console

1. Open Switch Console → Connect a messaging app → Rocket.Chat.
2. Enter the server URL, the bot user's username and password.
3. Click **Connect**. Switch verifies the login before saving.

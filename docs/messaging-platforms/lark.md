# Lark / Feishu Collaboration Bridge

This page explains how to connect a Lark (or Feishu) bot app to Switch.

## Prerequisites

- A Lark or Feishu tenant (organization).
- A bot app you create in the developer console: [Lark](https://open.larksuite.com/app)
  or [Feishu](https://open.feishu.cn/app).
- Switch must be able to make outbound HTTPS connections to the Lark/Feishu
  OpenAPI domain. No public address is needed (see Transport below).

## Creating the bot app

1. In the developer console, create an app and enable the **Bot** capability.
2. In **Credentials & Basic Information**, copy the **App ID** and **App Secret**.
3. In **Event Subscriptions**, choose **Long Connection** (WebSocket) as the
   subscription mode and add the **Receive Message** (`im.message.receive_v1`)
   event.
4. In **Permissions**, grant the bot the scopes it needs to read and send
   messages and to upload files (`im:message`, `im:message:send_as_bot`,
   `im:resource`, `im:chat:create`).
5. Create a **Version**, publish it, and install the app into your tenant.
   Adding scopes later requires publishing a new version.
6. Add the bot to a group chat in Lark/Feishu. Group chats are what Switch
   bridges; the bot cannot receive group messages until it is in the group.

## Connection Configuration

In Switch Console, add a new Lark bridge with these fields:

| Field | Description | Required |
|-------|-------------|----------|
| **App ID** | The bot app's App ID (`cli_...`) | Yes |
| **App Secret** | The bot app's App Secret | Yes |
| **API Base URL** | `https://open.feishu.cn` for Feishu (China) or `https://open.larksuite.com` for Lark (international) | Yes |

Switch verifies the credentials with an app access token call before saving
the bridge.

## Transport: long connection, not a webhook

Inbound events arrive over Lark's WebSocket long connection, opened by the
official `lark-oapi` SDK from switch-core's outbound connection. This was
chosen over a webhook because it needs no public HTTPS address for Switch, works
behind NAT and in local development, and fits the existing
`keeps_quiet_unless_listening` multi-pod pattern: only the pod holding the
bridge lease opens the connection. The webhook alternative would require
`MESSAGING_PUBLIC_URL`, a publicly routed `/messaging` path, and an encrypt key,
for no benefit here.

One SDK limitation to know: the long-connection client has no stop API, so its
background thread exits with the process. Stopping and restarting a Lark bridge
in a running process leaves the old connection up until the process exits;
Lark's long-connection delivery is cluster-mode (each event goes to one
client), so during that overlap an event can be delivered to the old client and
dropped. Restart switch-core to fully drop an old connection.

## How It Works

- **Outbound** messages, edits, deletes, file uploads and chat management go
  through the Lark OpenAPI REST endpoints with a tenant access token.
- **Inbound** messages arrive on the long connection as `im.message.receive_v1`
  events. The bot's own app messages and 1:1 chats are not bridged.
- **Threads** are Lark's own: a reply in a Switch thread is posted as a
  threaded reply, and a threaded message on Lark arrives in that thread.
- **Commands** work with the `!command` syntax (e.g. `!help`).
- **Approval and question cards** are rendered as plain text with the
  typed-answer grammar (`A1 yes`, etc.). Answer by replying with the option
  handle.
- **Long messages** are split cleanly below Lark's message size limit.

## Supported Features

| Feature | Status |
|---------|--------|
| Group chat messaging | ✅ |
| Threads | ✅ (native) |
| Text and rich-text (post) messages inbound | ✅ |
| Attachments (to and from) | ✅ |
| Edits and deletes (outbound) | ✅ |
| Chat creation from Switch | ✅ |
| Dissolving a room's chat on delete | ✅ |
| Add people to a chat | ✅ |
| `!commands` | ✅ |
| Approval/question cards (typed answers) | ✅ |
| Direct messages (1:1 with the bot) | ❌ (not bridged) |
| Directory search | ❌ |
| Typing indicator / reactions | ❌ (status text used) |
| Slash commands | ❌ (use `!command`) |
| Interactive message cards with buttons | ❌ (typed answers instead) |

## Unsupported / Known Limitations

- **No direct messages**: only group chats are bridged.
- **No directory search**: only people who have spoken in a bridged chat can be
  named. Sender names are resolved through the contacts API and cached;
  if that lookup fails, the sender's open ID is shown instead.
- **No native cards**: approval and question cards are plain text with typed
  answers, as on other text-first platforms.
- **Long-connection shutdown** (see Transport above).

## Troubleshooting

| Issue | Resolution |
|-------|------------|
| `Could not reach the Lark server` | Check the API base URL and that switch-core can reach it over HTTPS. |
| Credentials rejected | Check the App ID and App Secret, and that the app version with them is published. |
| No messages arrive | Check the app is installed in the tenant, the bot is in the group, and the `im.message.receive_v1` event is subscribed over Long Connection. |
| Scopes missing after a change | Publish a new app version and reinstall the app into the tenant. |

## Connecting in Switch Console

1. Open Switch Console → Connect a messaging app → Lark.
2. Enter the App ID, App Secret, and the API base URL for your tenant
   (Feishu or Lark).
3. Click **Connect**. Switch verifies the credentials before saving.

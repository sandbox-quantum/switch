# Lark and Feishu

Switch connects to an app you create in the Lark or Feishu developer console.
This adapter talks to the external Lark or Feishu Open Platform API. It is
separate from Switch's internal Matrix server and does not use Switch's own
chat service.

## Create and connect the bot

1. Create a custom app in the [Lark developer console](https://open.larksuite.com/app)
   or [Feishu Open Platform](https://open.feishu.cn/app).
2. Add the bot capability. Under app credentials, copy the App ID and App
   Secret. Under Event Subscriptions, copy the Verification Token.
3. Grant the app permission to receive messages and send messages in direct
   and group chats. If users will add the bot to cross-organization groups,
   enable the app's external group availability. Publish or enable the app for
   your test organization.
4. In Switch Console, create a Lark / Feishu connection and enter those
   credentials. Choose **Lark** for `open.larksuite.com` or **Feishu** for
   `open.feishu.cn`.
5. Copy the webhook address shown by Switch into Event Subscriptions as the
   Request URL. Subscribe to `im.message.receive_v1` and save the subscription.
   The public deployment must have `MESSAGING_PUBLIC_URL` and route `/messaging`
   to switch-core over HTTPS. See [Add a messaging platform](../contributing/add-a-messaging-platform.md#exposing-it-over-public-https)
   for local tunnel setup.
6. Invite the app bot to each group it should bridge. Direct conversations with
   the bot are also bridged.

The adapter uses Lark's webhook delivery rather than a persistent connection.
Lark calls the per-connection Switch webhook, which lets any Switch pod accept
an event. Switch stores each Lark event ID in its shared receipt table before
dispatch, so platform retries are dropped across pods and restarts.
Switch also persists outbound event claims, so a normal handoff between pods
does not post a room message twice. Lark's send API does not provide an
idempotency key. If a process stops after Lark accepted a message but before
Switch recorded its message ID, that uncertain send can be repeated after the
claim expires.

When Lark event encryption is enabled, enter the app's Encrypt Key in Switch.
Switch verifies `X-Lark-Signature` over the raw request body using Lark's
timestamp, nonce, and Encrypt Key before decrypting. Signed requests older than
eight hours or more than five minutes in the future are refused. The
Verification Token is checked after decryption, and shared event receipts drop
replayed event IDs across pods and restarts. Lark's CBC format carries a
per-message IV in the first 16 decoded bytes; the signature authenticates the
ciphertext because CBC itself does not provide authentication.

## Behavior and limits

- Group chats map to Switch rooms; direct chats map to direct rooms. Replies
  use the Lark root message ID and stay in the same thread.
- Incoming `!commands` are routed to Switch. Responses and agent messages are
  sent as the app bot, with the agent name in the message.
- Lark slash commands are not registered by this adapter. Use Switch's `!`
  command syntax in a message instead.
- Switch can create a Lark group chat and add people when their Lark Open IDs
  are available. The created chat contains the bot; agents share the app bot
  identity and are distinguished by their names in message text.
- Text and post messages are bridged. Long messages are split on paragraph or
  word boundaries within the API message limit.
- Image and file attachments are downloaded from Lark and uploaded back to
  Lark. Outbound files are limited to 20 MiB, and inbound files use Switch's
  configured attachment limit. Larger files are refused with a visible
  attachment failure. Other attachment types are described in the message text.
- Switch edits and deletes are mirrored to Lark. Lark-side message recalls and
  deletions are imported and reflected in Switch rooms. Lark-side message edits
  are not currently signaled by Lark's webhook API; if Lark adds edit event
  notifications in the future, the adapter is ready to handle them.
- Approval and question cards are rendered using Switch's text fallback, with
  the request handle and answer format shown in the message. Reply in the room
  using that format. Lark card action callbacks are not supported on
  per-connection webhooks because Switch acknowledges those webhooks before
  processing.
- Agent activity is shown with native emoji reactions (👓 for working, ⏳ for
  queued). Requires `im:message.reaction:create` permission.
- The adapter can search the Lark directory by name, nickname, or email. Invite
  the bot to existing rooms on Lark, or create a group from Switch when the app
  has group creation and member management permissions. Directory search requires
  `contact:user:read` permission.
- Encrypted rooms are not supported by this adapter. Lark's bot APIs deliver
  readable message bodies to the app; when the API delivers a message without
  readable content, Switch posts a notice explaining that the bot cannot
  decrypt it and asks the room to use an unencrypted chat.

## Required permissions

Grant the bot permission to receive messages in direct and group chats and the
permission to send messages (`im:message`, with the relevant group and direct
message permissions enabled). To bridge unaddressed group messages, select the
permission to receive all group messages. If the app has only the permission to
receive messages that mention the bot, Lark will deliver only those messages.
For room creation and adding people, grant `im:chat:create` and
`im:chat.members:write_only`. For agent activity reactions, grant
`im:message.reaction:create`. For directory search, grant `contact:user:read`.
Depending on your organization and app approval settings, an administrator may
need to approve these permissions before the bot can be used.

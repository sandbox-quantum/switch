# Cisco Webex

Switch connects to Cisco Webex with a bot access token and signed webhooks.
Webhooks are used instead of a device WebSocket because Webex can deliver them
to any switch-core pod, while Switch's shared receipt store deduplicates every
event ID without a lease-held connection.

## Create and connect the bot

1. In the Webex developer portal, create a bot and copy its access token.
2. Generate a random webhook secret of at least 16 characters and keep it with
   the token.
3. Set `MESSAGING_PUBLIC_URL` to the public HTTPS origin of Switch.
4. In Switch Console, choose **Cisco Webex** and enter the token and secret.
5. Invite the bot to each space you want to bridge.

Switch checks `/people/me` before saving the connection. On start it creates an
active `messages.created` webhook for the connection's public URL. Every callback
must carry a matching `X-Spark-Signature` HMAC over the raw request body before
Switch parses it.

## Spaces and messages

- Webex spaces map one-to-one to Switch rooms; `parentId` maps Webex threaded
  replies to Switch thread roots in both directions.
- Webex webhook IDs are durable receipt keys, so retries import once across
  multiple pods. Message details are fetched only after authentication.
- Bot echoes are discarded. `!commands` work as ordinary messages.
- Switch can create group spaces and add people by Webex person ID or email.
- Agent names prefix outbound messages because all agents share one bot.
- Long replies split at readable boundaries below Webex's message limit.
- Edits and deletes made by Switch are mirrored through the Messages API.
- Incoming files are downloaded with bot authentication and refused visibly
  above Switch's media ceiling. Outbound files currently use the visible text
  fallback rather than silently disappearing.

Adaptive Card actions need a separate `attachmentActions` webhook and durable
card-token mapping, so this first version uses Switch's numbered text-answer
fallback for approvals and questions. Webex provides no bot typing event or
agent-specific identities; directory search and reactions are not advertised.

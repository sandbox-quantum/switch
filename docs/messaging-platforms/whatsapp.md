# WhatsApp Cloud API

Switch connects to a Meta WhatsApp Cloud API phone number and relays one-to-one
text messages. This first adapter release does not support groups, media,
message edits or deletes, commands, rich cards, or room creation. Chats are
represented by the sender's WhatsApp ID and use direct room semantics.

## Create a Meta app

Create a Meta app with the WhatsApp product, add a Cloud API phone number, and
subscribe the app to the `messages` webhook field. Configure the webhook URL
shown for the Switch bridge and set its verify token to the same value entered
in Switch. The endpoint must be reachable over HTTPS.

## Connection fields

- **Access token** — a token with `whatsapp_business_management` to verify the
  phone number ID and `whatsapp_business_messaging` to send messages.
- **Phone number ID** — the Cloud API ID for the sending number, not its display
  phone number.
- **Meta app secret** — used to verify each webhook's
  `X-Hub-Signature-256` header against the raw request body.
- **Webhook verify token** — compared with `hub.verify_token` during Meta's GET
  challenge. Switch echoes `hub.challenge` only after the token matches.
- **Graph API version** — a version such as `v25.0`; select one supported by
  your Meta app and update it when you upgrade your integration.

Switch checks the access token and phone number ID before saving the
connection. Incoming message IDs are used to suppress retried webhook events.
Only inbound text messages are relayed. Outbound text is sent as the connected
phone number and is allowed only within 24 hours of the person's latest inbound
message. After that, ask them to message the number again; approved templates
are not implemented in this release.

The adapter icon is a neutral placeholder. The official WhatsApp brand asset is
not included until its download terms and attribution are cleared.

## Limitations

This adapter does not create WhatsApp chats or add/remove chat participants.
It does not process media, delivery-status notifications, edits/deletes,
commands, reactions, rich cards, or groups. The 24-hour window timestamp is
held in adapter memory, so after a process restart Switch conservatively refuses
replies until a new inbound text arrives.

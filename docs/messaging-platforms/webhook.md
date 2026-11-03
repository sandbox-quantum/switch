# Custom app (webhook)

Connect any chat app Switch has no adapter for: an internal tool, a custom web
chat, a niche platform. Your app and Switch exchange JSON over HTTPS. Switch
posts room messages to your app, and your app posts what people write to an
address Switch gives you.

A working app in about 200 lines, using only the Python standard library, is in
[`examples/webhook-chat`](../../examples/webhook-chat/).

## What you need

- An app that can receive an HTTPS `POST` and make one.
- A public HTTPS address for Switch, so your app can reach it. The deployment
  sets it with `MESSAGING_PUBLIC_URL`. For local development, a tunnel such as
  `ngrok http 8000` works; set `MESSAGING_PUBLIC_URL` to the URL it prints.
- Nothing to create on any platform: your app is the platform.

## Connect it

In Switch Console, open **Connect a messaging app** and choose **Custom app
(webhook)**. Fill in three fields:

| Field | What it is |
|---|---|
| **Outbound URL** | Where Switch sends room messages: an HTTPS endpoint in your app. Plain `http` is accepted only for `localhost`. |
| **Signing secret** | A secret shared with your app. Switch signs every request it sends with it, so your app can tell the requests are Switch's. At least 24 characters, for example `openssl rand -hex 32`. |
| **Inbound token** | A token your app sends to Switch with every event. At least 24 characters, and different from the signing secret. |

When you connect, Switch sends your app a signed `ping`. Your app must answer
with a `2xx`. Anything else shows up as a clear error: a rejected signature, an
HTTP error, or an address that cannot be reached.

Once connected, the connection shows its **address**:

```
https://<your Switch>/messaging/bridges/<bridge id>/events
```

Give that address and the inbound token to your app.

## Sending events to Switch

`POST` JSON to the address with the token in an `Authorization` header:

```bash
curl -X POST "$SWITCH_ADDRESS" \
  -H "Authorization: Bearer $INBOUND_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "version": 1,
    "id": "evt-1001",
    "type": "message",
    "channel": {"id": "support", "name": "Support", "type": "channel"},
    "sender": {"id": "u-17", "name": "Ada"},
    "message": {"text": "@triager checkout is failing"}
  }'
```

Switch answers right away and handles the event afterwards.

| Event `type` | Meaning |
|---|---|
| `message` | Someone wrote something. Needs `sender` and `message`. |
| `channel.joined` | Your app added Switch to this channel. Switch creates a room for it, or adopts the one you made. |

Fields:

- `id`: unique per event. If you retry an event, send the same `id`, and Switch
  handles it once.
- `channel.type`: `channel` (default), `private`, `group` or `direct`.
- `message.id`: your id for the message. Defaults to the event `id`.
- `message.thread_id`: the `message.id` of the thread's first message, when this
  is a reply.
- `message.files`: a list of `{"filename", "mimetype", "data"}`, with `data`
  base64 encoded. A file that is too large or not valid base64 is not
  dropped silently: Switch tells the room which file it could not take.
- `sender.is_app`: set it for posts from another app. They reach the room but
  cannot answer an approval.

A message starting with `!` is a command, for example `!invite-agent triager`.

Statuses: `200` handled, `401` wrong token, `400` the body could not be read
(the message says which field), `404` no such connection, `503` the connection
is restarting. Retry on `503` and on network errors.

The full definition is [`webhook.schema.json`](webhook.schema.json).

## Receiving events from Switch

Switch `POST`s JSON to your outbound URL. Answer any `2xx` once you have
stored the event.

```json
{
  "version": 1,
  "type": "message.created",
  "sent_at": 1767225600,
  "channel_id": "support",
  "message_id": "msg_5d1c0b6e...",
  "sender": {"name": "triager", "icon_url": "https://..."},
  "text": "Restated: checkout fails with a 500.",
  "files": []
}
```

| `type` | When | Fields used |
|---|---|---|
| `ping` | Connecting. | none |
| `message.created` | An agent or a person in the room posted. | `channel_id`, `message_id`, `sender`, `text`, `thread_id`, `files` |
| `message.updated` | A message was edited. | `channel_id`, `message_id`, `text` |
| `message.deleted` | A message was deleted. | `channel_id`, `message_id` |
| `typing` | An agent started or stopped working. | `channel_id`, `sender`, `is_typing` |

`text` is CommonMark. Switch picks `message_id`, so keep it: later edits and
deletes refer to it. If your app is slow or answers with a server error, Switch
retries the same message with the same `message_id`; use it to ignore a copy
you have already stored.

Each file is `{"filename", "mimetype", "size", "data"}` with `data` base64
encoded. A file larger than the deployment's attachment limit is left out and
the message says which one.

### Check the signature

Every request carries:

| Header | Value |
|---|---|
| `X-Switch-Timestamp` | Unix time in seconds. |
| `X-Switch-Signature` | `v1=` and the hex HMAC-SHA256 of `<timestamp>.<raw body>`, keyed with the signing secret. |
| `X-Switch-Event` | The event `type`. |
| `X-Switch-Delivery` | A unique id for this attempt. |

Compute the signature over the raw bytes, compare in constant time, and reject
timestamps more than five minutes old:

```python
import hashlib, hmac, time

def is_from_switch(headers, body: bytes, secret: str) -> bool:
    stamp = headers["X-Switch-Timestamp"]
    if abs(time.time() - int(stamp)) > 300:
        return False
    digest = hmac.new(secret.encode(), stamp.encode() + b"." + body, hashlib.sha256)
    return hmac.compare_digest("v1=" + digest.hexdigest(), headers["X-Switch-Signature"])
```

```javascript
import { createHmac, timingSafeEqual } from "node:crypto";

export function isFromSwitch(headers, rawBody, secret) {
  const stamp = headers["x-switch-timestamp"];
  if (Math.abs(Date.now() / 1000 - Number(stamp)) > 300) return false;
  const expected =
    "v1=" + createHmac("sha256", secret).update(`${stamp}.`).update(rawBody).digest("hex");
  const given = headers["x-switch-signature"] ?? "";
  return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
```

## How things map

- **Rooms and channels.** Each channel id your app uses is a Switch room.
  Send `channel.joined` for a channel to have Switch create its room, then
  mention an agent (`@name`) to talk to it. Messages without a mention still
  reach the room.
- **Threads.** `thread_id` on both sides keeps a reply under the message it
  answers.
- **Agent names.** Each outbound message names the agent in `sender.name`, with
  `icon_url` when the agent has one. Show it however your app shows a person.
- **Approvals and questions.** They arrive as plain-text messages, and a person
  answers by writing a message. There are no buttons.
- **Long replies.** Switch does not split them. Your app receives the whole
  text.
- **Restarts.** Switch keeps nothing about your app in memory. After a restart
  your app only needs to be reachable at the same URL, and retried events with
  the same `id` are ignored.

## What doesn't work

- Switch cannot create channels in your app. Create the channel yourself and
  send `channel.joined`.
- There is no member directory, so Switch cannot search for people in your
  app, and cannot add people to a channel.
- Reactions and message buttons are not used.
- Files travel inside the JSON, so keep them small.

## If something goes wrong

| What you see | Likely cause |
|---|---|
| Connecting says the app "rejected the request" | The app does not check the signature with the same signing secret, or the `ping` answered `401`. |
| Connecting says it "could not reach" the URL | The URL is wrong or blocked. Private addresses must be allowed by the deployment's `OUTBOUND_ALLOWED_PRIVATE_HOSTS`. |
| Your events get `401` | The inbound token differs from the one saved on the connection. |
| Your events get `400` | The JSON does not match the schema. The response says which field. |
| The connection reports Switch cannot deliver messages | Your app is down or answering with errors. It recovers on its own when messages get through again. |

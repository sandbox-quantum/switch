# Webhook

Connect a chat app Switch has no adapter for: an internal tool, a custom web
chat, a niche platform. Switch POSTs each event to your URL as signed JSON, and
your app POSTs its own events (messages, button presses) to an address Switch
gives the connection. Nothing in Switch has to change to support your app.

`examples/webhook-chat/` is a complete single-file receiver and web chat that
does both halves. Start there if you would rather read code than a spec.

## Connect it

1. Write the receiver (or run the example, below). It needs one public HTTPS
   endpoint that accepts Switch's POSTs and answers `2xx`.
2. In Console, **Connect a messaging app → Webhook**, and fill in:

   | Field | What it is |
   |---|---|
   | Outbound URL | Where Switch POSTs events. `https`, or `http` for `localhost` during development. Switch refuses addresses its outbound policy blocks; a receiver on a private network needs its host or CIDR in `OUTBOUND_ALLOWED_PRIVATE_HOSTS`. |
   | Signing secret | At least 16 characters. Signs everything Switch sends, and is accepted for signed requests to Switch. |
   | Inbound token | At least 16 characters. The bearer token your app sends to Switch. |

3. Switch sends a `health.check` event when you save. A receiver that cannot be
   reached, or answers `401`/`403` or any non-`2xx`, fails the connection with
   the reason.
4. Copy the address Switch shows once it is connected,
   `https://<MESSAGING_PUBLIC_URL>/messaging/bridges/<bridge id>/events`, into
   your app. It needs the deployment's `MESSAGING_PUBLIC_URL` set, as for any
   [webhook platform](../contributing/add-a-messaging-platform.md#exposing-it-over-public-https).
5. Switch cannot create chats on your app. Create the room in Console bound to
   the channel id your app uses, or have your app send `channel.joined` for a
   new channel so Switch makes the room.

## Schema version 1

Every body in both directions carries `"schema_version": 1`. Switch refuses an
inbound body with any other version. Unknown fields are ignored in both
directions, so a receiver should ignore fields it does not know.

### Outbound: Switch to your app

`POST <outbound_url>`, `Content-Type: application/json`:

```json
{
  "schema_version": 1,
  "event_id": "9f1c…",
  "event": "message.created",
  "created_at": "2026-01-01T12:00:00+00:00",
  "data": { }
}
```

Headers:

| Header | Value |
|---|---|
| `X-Switch-Event` | the event name |
| `X-Switch-Timestamp` | unix seconds |
| `X-Switch-Signature-256` | `sha256=<hex>` |

**Verify the signature** before reading the body. It is the HMAC-SHA256, keyed
with the signing secret, of the timestamp, a `.`, and the raw body bytes:

```python
expected = "sha256=" + hmac.new(
    secret.encode(), timestamp.encode() + b"." + raw_body, hashlib.sha256
).hexdigest()
ok = hmac.compare_digest(header_signature, expected)
```

Compare in constant time and refuse a timestamp more than a few minutes from
your clock; signing the timestamp is what stops a captured request being
replayed. Answer `401` on a bad signature. Switch does not follow redirects,
does not retry, and reports a non-`2xx` as a failed send, so answer fast and
return `2xx` only for events you took.

`event_id` is unique per delivery. Switch makes one attempt, so it is for your
own logging.

Your answer may be empty. For `message.created` and `request.opened` /
`activity.updated` a JSON body `{"message_id": "<your id>"}` makes your id the
one Switch uses in later `message.updated`, `message.deleted` and card updates;
without it Switch uses the `message_id` it sent. Either way no state is kept
for it in Switch's memory.

#### Events

| `event` | When |
|---|---|
| `health.check` | On connect. `data` is `{}`. |
| `message.created` | An agent (or Switch itself) posts. |
| `message.updated` | A post is edited. |
| `message.deleted` | A post is removed. |
| `typing.updated` | An agent starts or stops working. |
| `activity.updated` | A turn's status changed. Also the first post of one. |
| `request.opened` | An agent asks for approval or answers. |
| `request.updated` | The card changed (answered, expired). |

`message.created` `data`:

```json
{
  "channel_id": "general",
  "message_id": "…",
  "thread_root_id": null,
  "sender_name": "builder",
  "sender_display_name": "Builder",
  "sender_icon_url": null,
  "sender_type": "agent",
  "content": "Switch Markdown",
  "room_wide_mention": false,
  "attachments": [
    {"filename": "a.txt", "mimetype": "text/plain", "size": 5, "data_base64": "YWxwaGE="}
  ]
}
```

- `sender_type` is `agent` for anything posted under an agent's name (a person
  relayed from another chat arrives the same way) and `admin` for Switch's own
  notices and command results (`sender_name` is `Switch`).
- `content` is Markdown. Links to Console pages are rewritten to https.
  `@name` mentions are left in the text.
- `thread_root_id` is the `message_id` of the thread's root, or `null`.
- `room_wide_mention` is `true` when the post pages the whole channel; your
  app decides what that means.
- Several files sent together arrive in one event.
- A post longer than 8000 characters arrives as several `message.created`
  events in order, as replies under the first one (or in the thread it was
  already in). Cuts fall on a paragraph, then a line,
  then a space. A fenced code block open at a cut is closed at the end of that
  event and reopened, with its language, at the start of the next. The files
  and `room_wide_mention` are on the first event, and its `message_id` is the
  one Switch keeps, so a later edit or delete addresses only that first piece.
  `message.updated` content is never split.

`message.updated` `data`: `channel_id`, `message_id`, `content`,
`thread_root_id` (always `null`: an edit does not say).

`message.deleted` `data`: `channel_id`, `message_id`.

`typing.updated` `data`: `channel_id`, `sender_name`, `is_typing`. It is a hint:
if Switch cannot deliver one it logs a warning and carries on.

`activity.updated` `data` (a turn's status, edited in place; an unseen
`message_id` is a new message):

```json
{
  "channel_id": "general", "message_id": "…", "thread_root_id": null,
  "agent_name": "builder", "sender_display_name": "Builder", "sender_icon_url": null,
  "turn_id": "…",
  "status": "running",
  "elapsed_seconds": 12.0,
  "text": "**Working…**",
  "log": "",
  "error_summary": null,
  "interrupt": {"action_id": "switch:turn-interrupt", "value": "…", "label": "Stop current work"}
}
```

`status` is `queued`, `running`, `completed`, `interrupted` or `error`. `text`
is Markdown you can show as is. `log` is what the turn did, once it has ended.
`interrupt` is present only while the turn can be stopped; draw a button and,
when pressed, send it back as an `interaction`.

`request.opened` and `request.updated` `data`:

```json
{
  "channel_id": "general", "message_id": "…", "thread_root_id": null,
  "agent_name": "builder", "sender_display_name": "Builder", "sender_icon_url": null,
  "request_id": "…", "handle": "R42", "state": "open", "kind": "approval",
  "text": "Markdown: the question, numbered options, and how to answer",
  "answerable": true,
  "controls": [
    {"position": 1, "label": "Allow once", "action_id": "switch:request-option:1", "value": "<token>"}
  ],
  "responder_external_id": null
}
```

Answer a card either way:

- **Buttons:** draw each of `controls`, and when one is pressed POST an
  `interaction` with its `action_id` and `value` unchanged.
- **Text:** a person types the handle and option number as an ordinary message,
  for example `R42 1`. `text` always says exactly how. A card with
  `answerable: false` or no `controls` can only be answered in Console or by
  typing, as `text` says.

Once the card is answered, `state` changes and `controls` is empty.

### Inbound: your app to Switch

`POST <the connection's address>`, `Content-Type: application/json`.
Authenticate with any one of:

- `Authorization: Bearer <inbound token>`
- `X-Webhook-Token: <inbound token>`
- the same `X-Switch-Timestamp` and `X-Switch-Signature-256` headers Switch
  sends, computed with the signing secret (timestamp within five minutes).

An unauthenticated request gets `401` before its body is parsed or logged. Switch answers
`200` at once and handles the event after, so a slow agent never makes your app
time out. `400` means the body was authentic and unreadable; the reason is in
Switch's log.

Every body needs `schema_version: 1`, a unique `event_id` and a `type`. Retrying
a delivery with the same `event_id` is safe: it is handled once, whichever
Switch pod receives it. Use a new `event_id` for every new event.

Fields shared by the events with a channel: `channel_id` (required),
`channel_type` (`channel_public`, `channel_private`, `group` or `direct`;
default `channel_public`) and `channel_name` (optional).

| `type` | Fields |
|---|---|
| `message` | channel fields, `sender_id`, `sender_name`, `text`, optional `message_id`, `thread_root_id`, `attachments` |
| `command` | channel fields, `sender_id`, `sender_name`, `command`, `args`, optional `message_id`, `thread_root_id` |
| `interaction` | `channel_id`, `sender_id`, `sender_name`, `action_id`, `value`, `message_id` (the card or status pressed), optional `thread_root_id` |
| `channel.joined` | channel fields. Your app has a new channel; Switch makes its room. |
| `agent.joined` | channel fields, `agent_name` |
| `user.joined` | channel fields, `user_id`, `user_name` |

`sender_id` is your app's stable id for the person. Switch files a person under
it, so keep it the same for the same person.

A `message` needs `text`, `attachments`, or both. `message_id` is your id for it
and is what a later reply names as `thread_root_id`; without it the `event_id`
is used. Text that is exactly a `!command` (`!invite-agent builder`) is run as a
command, the same as a `command` event; send those as `command` events if you
prefer.

An attachment is `{"filename": …, "mimetype": …}` plus exactly one of
`data_base64` or `url`. A `url` is fetched by Switch under its outbound policy,
without redirects. A file over the deployment's attachment limit, a bad base64
string or a failed download is not dropped: the room is told which file was
refused and why.

Edits, deletes and reactions from your app are not accepted yet: Switch has no
way to apply them to a room, so such an event gets `400` rather than being
quietly ignored.

#### Address check

A `GET` to the address with `?challenge=<text>` and the inbound token (any of
the headers above, or `&token=<inbound token>`) answers `200` with the
challenge as the body.

## Capabilities

| | |
|---|---|
| Receives events by webhook | yes |
| Session activity and approval cards | yes |
| Create chats from Switch | no. Bind a room to an existing channel id or send `channel.joined`. |
| Directory search | no. People appear when they first send a message. |
| Add people to a channel | no. Your app manages who is in a channel; Switch says so when asked. |
| Agent avatars and names | sent on every event as `sender_display_name` and `sender_icon_url`; drawing them is up to you |
| Reactions, activity marks | no |
| Edits and deletes from your app | no |
| Bare `yes` answering the newest card | no. Type the handle, for example `R42 1`. |
| `switchdash://` links | rewritten to https, which needs `GATEWAY_PUBLIC_URL` on the server |

## Several Switch pods

Switch can run as several pods. Nothing about a webhook connection lives in one
pod's memory: any pod can send events to your URL and any pod can receive your
app's. Message ids are minted per send (or are yours), so edits and deletes
need no lookup, and a retried inbound event is recognised by its `event_id`.
Switch makes one delivery attempt per outbound event, so if your receiver can be
briefly down, queue on your side.

## Run the example

```bash
cd examples/webhook-chat
export SWITCH_SIGNING_SECRET=<the connection's signing secret>
export SWITCH_INBOUND_TOKEN=<the connection's inbound token>
export SWITCH_INBOUND_URL=https://<MESSAGING_PUBLIC_URL>/messaging/bridges/<bridge id>/events
python3 server.py        # http://localhost:9000, PORT to change it
```

Connect Switch with outbound URL `http://localhost:9000/switch` (loopback
`http` is allowed; for a Switch that runs elsewhere use a tunnel and its https
URL). Add `localhost` to `OUTBOUND_ALLOWED_PRIVATE_HOSTS` if Switch itself runs
on your machine. Open the page, press **Announce channel** to make a room for
`general`, and write a message that mentions an agent. The page shows replies,
threads, edits, deletes, files, the working indicator, and approval cards with
working buttons. A message starting with `!` runs a command.

# Custom messaging apps over webhooks

Use **Custom app (webhook)** to connect an application you operate. Switch sends
signed JSON to your receiver; your backend authenticates requests to Switch with
a separate inbound token. No vendor account, paid API, or hosted MCP service is
required. This is a self-created connection, not a distributed Switch app.

## Connect an app

1. Implement the version-one receiver contract below and make its HTTPS URL
   reachable from Switch. A receiver must handle `connection.check` before it
   has been configured: return its event ID and version, without changing state.
2. Set `MESSAGING_PUBLIC_URL` on Switch to its public HTTPS origin, and route
   `/messaging` to Core. An HTTPS development tunnel works. An operator must
   explicitly allow a private receiver in `OUTBOUND_ALLOWED_PRIVATE_HOSTS`.
   HTTP receivers are supported only on loopback for development.
3. In Console, choose **Connect a messaging app → Custom app (webhook)** and
   enter your receiver URL. Switch checks that the receiver speaks v1; an HTTP
   refusal or invalid acknowledgment fails the connection check.
4. Copy the inbound webhook address, **inbound token**, and **signing secret**
   into your app's backend. The secrets are returned only to the admin creating
   the connection and are shown only once. They are not available in connection
   listings. Keep both out of frontend code, messages, URLs, and logs. Reconnect
   to generate new secrets if they are lost or compromised.
5. Send `channel.join`, or a message in a new channel, to create its Switch
   room. Channel IDs are stable application identifiers. Choose the correct
   channel type; private chats must not be described as public.
6. Invite an existing agent with `!invite-agent @agent-name`, then address it
   with `@agent-name your request`. Unaddressed messages also reach the room.
   Manage which people can read the chat in your app.

Deleting the connection stops delivery and removes its inbound webhook. Stop
sending from your app when you disconnect it; a `404` means its address is gone.

## Version-one contract

The complete schemas ship beside the adapter:

- [Incoming event schema](../../core/switch_core/bridges/collaboration/webhook/incoming.schema.json)
- [Outgoing event schema](../../core/switch_core/bridges/collaboration/webhook/outgoing.schema.json)
- [Receiver acknowledgment schema](../../core/switch_core/bridges/collaboration/webhook/acknowledgment.schema.json)

Unknown fields and unsupported versions are refused. IDs are 1–200 ASCII
letters, digits, `_`, `.`, `:`, or `-`. Send UTF-8 JSON. Do not forward a Switch
post back as a human: mark echoes with `sender.kind: "switch"`; those are ignored.
Use `kind: "app"` for other automation, which cannot answer a person's approval.
The backend holding the token is trusted to authenticate its own users and
report their stable identities faithfully.

### App → Switch

POST to the connection's inbound address with:

```http
Authorization: Bearer <inbound token>
Content-Type: application/json
```

```json
{
  "version": 1,
  "event_id": "delivery-001",
  "type": "message",
  "channel_id": "support",
  "channel_type": "channel_private",
  "sender": {"id": "person-1", "name": "demo-user", "kind": "human"},
  "message_id": "post-001",
  "thread_id": null,
  "text": "@worker Please review this",
  "attachments": []
}
```

`message_id` identifies the original post; retries retain both IDs and their
payload. Use the root post's ID in `thread_id` for replies. A `channel.join`
event announces an existing chat without a message. A `command` event accepts
`!command arguments` in `text`; ordinary messages can also contain `!commands`.
Do not deliver the same post as both a message and a command.

Switch returns `200` after the callbacks complete and the receipt is marked
handled. The receipt claim commits before dispatch, releasing the pooled
connection and unique-index lock. A concurrent retry gets `503` while the event
is unfinished, and `200` once it is handled. A failed dispatch releases its claim
in a separate transaction before returning `503`. Keep a durable outbox in your application and retry the exact
event on network failures, `408`, `429`, or `5xx`, with bounded backoff. Do not
retry `400` (schema), `401` (credentials), `404` (connection removed), or `413`
(size) without correcting the problem. A process killed after claiming can leave
an unhandled receipt requiring operator recovery; retries receive `503` rather
than a false success. Derived room-write IDs protect replay after partial dispatch.
Receipts are retained for seven days, so do not intentionally replay old events.

### Switch → app

Every request is a POST to your configured receiver URL. It carries
`X-Switch-Timestamp` (Unix seconds) and `X-Switch-Signature`:

```python
"sha256=" + hmac.new(
    signing_secret.encode(),
    timestamp.encode() + b"." + raw_request_body,
    hashlib.sha256,
).hexdigest()
```

Verify the raw bytes before parsing or acting, use a constant-time comparison,
and reject timestamps more than five minutes old. The only unsigned bootstrap
exception is an unconfigured receiver answering the no-op `connection.check`.
Once configured, verify that probe too. Never use the inbound token to verify
outbound requests; the credentials have different purposes.

An event includes `version`, `event_id`, `type`, `channel_id`, `message_id`,
`thread_id`, `sender_name`, `text`, `attachments`, and optional `marker`,
`group_id`, and `is_typing`. Nullable fields may be null. Handle these types:

| Type | Receiver behavior |
| --- | --- |
| `connection.check` | Check contract compatibility; do not create a message. |
| `message.create` | Store a message under `message_id`, attributed to `sender_name`. |
| `message.update` | Replace that message's text; updates target the same reference. |
| `message.delete` | Remove that message and its continuation group. |
| `typing` | Set or clear the sender's transient typing indicator. |
| `activity` | Store a text activity card, then edit it on `message.update`. |
| `request` | Store a text approval/question card with its answer instructions. |
| `publication.lookup` | Answer whether `message_id` exists, without creating it. |

Commit an event's effect and receipt atomically **before** answering HTTP 200:

```json
{"version": 1, "event_id": "the-event-id-you-received"}
```

A lookup adds `"found": true` or `false`. Keep durable receipts and enforce
unique event IDs; a repeated delivery must not create another message. An event
ID with a different body is an error. Repeated creates of an existing
`message_id` must not create another post. Switch reuses source-derived message
IDs across retries and restarts and makes up to three short delivery attempts;
its room consumer retries failed outbound work. A server that only keeps this
state in memory cannot meet the restart guarantee.

Long messages are split into pieces of at most 4,000 Unicode characters,
preferring newlines. Concatenating the pieces recovers the original text.
The first message is the group's anchor; continuations carry its ID in
`group_id` and reply under the existing thread, or under the anchor. Editing
an anchor replaces its group, and deleting it deletes all its continuations.
A receiver should preserve the root's reference when replacing a group.

### Attachments and rendering

Files carry `name`, `mime_type`, and base64-encoded `data_base64`, never a URL
for Switch to fetch. Limit each event to five files and 5 MiB of decoded files
in total. Incoming HTTP bodies are capped at 8 MiB. An oversized outbound file
is replaced with an explicit refusal message. Treat file names as labels,
never filesystem paths, and serve downloads without executing active content.

Text uses Switch Markdown. Render it with a sanitizing renderer or as safe text;
never insert it into HTML unescaped. Sender names are separate labels.

Activity cards include the current state and tool summary. Approval and
question cards use text answers (for example `R7 1`) sent back as ordinary
messages in the same channel/thread. Switch validates the answerer's identity
and agent addressing policy. V1 has no native buttons, slash-command
registration, reactions, directory search, channel provisioning, or membership
management. Manage chats and people in your app. V1 accepts incoming messages,
commands, and joins; incoming edits/deletes are not supported. Outbound edits
and deletes are mirrored. This interface does not let an app impersonate a
Switch agent by requesting an agent identity.

## Run the example chat

The example is a local, single-user development app. It uses SQLite for inbound
receipts, messages, and the outgoing queue. It is not a production identity or
multi-user authorization implementation. Its HTML implements safe basic
Markdown (bold, inline code, fenced blocks); other Markdown is shown as text.

```bash
# Terminal 1, from the repository root
uv run --project core uvicorn app:app --app-dir examples/webhook-chat \
  --host 127.0.0.1 --port 8123 --no-access-log
```

Open `http://127.0.0.1:8123` and enter the demo admin token printed by this
server. Set `OUTBOUND_ALLOWED_PRIVATE_HOSTS=127.0.0.1,localhost` on a Core process
running on the same machine. Connect the receiver
`http://127.0.0.1:8123/receive` in Console. Paste the connection's one-time
secrets into the example's setup form. For a loopback-only experiment the
example can use `http://127.0.0.1:8000/messaging/bridges/<id>/events` as its
inbound URL; real external apps need the advertised HTTPS address.

The default database is `switch-webhook-chat.sqlite3` in the system temporary
directory, created with mode 0600. It contains demo credentials and chat history; keep it out of the
repository and delete it when finished. `WEBHOOK_CHAT_DB` selects another file,
and `WEBHOOK_CHAT_ADMIN_TOKEN` can supply a stable demo admin token. Use a new
database when connecting a different bridge. Neither the backend credentials
nor the admin token are stored in browser storage.

For the PR video, show the platform in Console, connect it, finish the example's
setup, send an addressed message both ways, attach a small file, and answer a
permission request by typing the displayed request handle and option. Show the
answer recorded in Switch. Restart the example with the same database to show
pending deliveries and existing messages survive. Use a scripted provider if
you need a demonstration without model usage charges, and label it as such.

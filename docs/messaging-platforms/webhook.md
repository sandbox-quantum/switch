# Custom app (webhook)

Connect an internal chat, web chat or other application without maintaining a
Switch adapter. This is a self-created connection: your application authenticates
its users, sends their events to Switch, and implements a signed event receiver.
Possession of the inbound token authorizes speaking as any user of that
connection. Never expose it in browser code or accept client-supplied user
identities without authenticating them in your backend.

## Connect

1. Generate **two different random secrets**, each at least 32 printable ASCII
   characters, using `python3 -c 'import secrets; print(secrets.token_urlsafe(32))'`
   twice. Keep them in a secret manager. The inbound token and outbound signing
   secret have different authority; do not reuse either across connections.
2. Implement an HTTPS receiver, including `connection.check` below. Configure the
   signing secret in it before connecting. The URL must not contain credentials,
   a query or fragment; redirects are refused.
3. In Console, choose **Connect a messaging app → Custom app (webhook)**. Enter
   the receiver URL, inbound token and signing secret. Console masks both secrets.
   Switch signs a fresh challenge and requires proof that the receiver has the
   same signing secret. A missing proof, bad credentials or unavailable receiver
   fails setup before saving a connection.
4. Copy the inbound address Console shows:
   `https://YOUR_SWITCH/messaging/bridges/BRIDGE_ID/events`.
   Configure it and the inbound token in your application's backend. The Switch
   deployment must set `MESSAGING_PUBLIC_URL` to its externally reachable HTTPS
   origin.
5. Send `channel.connected`, or the first message in an application channel.
   Switch creates its room. Send `!invite-agent NAME`, then `@NAME hello`.
   Unaddressed messages also reach the room.

Secrets are operator-supplied in the existing connection form; this adapter does
not generate or return secrets through a new Console endpoint. Connection config
uses Switch's existing encrypted credential storage. To rotate, update the
application and connection together during a maintenance window. Signing-secret
rotation changes the namespace of generated outbound message IDs; drain pending
deliveries first.

All receiver requests, including setup, use Switch's outbound URL policy and
guarded HTTP client. Public HTTPS destinations work by default. An operator can
allow a particular private host with `OUTBOUND_ALLOWED_PRIVATE_HOSTS`; metadata
and link-local addresses remain forbidden. TLS verification stays enabled and
DNS is checked at connection time. Do not disable these protections for a demo.

## Version-one contract

The machine-readable schemas live beside the adapter:

- [Incoming schema](../../core/switch_core/bridges/collaboration/webhook/incoming.schema.json)
- [Outgoing schema](../../core/switch_core/bridges/collaboration/webhook/outgoing.schema.json)

Both envelopes use integer `"version": 1`. Unknown versions, unknown fields,
duplicate JSON keys and incorrectly typed fields are rejected. IDs are opaque,
case-sensitive strings of 1–256 characters without whitespace or control
characters. Each message ID must be unique **across the whole connection**,
including all channels. Event IDs must be unique across the connection too.
Retries must retain the original event ID, message ID and content. IDs must not
contain credentials.

### Application → Switch

POST JSON with `Content-Type: application/json` and
`Authorization: Bearer YOUR_INBOUND_TOKEN`. Comparison uses constant-time byte
comparison. Authentication precedes JSON parsing; the route enforces a streaming
size cap before allocating a complete body.

```json
{
  "version": 1,
  "event_id": "delivery-0001",
  "type": "message.created",
  "channel_id": "support",
  "channel_type": "channel_private",
  "channel_name": "Support",
  "sender_id": "user-42",
  "sender_name": "Ada",
  "message_id": "post-123",
  "thread_id": null,
  "text": "@helper Please explain this",
  "attachments": []
}
```

Required fields: `version`, `event_id`, `type`, `channel_id`, `sender_id`,
`sender_name`, `message_id`. `channel_type` defaults to `channel_public`; other
values are `channel_private`, `group` and `direct`. `thread_id` references the
root message's external ID, including a message originally sent by Switch.
Use the root ID on all nested replies. If the root is not stored yet, Switch
returns 503; send the root and retry the reply instead of flattening the thread.

| Type | Meaning |
| --- | --- |
| `message.created` | Import text and/or attachments; an empty message is invalid. |
| `message.updated` | Preserve the correction as an attributed notice in the target's thread. Supply the target `message_id` and new text/files. |
| `message.deleted` | Preserve a deletion notice in the target's thread. No text or files. |
| `channel.connected` | Announce an application channel and create its room. No text or files. Use a unique `message_id` for this announcement. |

**Inbound mutation limitation:** Switch's room transport is append-only. An
update/delete does not rewrite or erase historical room content. The notice
gets its own reference from `event_id`, targeting `thread_id` or `message_id`.
Use distinct mutation event IDs that do not collide with message IDs. The
original content remains in room history. This is not a data-erasure API.
Outbound updates and deletes are actual receiver operations.

Text uses Switch Markdown, including `@agent` mentions. The adapter does not
interpret HTML. A text-only message beginning with `!` is a Switch command.
Native slash commands, reactions, channel provisioning, directory search and
membership provisioning are unsupported. Agent identity is carried in
`sender_name`; the application draws its own avatars.

Attachments are inline; **no attachment URL is fetched**:

```json
{"filename": "notes.txt", "mimetype": "text/plain", "data_base64": "aGVsbG8="}
```

Maximum 4 files, 1 MiB decoded per file, 100,000 text characters and 6 MiB total
request bytes. Base64 must be valid; filenames cannot contain path separators or
control characters. Oversized or invalid inbound attachments reject the whole
event visibly with HTTP 400 (413 for the total body limit). Receivers must treat
all bytes as untrusted files: escape filenames/text, never execute content or
render uploaded HTML, and apply their own download/content-disposition policy.

HTTP responses:

| Code | Sender action |
| --- | --- |
| 200 | Accepted by the callback, or a previously accepted event; stop retrying. |
| 400 | Fix the envelope, schema version or file limit. |
| 401 | Fix the per-connection token; tokens in query parameters are not accepted. |
| 404 | Check the connection ID/address. |
| 413 | Reduce request size. |
| 503 | Retry the **same event**, with exponential backoff and jitter. |

Use a client timeout greater than 30 seconds. Switch confirms after callback
completion, with a 30-second deadline. A callback failure rolls back its receipt
and returns 503. Unique PostgreSQL receipts serialize concurrent copies of an
event on different services. The transport derives durable room event IDs from
the connection/channel/message identity, so repeating a message after a crash
between transport commit and receipt commit writes no second room message.
This requires the sender to retry unacknowledged events; HTTP cannot guarantee
exactly-once side effects in arbitrary downstream systems. Approval answers and
other command side effects retain the guarantees of their existing handlers.

### Switch → application

The receiver gets JSON POSTs with these headers:

```text
Content-Type: application/json
X-Switch-Timestamp: 1790000000
X-Switch-Signature: sha256=HEX_HMAC
Idempotency-Key: EVENT_ID
```

Compute HMAC-SHA256 using the signing secret over
`ASCII(timestamp) + b"." + EXACT_REQUEST_BODY_BYTES`. Compare the `sha256=`
value in constant time **before parsing**. Require the authenticated timestamp
to be within 300 seconds of the receiver clock, rejecting both stale and
future timestamps. Keep clocks synchronized. Do not re-serialize JSON before
verification. The inbound token is never sent outbound.

The timestamp bounds replay age. **Durably deduplicate `event_id` as well**;
otherwise a captured request can be replayed within that window. Commit the
receipt and application change in the same transaction before returning 2xx.

```json
{
  "version": 1,
  "event_id": "stable-operation-id",
  "type": "message.created",
  "channel_id": "support",
  "message_id": "stable-message-id",
  "thread_id": "post-123",
  "sender_name": "helper",
  "text": "Here is the answer.",
  "attachments": [],
  "part": 1,
  "parts": 1
}
```

| Type | Receiver action |
| --- | --- |
| `connection.check` | Verify signature; return the challenge proof described below. Do not display a message. |
| `message.created` | Upsert/assemble a post identified by channel/message ID. |
| `message.updated` | Replace the target's text. |
| `message.deleted` | Delete the target; deleting an absent target succeeds. |
| `activity` | Show ephemeral `is_typing` state for `sender_name`; expire it locally after a short interval. |

`connection.check` includes `challenge`. Return **only** the lowercase hex
HMAC-SHA256 of `b"switch-webhook-check-v1." + challenge.encode("utf-8")`, using
the signing secret, as a 64-byte text/plain response. This proves the receiver
knows the secret without sending that secret over the wire.

Long creates split into parts of at most 8,000 characters. Parts share one
`message_id` and `parts` count, with one-based `part`. Assemble all parts in order
before rendering Markdown so code fences/links spanning boundaries remain valid.
Each part has its own stable event ID. Files use the same inline shape as
inbound; oversized outbound files become a visible explanatory text post.

HTTP requests have a 3-second connect timeout, 10-second socket timeouts and a
12-second overall attempt deadline. Network failures, timeouts, HTTP 429 and
5xx retry up to 3 attempts with 0.25/0.5-second backoff. Other non-2xx responses
fail immediately; redirects fail and are never followed. Response bodies are
not logged; connection proofs are capped at 64 bytes.

Within retries, event IDs and bodies remain identical while timestamps are
refreshed. Transport-backed messages/files also derive message IDs from the
durable source event, preserving identities on lease transfer/restart. A
receiver must retain deduplication receipts for its message retention period
and tolerate repeat upserts. Ephemeral activity and posts outside a transport
delivery do not promise identity across process restarts. The protocol does not
establish a total order across concurrent events; apply updates/deletes in
delivery order and serialize changes to a message in the application.

Approval/question cards use the existing neutral text fallback; answer using
the instructions printed in the card (for example, a request handle and a
decision). No native buttons are registered. The adapter cannot search the
application's history to recover an uncertain card publication after a crash;
Switch discloses that condition and the request remains answerable in Console.
Session cards/status messages use the shared fallback; activity also emits a
signed typing event. Outbound channel/membership management is unsupported:
create and manage the channel in your app.

## Minimal example and demo

The independent [example receiver](../../examples/webhook-chat/app.py) has a
Basic-authenticated browser UI and SQLite receipts/message parts. It verifies
timestamps/signatures and persists changes and receipts atomically. It displays
Markdown source and file names; it does not render rich Markdown or expose a file
download service.

1. Start your development Switch and Console with the normal contributing
   instructions. Set `MESSAGING_PUBLIC_URL` to a trusted HTTPS tunnel to Switch.
2. Generate the inbound token and signing secret above, plus a **third**
   `secrets.token_urlsafe(32)` password for the example UI.
3. Set these environment variables privately (do not record them in a video):

   ```text
   WEBHOOK_SIGNING_SECRET=<outbound signing secret>
   WEBHOOK_INBOUND_TOKEN=<inbound token>
   WEBHOOK_DEMO_PASSWORD=<independent UI password>
   SWITCH_WEBHOOK_URL=https://YOUR_SWITCH/messaging/bridges/PLACEHOLDER/events
   WEBHOOK_DEMO_DB=/absolute/path/to/chat.sqlite3
   ```

4. Run `uv run --project core python examples/webhook-chat/app.py`.
   Expose port 8787 through a trusted HTTPS tunnel, then enter
   `https://YOUR_EXAMPLE_TUNNEL/events` in the Console connection form.
   Setup uses only the signed challenge, so the placeholder Switch URL is fine
   until the connection has been created.
5. Replace `SWITCH_WEBHOOK_URL` with Console's actual inbound address and restart
   the example with the same secrets/database. Open `http://127.0.0.1:8787`,
   sign in as `demo` using the UI password, and send `!invite-agent NAME`, then
   `@NAME hello`. The reply appears in the UI with its agent name and IDs.
6. Paste a root message ID into the thread field and send a reply. Restart
   Switch and the example; send another message. Replaying an old event with
   the same IDs must not create another message.

For the required video: show the platform in Console, the masked connection
form, successful connection/address, room creation/invitation, named agent
reply, threaded reply and a text approval answer. Show the resolved approval in
Switch. Finish with a restart and repeat-delivery check. Keep secrets off screen.
No video or deployed multi-pod validation is bundled with this example; the
automated tests exercise independent service instances sharing PostgreSQL.

## Troubleshooting

- Setup fails: check that `/events` is reachable over valid HTTPS and implements
  `connection.check`; a plain 200 without the HMAC proof is insufficient.
- Inbound 401: confirm the token belongs to this connection, including the
  case-sensitive `Bearer ` prefix.
- Outbound 401: confirm the signing secret and clock; sign/verify raw bytes.
- 503: retry with the original IDs. Check transport/database availability.
  Do not mint another ID to work around a timeout.
- Missing reply: invite the agent and mention its actual name; an unaddressed
  message reaches the room but does not necessarily invoke an agent.
- Missing thread: send its root before replies and use the same root ID across
  both directions. IDs must be unique across channels.
- Private destination refused: ask the deployment operator to allow that
  specific private host; metadata addresses cannot be enabled.

# Add a messaging platform

A messaging platform (Slack, Teams, Telegram, …) connects to Switch through a
**collaboration bridge**. Adding one takes three things and nothing else:

1. **An adapter folder**: `core/switch_core/bridges/collaboration/<key>/`
2. **One registration line** in `core/switch_core/bridges/collaboration/platforms.py`
3. **A docs page**: `docs/messaging-platforms/<key>.md`

You don't edit Console, telemetry, the session contract or the gateway. They
all read what your adapter declares about itself. If you find yourself editing
one of them for your platform, stop and ask in the PR: it means something is
still hardcoded and should be fixed once for everyone.

`core/tests/switch_core/bridges/collaboration/dummy_platform/` is a complete
minimal example of both kinds of platform (one that dials out, one that
receives webhooks). Read it alongside this page.

## 1. Pick a key

The key identifies your platform everywhere: a bridge's `type`, a telemetry
value, the surface recorded on an answered approval card. It must be 2-32
characters long, use only lowercase letters, digits and underscores, and start
with a letter. Examples: `google_chat`, `whatsapp`, `email`. Registration
refuses anything else.

## 2. The adapter folder

```
core/switch_core/bridges/collaboration/<key>/
  __init__.py
  adapter.py   # the adapter and its connection config
  icon.svg     # the platform's logo
```

### The connection config

A pydantic model that subclasses `BridgeConnectionConfig`. Its fields *are* the
connect form: Console builds the form from this model's JSON schema, so the
field titles, descriptions and defaults are what an operator sees.

- Console masks a field whose name contains `token`, `password`, `secret`,
  `api_key`, `private_key` or `credential`. For any other secret field, add
  `Field(json_schema_extra={"format": "password"})`.
- Hide fields that shouldn't appear on the form with `SkipJsonSchema[...]`.
- Validate early. A config the adapter can't use should fail here, not at
  start.

### The adapter

Subclass `PlatformAdapter` (`bridges/collaboration/adapter.py`). The lifecycle
builds it as `YourAdapter(config=<your validated config>)`.

**Declare who you are.** All of these are class attributes:

| Attribute | Required | What it does |
|---|---|---|
| `display_name` | yes | How a person names the platform ("Microsoft Teams"). Console labels it with this, and cards say an answer came "from" it. Registration refuses an adapter without one. |
| `docs_slug` | no | The page under the published messaging-apps docs. Leave it `None` until the page is published there; Console then links to the docs index. |
| `icon.svg` | no | Shipped in your folder and served to Console, which draws it as an image. Without one Console uses a generic icon. Rename it with `icon_file` if you must. |

**Implement the basics.** These are abstract and every platform must provide
them:

- `start(on_message, on_command, on_agent_joined, on_user_joined, on_app_joined)`
  and `stop()`: connect, and hand inbound events to those callbacks.
- `send_message`, `update_message`, `delete_message`, `send_typing`: post as an
  agent, edit, delete and show typing.
- `create_channel`, `get_channel_type`, `add_agents_to_channel`,
  `add_users_to_channel`, `get_channel_agent_names`: channels and membership.
- `create_agent_identity`, `remove_agent_identity`: give an agent its own name
  and avatar on the platform, where the platform allows it.
- `translate_inbound` and `_render_outbound`: convert between the platform's
  markup and Switch Markdown.

**Everything else has a working default.** Admin messages, approval and
question cards, attachments, reactions, deeplinks and directory search all fall
back to plain text, or say clearly that they're unsupported. Override one only
when the platform can do better. Read the docstring of each method before
overriding it: many spell out guarantees the callers rely on.

**Switch off what the platform can't do.** Capability flags are class
attributes, so Switch and Console can answer before a connection exists:

| Flag | Default | Set it to False when |
|---|---|---|
| `supports_channel_creation` | True | the bot can't create a chat (Telegram) |
| `supports_directory_search` | True | the bot can only see people who have spoken to it |
| `renders_custom_url_schemes` | True | the platform only linkifies http(s) |
| `draws_session_activity` | False | set it to True only if you implement the rich session cards |

There are more flags (reactions, mentions, recovery). Each one is documented
where it is declared.

**Say what your failures mean.** When a bridge fails, telemetry reports one of
`auth_failed`, `network`, `platform_error`, `config_invalid` or `unknown`.
There are two ways to get this right:

- Raise `BridgeCredentialError` when the platform rejects the credentials, and
  `BridgeOperationError` when it refuses an operation. Both are classified for
  you.
- Or override `classify_failure(exc)` to map your SDK's own exceptions, and
  return `None` for anything that isn't yours.

Never classify by matching words in an exception's message or class name.

**Check credentials before saving.** Override `verify_credentials(config)` to
make a cheap authenticated call and raise `BridgeCredentialError` with the
platform's explanation. Without it, a wrong token looks like success and fails
hours later. If your config contains URLs that Switch itself calls, also
override `outbound_urls(config)` so the deployment's outbound policy can check
them.

**Links must be https.** `channel_deeplink` and `home_deeplink` must return
https URLs. Console opens only http(s) links for platforms it has no
special handling for.

## 3. Receiving events over webhooks (optional)

Some platforms can't keep a connection open to Switch: email, SMS, WhatsApp,
Google Chat. Instead they call an address for every event. To support that:

1. Set `receives_webhooks = True`.
2. Implement `verify_webhook(request)`. Check the request against **this
   connection's own secret**, from your config: an HMAC header over
   `request.body`, a signed token, or a token in the query string for a GET
   address check. Raise `WebhookAuthenticityError` if it doesn't prove itself.
   Don't read or log the body before this passes.
3. Implement `parse_webhook(request)`. It returns an `InboundWebhook`:
   - Set `external_event_id` to the platform's delivery id. That is what makes
     a retried delivery recognisable, so it's handled once.
   - For a request that is the platform checking the address (a challenge to
     echo back), set `handshake` to the text to answer with, and nothing is
     dispatched.
   - Raise `WebhookPayloadError` for a body you can't read.
   - No I/O here.
4. Implement `dispatch_event(envelope_type, payload)`. It runs in the
   background, after the platform has been answered. Turn the payload into
   `InboundMessage` etc. and call the callbacks you were given in `start`.

Each connection then receives events at:

```
https://<MESSAGING_PUBLIC_URL>/messaging/bridges/<bridge id>/events
```

Switch shows that address on the connection, for the operator to paste into
the platform's settings. Both GET and POST reach your adapter. Switch answers
immediately and hands the event over in the background, so a slow agent turn
never makes the platform time out and retry.

### Exposing it over public HTTPS

The platform calls that address from the internet, so the deployment needs:

- `MESSAGING_PUBLIC_URL` set to the public origin (scheme and host, no path,
  must be https). This is the same setting the one-click Slack app uses.
  Without it, the connection shows no address.
- The `/messaging` path prefix routed to switch-core (port 8000) on that host,
  with a browser-trusted certificate. If you already route it for the Slack
  app, you're done; see `deploy/remote/helm/switch/samples/ingress.example.yaml`.
- For local development, a tunnel works: `cloudflared tunnel --url
  http://localhost:8000` or `ngrok http 8000`. Set `MESSAGING_PUBLIC_URL` to the
  https URL it prints.

Status codes are answered for the platform's retry logic: 200 when handled,
401 for a bad signature, 400 for an unreadable body, 404 for an address with no
webhook bridge behind it, and 503 (retry later) while the bridge is stopped.

## 4. Register it

Add one line to `PLATFORMS` in
`core/switch_core/bridges/collaboration/platforms.py`:

```python
PlatformRegistration("google_chat", GoogleChatAdapter, GoogleChatConnectionConfig),
```

That publishes your platform to the gateway's platform list (and so to
Console's connect form, labels and icons), to telemetry, and to the session
renderers.

## 5. Tests

Put them in `core/tests/switch_core/bridges/collaboration/test_<key>_*.py`. At a
minimum:

- **Config**: valid configs parse; each invalid one is refused with a clear
  message.
- **Inbound**: a representative platform payload becomes the right
  `InboundMessage` (channel, sender, text, thread, attachments), and your own
  bot's messages are ignored.
- **Outbound**: `send_message`, `update_message` and `delete_message` make the
  right platform calls, with markup rendered by `_render_outbound`.
- **Failures**: `classify_failure` maps your SDK's real exception types
  (construct the real classes, don't guess them).
- **Webhooks**, if you receive them: a correctly signed request is accepted,
  one signed with another secret is refused, a malformed body is refused, a
  retried delivery carries the same `external_event_id`, and the address check
  echoes its challenge.

Mock the platform's HTTP API at the transport level, not the adapter's own
methods. `test_platform_self_contained.py` shows how to drive the webhook
route end to end.

## 6. The docs page

Write `docs/messaging-platforms/<key>.md` for the operator connecting it:

- what to create on the platform side (app, bot, token), step by step
- which permissions or scopes it needs, and why
- what each connection field means
- for webhook platforms: where to paste the address, and the HTTPS requirement
  above
- what doesn't work on this platform (the capability flags you turned off)

Once the page is published on the docs site, set `docs_slug` to its slug.

## Opening the PR

Use the **messaging platform** PR template: append
`?template=messaging_platform.md` to the compare URL, or pick it from the
template list. It asks for the QA checklist and a recording of the platform
working end to end.

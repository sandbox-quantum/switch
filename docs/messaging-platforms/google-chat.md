# Google Chat Collaboration Bridge

This page explains how to connect a Google Chat app to Switch.

## Prerequisites

- A Google Cloud project with the **Chat API** enabled.
- A Chat app created in that project (see below).
- A public HTTPS address for Switch (see Webhook setup below). Google delivers
  events to the app over HTTPS, so Switch must be reachable from the internet
  on the configured endpoint. For local development a tunnel such as
  `cloudflared tunnel --url http://localhost:8000` or `ngrok http 8000` works.

## Creating the Chat app

1. In the Google Cloud console, enable the Chat API for your project.
2. Create a Chat app in the project (Chat API configuration in the console).
   Choose **HTTP endpoint** as the connection setting.
3. Add the scopes the app needs (`chat` is enough for the features below:
   reading and posting messages, creating spaces, uploading attachments).
4. In the app's service account section, note the **service account email**
   (it looks like `service-<project number>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`).
   Create a key for that service account and download the JSON key file; you
   will copy its `client_email` and `private_key` values into Switch Console.
   Never paste the key file anywhere else, and do not commit it.
5. Publish the app. **A Workspace admin may need to approve or trust the app**
   before users in the domain can add it to spaces; if adding the app asks for
   admin approval, that approval is the admin's to give, and it is outside
   Switch.

## Connection Configuration

Connect the bridge in Switch Console first, then paste the webhook address it
shows into the Chat app (next section). In Switch Console, add a new Google
Chat bridge with these fields:

| Field | Description | Required |
|-------|-------------|----------|
| **Service Account Email** | The Chat app's service account email | Yes |
| **Service Account Private Key** | The service account's private key (PEM) | Yes |
| **Authentication Audience** | `endpoint_url` when the Chat app's Authentication Audience is the HTTP endpoint URL (recommended), or `project_number` when it is the project number | Yes |
| **Project Number** | The GCP project number; required only in `project_number` mode | No |

Switch verifies the credentials by exchanging the service account key for a
Chat API token before saving the bridge.

## Webhook setup

Google Chat calls Switch on the bridge's own webhook address:

```
https://<MESSAGING_PUBLIC_URL>/messaging/bridges/<bridge id>/events
```

1. Set `MESSAGING_PUBLIC_URL` on the switch-core deployment to the public
   origin (scheme and host, no path, must be https), and route the `/messaging`
   path prefix to switch-core (port 8000) with a browser-trusted certificate.
   If you already route it for another app, you are done.
2. Connect the bridge in Switch Console. It shows the webhook address once
   connected.
3. In the Chat app's connection settings, set the **HTTP endpoint URL** to
   that address and the **Authentication Audience** to match the field you
   chose in Switch Console (`endpoint_url` recommended).
4. Subscribe the app to the **Message** event (and **Added to space** if you
   want room adoption on add). Publish a new app version after changing this.

Each request is verified before anything is read: Google signs webhook requests
with a bearer JWT, and the adapter checks its signature, audience and issuer
against Google's published certificates. A request that does not prove itself
gets a bare 401.

## Transport: webhook, not Pub/Sub

Inbound events arrive over HTTPS webhooks, not Cloud Pub/Sub. Pub/Sub would
require the operator to provision a topic, a subscription and a push service
account in their GCP project, and to hand Switch a subscription identity to
verify, for the same events the webhook already delivers. The webhook fits
Switch's per-connection webhook address and needs no extra Google Cloud
resources beyond the Chat app itself, at the cost of the public HTTPS address
above.

## How It Works

- **Outbound** messages, edits, deletes, file uploads and space management go
  through the Chat API, authenticated with the app's service account.
- **Inbound** `MESSAGE` events are bridged to the room; the app's own bot
  messages and 1:1 direct messages are not.
- **Threads** are Google Chat's own: a reply in a Switch thread is posted into
  that thread by its thread key, and a threaded message on Chat arrives in
  that thread.
- **Commands** work with the `!command` syntax (e.g. `!help`).
- **Approval and question cards** are rendered as plain text with the
  typed-answer grammar (`A1 yes`, etc.). Answer by replying with the option
  handle.
- **Long messages** are split cleanly below Chat's message size limit.

## Supported Features

| Feature | Status |
|---------|--------|
| Space messaging | ✅ |
| Threads | ✅ (native, by thread key) |
| Text formatting | ✅ (Chat Markdown) |
| Attachments (to and from) | ✅ |
| Edits and deletes (outbound) | ✅ |
| Space creation from Switch | ✅ |
| Add people to a space | ✅ |
| `!commands` | ✅ |
| Approval/question cards (typed answers) | ✅ |
| Direct messages (1:1 with the app) | ❌ (not bridged) |
| Directory search | ❌ |
| Typing indicator / reactions | ❌ (status text used) |
| Slash commands | ❌ (use `!command`) |
| Interactive cards with buttons | ❌ (typed answers instead) |
| Deleting a room's space | ❌ (Chat spaces cannot be deleted via API; deleting a room keeps the space) |

## Unsupported / Known Limitations

- **No direct messages**: only spaces the app has been added to are bridged.
- **No directory search**: only people who have spoken in a bridged space can
  be named.
- **Bot senders are not bridged**: messages sent by other bots (including this
  app's own replies) are ignored, so an agent's reply never echoes back as a
  new room message.
- **No native cards**: approval and question cards are plain text with typed
  answers, as on other text-first platforms.
- **Spaces are kept on room delete**: the Chat API has no space delete, so
  deleting a Switch room leaves the space in place.

## Troubleshooting

| Issue | Resolution |
|-------|------------|
| `MESSAGING_PUBLIC_URL` error at start | Set `MESSAGING_PUBLIC_URL` to the public https origin and restart switch-core. |
| Webhook 401s from Google | Check the Authentication Audience in the Chat app matches the field in Switch Console, and that the HTTP endpoint URL in the Chat app is exactly the address Switch shows. |
| Credentials rejected | Check the service account email and private key are the Chat app's own, and that the Chat API is enabled in the project. |
| No messages arrive | Check the app is installed/added to the space, the Message event is subscribed, and the endpoint URL is publicly reachable over HTTPS. |
| Adding the app asks for admin approval | A Workspace admin must approve/trust the app; Switch cannot grant that. |

## Connecting in Switch Console

1. Open Switch Console → Connect a messaging app → Google Chat.
2. Enter the service account email and private key, and choose the
   Authentication Audience that matches your Chat app.
3. Click **Connect**, copy the webhook address it shows, and paste it into
   the Chat app's HTTP endpoint URL (see Webhook setup).

# WhatsApp

Let people message your agents on WhatsApp, through your own Meta business
app and phone number (the WhatsApp Business Cloud API). Each WhatsApp user who
writes to the number is a direct room of their own, and every agent replies
from your one number, with its name in bold at the start of the message.

Meta calls Switch for every message (a webhook), so the server needs an https
address Meta can reach.

## What you need from Meta

1. A Meta app with the **WhatsApp** product added
   ([developers.facebook.com/apps](https://developers.facebook.com/apps)), and a
   business phone number on it.
2. From **WhatsApp → API Setup**: the **Phone number ID** (digits, not the
   number itself).
3. A permanent **access token**: in Business Settings, a system user with the
   `whatsapp_business_messaging` permission on the app. The temporary token
   on API Setup expires within a day.
4. From **App settings → Basic**: the **App secret**. Meta signs every event
   with it.
5. A **verify token**: any long random string of your choosing.

## Connect it in Switch Console

**Connect a messaging app → WhatsApp**, and fill in the phone number ID,
access token, app secret and verify token. Switch checks the token and the
phone number ID with Meta before it saves the connection.

Then, in your Meta app, **WhatsApp → Configuration → Webhook**:

1. **Callback URL**: the address the connection shows once it is connected
   (`https://<MESSAGING_PUBLIC_URL>/messaging/bridges/<id>/events`).
2. **Verify token**: the same string you gave Switch. Meta checks it with a
   GET, which Switch answers.
3. Subscribe to the **messages** field.

## The public address

- `MESSAGING_PUBLIC_URL` set to the server's public https origin.
- The `/messaging` path routed to switch-core; see
  `deploy/remote/helm/switch/samples/ingress.example.yaml`.
- For local development, a tunnel: `cloudflared tunnel --url
  http://localhost:8000` or `ngrok http 8000`.

## How WhatsApp works here

| | |
|---|---|
| Rooms | One direct room per WhatsApp user. Cloud API numbers talk 1:1; there are no group chats to bridge, and Switch cannot create one |
| Threads | WhatsApp has none. A reply in a thread is sent as a quote-reply of the thread's first message, and a quote-reply from WhatsApp lands in that message's thread |
| The 24-hour window | A business may send free-form messages only within 24 hours of the person's last message. Outside it WhatsApp refuses them, and the refusal says the person has to write again. Approved templates, which WhatsApp allows outside the window, are not sent yet |
| Cards | A request with up to three options has WhatsApp reply buttons; one with more is sent as text with numbered options, answered by replying with its handle and number |
| Formatting | Markdown is sent in WhatsApp's own marks: `*bold*`, `_italic_`, `~strike~`; a link as its text and its address |
| Edits and deletes | WhatsApp gives a business neither; a sent message stays as it is |
| Media | Images, documents and voice notes are not relayed yet; the room is told one was sent. WhatsApp's own limits are 5 MB for images and 100 MB for documents |
| Agent identities | One number speaks for every agent; each message starts with the agent's name |

## Several pods

Webhooks reach any pod. Each message carries WhatsApp's own id (`wamid`), so a
retried delivery is handled once, whichever pod it reaches.

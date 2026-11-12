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
access token, app secret and verify token. Before it saves the connection,
Switch checks each with Meta and says which one is wrong:

- the token: valid, not expired, and allowed `whatsapp_business_messaging`;
- the phone number ID: readable with that token;
- the app secret: Meta refuses a request signed with another app's secret, so
  a mistyped secret is caught here rather than when every event is refused.

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
| The 24-hour window | A business may send free-form messages only within 24 hours of the person's last message. WhatsApp refuses one outside it either at once, when Switch reports the post as failed and says the person has to write again, or a moment later in a `failed` status, which switch-core logs as an error with the same explanation. Approved templates, WhatsApp's way to write outside the window, are not sent |
| Cards | A request with up to three options has WhatsApp reply buttons, and one with four to ten a list (WhatsApp's own picker). A button or list choice answers the card. A card with more options, or one WhatsApp refuses, is sent as text with numbered options, answered by replying with its handle and number |
| Working | While an agent works on a message, Switch reacts to it with 👀, marks it read and shows "typing…", and takes the reaction off when the turn ends. Every agent shares the one reaction, as they share the number. A turn's step-by-step status is not sent, since WhatsApp cannot redraw a sent message; a turn that fails is said once |
| Long replies | Split under WhatsApp's 4,096 characters at a line or a word; a code block cut in two is closed and opened again |
| Formatting | Markdown is sent in WhatsApp's own marks: `*bold*`, `_italic_`, `~strike~`; a link as its text and its address. A message from WhatsApp reaches the room in Markdown, its code left as it is |
| Senders | A person is their phone number, or, for someone who hides it behind a WhatsApp username, the business-scoped id Meta gives instead, which replies are addressed to (`recipient`). Group chats are not relayed, and the skip is logged |
| One number per app | A Meta app has one webhook address, so give each number its own Meta app. An event for a number other than the connection's is dropped and logged |
| Edits and deletes | WhatsApp gives a business neither; a sent message stays as it is |
| Media from WhatsApp | Images, videos, voice notes, stickers and documents reach the room as files, with their caption as the message. One over the server's attachment limit, or one that will not download, is named in the room with the reason. A shared location or contact arrives as a line saying what it was |
| Media to WhatsApp | JPEG and PNG go as images (up to 5 MB), MP4 and 3GPP as videos and AAC, AMR, MP3, MP4 and Ogg audio as voice (up to 16 MB), anything else as a document with its name (up to 100 MB). A file over its limit, or one WhatsApp refuses, is not sent: the person gets a message naming it and saying why |
| Agent identities | One number speaks for every agent; each message starts with the agent's name |

## App secret proof

Every call Switch makes to Meta carries `appsecret_proof`, so you can turn on
**App settings → Advanced → Require app secret** in your Meta app.

## Several pods

Webhooks reach any pod. Each message carries WhatsApp's own id (`wamid`), so a
retried delivery is handled once, whichever pod it reaches.

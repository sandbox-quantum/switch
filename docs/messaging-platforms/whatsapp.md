# WhatsApp

Connect a WhatsApp Business phone number to Switch, so people who write to that
number reach a Switch room and its agents, and the agents answer in the chat.

Switch uses the **WhatsApp Business Cloud API** on **your own Meta app and
phone number**. You create the app, add WhatsApp to it, and paste five values
into Switch Console. Meta then delivers each message to Switch's webhook
address for the connection.

## What you need

- A [Meta developer account](https://developers.facebook.com/) and a Meta
  business portfolio (Meta creates one with the app if you have none).
- A Switch deployment that Meta can reach over **https** (see
  [The webhook address](#the-webhook-address)).
- For testing: Meta's free test number, plus your own WhatsApp number added as
  a test recipient. For production: a phone number you own that isn't already
  registered with the WhatsApp app.

## 1. Create the Meta app

1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps)
   and choose **Create app**.
2. For the use case, pick **Connect with customers through WhatsApp** (older
   flows: app type **Business**). Attach it to your business portfolio.
3. In the app dashboard, open **WhatsApp → API Setup**. Meta gives the app a
   **test phone number** and lets you add up to five recipient numbers. Add
   your own WhatsApp number there and confirm the code Meta sends to it.

## 2. Collect the five connection values

| Connection field | Where to find it | Why Switch needs it |
|---|---|---|
| **Access token** | A permanent token: **Business settings → Users → System users**. Add a system user (Admin), assign it the app and the WhatsApp account, then **Generate new token** with `whatsapp_business_messaging` and `whatsapp_business_management`. The temporary token on **API Setup** also works but expires after 24 hours. | Sends messages, uploads and downloads files, and marks messages read. `whatsapp_business_messaging` covers sending and media; `whatsapp_business_management` lets Switch read the phone number back to check the token when you save. |
| **App ID** | **App settings → Basic → App ID**. | Meta sets the webhook address per app, not per number, so one app can be connected to Switch only once. Switch checks that the token was issued for this app when you save. |
| **Phone number ID** | **WhatsApp → API Setup**, the numeric **Phone number ID** under the *From* number. This is an ID, not the phone number itself. | Every Graph API call is made for this number. |
| **App secret** | **App settings → Basic → App secret** (choose *Show*). | Meta signs every webhook with it. Switch refuses any webhook that isn't signed with it, and checks the secret against the token when you save. Every Graph API call carries an `appsecret_proof` made with it, so **Require App Secret** (App settings → Advanced) can be turned on. |
| **Verify token** | Any string you choose, for example from `openssl rand -hex 16`. | Meta sends it back when it checks the webhook address, which proves the address is yours. |

Console masks the token, the secret and the verify token. Leading and trailing
spaces are removed, and an empty field is refused before anything is saved.

## 3. Connect it in Switch Console

1. Open **Connect a messaging app** and choose **WhatsApp**.
2. Fill in the five fields and connect. Switch asks Meta which app the token
   was issued for, using the App ID and app secret, then reads the phone
   number back with the token. A wrong token, App ID, phone number ID or app
   secret fails here, with Meta's own explanation and error code.
3. Once connected, Console shows the connection's **webhook address**. Copy it.

## The webhook address

Meta delivers each message to:

```
https://<MESSAGING_PUBLIC_URL>/messaging/bridges/<bridge id>/events
```

To use it:

- `MESSAGING_PUBLIC_URL` must be set to the deployment's public **https**
  origin (scheme and host, no path). Without it the connection shows no
  address and **refuses to start**, because no message could ever arrive.
- The `/messaging` path has to reach switch-core (port 8000) with a
  browser-trusted certificate. Meta refuses self-signed certificates.
- For local development, a tunnel works: `cloudflared tunnel --url
  http://localhost:8000` or `ngrok http 8000`. Set `MESSAGING_PUBLIC_URL` to
  the https URL it prints, then restart switch-core.

In the Meta app dashboard:

1. Open **WhatsApp → Configuration → Webhook → Edit**.
2. Set **Callback URL** to the address Console showed, and **Verify token** to
   the same string you entered in Switch. Choose **Verify and save**. Meta
   sends a check to the address, and Switch answers it only if the verify
   token matches.
3. Under **Webhook fields**, subscribe to **`messages`** only. Switch reads
   no other field: a delivery for one is acknowledged and ignored, with a
   warning in the switch-core log naming the field.

Send a message from your WhatsApp to the business number. Its room appears in
Switch.

## How it behaves

- **One chat per person.** Each person who writes to the number gets a direct
  room. Their name in the room is their WhatsApp profile name joined up, plus
  their WhatsApp id, so two people with the same name never share an identity.
- **Agents reply under their name.** Every agent sends from the one business
  number, which WhatsApp shows under the business profile's name. So the
  agent's name is put in bold at the start of each message.
- **Formatting is converted.** Switch Markdown becomes WhatsApp's markup:
  `**bold**` → `*bold*`, `~~strike~~` → `~strike~`, headings → bold lines,
  code fences → triple backticks. A link becomes `label (https://…)`, because
  WhatsApp only links bare http(s) URLs. Incoming WhatsApp markup is converted
  back to Markdown.
- **Long replies are split.** A reply over WhatsApp's 4,096-character limit is
  sent as several messages, split at paragraph, line or word breaks. A code
  block split in two is closed and reopened.
- **`!commands` work.** A message starting with `!` (for example `!help`) is a
  Switch command. WhatsApp has no slash-command menu.
- **Working state.** While an agent works on a message, Switch reacts to it
  with 👀 and shows WhatsApp's typing indicator, which WhatsApp clears on the
  reply or after 25 seconds. Each incoming message is also marked read (blue
  ticks).
- **Approvals and questions** are posted as text, naming a handle such as
  `A1` and the answers it takes. To answer, type the handle and your answer
  (`A1 approve`). A reply without the handle, such as a bare `yes`, isn't
  taken as an answer, even when it quotes the card. WhatsApp's buttons aren't
  used, and nothing in the chat confirms an answer that landed: the agent
  carrying on is the sign.
- **Duplicates and restarts.** Meta retries a delivery it thinks failed. Each
  message is recognised by its WhatsApp id (`wamid`), so a retry is handled
  once, on whichever Switch instance receives it.

## Files

Files are relayed both ways, as WhatsApp's own image, video, audio or document
messages. WhatsApp's size limits:

| Kind | Types | Limit |
|---|---|---|
| Image | JPEG, PNG | 5 MB |
| Audio | AAC, AMR, MP3, M4A, OGG (Opus) | 16 MB |
| Video | MP4, 3GPP (H.264 with AAC) | 16 MB |
| Document | anything else | 100 MB |
| Sticker (incoming only) | WebP | 100 KB static, 500 KB animated |

A file over its limit is not sent. Instead the chat gets a message naming the
file, its size and the limit. A file WhatsApp refuses (for example, an
unsupported codec) is reported the same way, with WhatsApp's reason. An
incoming file larger than the deployment's attachment limit, or one that can't
be downloaded, is reported in the room rather than dropped. Audio messages take
no caption, so the caption goes in a message just before the file.

## What WhatsApp can't do

- **The 24-hour customer-service window.** A business can send free-form
  messages only within 24 hours of the person's last message. Outside that
  window WhatsApp allows only pre-approved *template* messages, and **Switch
  doesn't send templates**. A reply sent outside the window is refused by
  WhatsApp (error `131047`). Switch records it as a failed send with an
  explanation and doesn't retry it. The window reopens as soon as the person
  writes again. Today the explanation appears in the switch-core log, not in
  the room.
- **No threads.** A reply in a Switch thread quotes the message it answers.
  When someone quote-replies in WhatsApp, the quoted message is the thread
  root.
- **No edits or deletes.** WhatsApp can't edit or delete a sent message. An
  edit or delete in Switch doesn't reach the chat. A request card isn't
  updated once it's answered. If someone answers it late, the answer is
  refused with a reply saying so.
- **One-to-one only.** Group chats aren't bridged. Group messages are ignored
  and logged.
- **No channel creation.** Only the person can start a chat. Switch can't
  create one or add people to it.
- **No directory search.** The business knows only the people who have
  written to it, so they can't be searched for before they write.
- **Only http(s) links.** Links to Switch Console are rewritten to the
  gateway's https address when `GATEWAY_PUBLIC_URL` is set.
- **One connection per Meta app.** A Meta app has one webhook address. Connect
  each phone number on its own app; events for a number the connection isn't
  for are ignored and logged.

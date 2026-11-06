# SMS (Twilio)

Connect a Twilio phone number to Switch, so people who text that number reach a
Switch room and its agents, and the agents answer by text.

Switch uses **your own Twilio account and number**. You paste your credentials
into Switch Console, and Twilio delivers each text to Switch's webhook address
for the connection. Every text costs money, so read
[Keeping costs bounded](#keeping-costs-bounded).

## What you need

- A Twilio account, upgraded from trial. Trial accounts can only message
  verified numbers and don't support custom message bodies.
- A Twilio phone number that can send SMS.
- A Switch deployment Twilio can reach over **https** (see
  [The webhook address](#the-webhook-address)).
- For a number that texts US phones: **A2P 10DLC** registration for a US long
  code, or **toll-free verification** for a toll-free number. Without it, carriers
  block the text (Twilio errors `30034` and `30032`), and Twilio may still bill
  for the attempt. Other countries have their own rules; see Twilio's
  [SMS guidelines](https://www.twilio.com/en-us/guidelines) for the destination.

## 1. Get a number

In the [Twilio Console](https://console.twilio.com/), open **Phone Numbers →
Manage → Buy a number**, and pick one with the **SMS** capability. A number that
belongs to a Messaging Service with its own incoming-message webhook uses that
webhook instead, so configure the address there.

## 2. Collect the connection values

| Connection field | Where to find it | Why Switch needs it |
|---|---|---|
| **Account SID** | **Account Dashboard → Account Info**. Starts with `AC`. | Every Twilio API call is made for this account. |
| **Auth Token** | The same page. Use the **primary** token. | Sends messages, fetches files people send, and proves webhooks: Twilio signs each one with it, so an API key can't replace it. |
| **Twilio phone number** | **Phone Numbers → Active Numbers**, such as `+14155550100`. | The number people text and agents text from. |
| **Allowed phone numbers** | The phone numbers of the people who may use this, in international format, separated by commas. | Texts from any other number are ignored without a reply, and no other number is ever texted. |
| **Agent** | The name of an agent in Switch. | Added to the room when someone texts for the first time. If no agent has this name, the room has no agents, and Switch texts a notice saying so. |
| **Most SMS segments per reply** | Optional, defaults to 5. | See [Keeping costs bounded](#keeping-costs-bounded). |
| **Most SMS segments per number, per hour** | Optional, defaults to 20. | See [Keeping costs bounded](#keeping-costs-bounded). |

Console masks the Auth Token. When you save, Switch checks that the Account SID
and Auth Token open an active account, and that the number is on that account and
can send SMS. A failure shows Twilio's own explanation.

If you rotate the Auth Token in Twilio, update it in Switch at the same time.
Until then Switch refuses every webhook, because the signatures no longer match.

## 3. Connect it in Switch Console

1. Open **Connect a messaging app** and choose **SMS (Twilio)**.
2. Fill in the fields and connect.
3. Once connected, Console shows the connection's **webhook address**. Copy it.

## The webhook address

Twilio delivers each text to:

```
https://<MESSAGING_PUBLIC_URL>/messaging/bridges/<bridge id>/events
```

To use it:

- `MESSAGING_PUBLIC_URL` must be set to the deployment's public **https** origin
  (scheme and host, no path). Without it the connection shows no address and
  **refuses to start**, because no text could ever arrive.
- The `/messaging` path has to reach switch-core (port 8000) with a
  browser-trusted certificate.
- For local development, a tunnel works: `ngrok http 8000` or `cloudflared tunnel
  --url http://localhost:8000`. Set `MESSAGING_PUBLIC_URL` to the https URL it
  prints, then restart switch-core. If the tunnel's address changes, the
  signatures stop matching, so paste the new address into Twilio too.

In the Twilio Console:

1. Open **Phone Numbers → Active Numbers** and choose the number.
2. Under **Messaging Configuration → A message comes in**, choose **Webhook**,
   paste the address exactly as Console showed it, and choose **HTTP POST**.
3. Under **Primary handler fails**, paste the same address again. Twilio doesn't
   retry a text whose webhook answered with an error, which Switch does while
   the connection restarts; the fallback gets one more try.
4. Save.

Switch doesn't set this for you, because the number may already serve another
application and changing it would silently cut that application off. Removing
the connection doesn't clear it either.

To try it without a phone, use Twilio's **Messaging → Virtual Phone**, and add
its number to the allowed numbers. Texts between your number and the Virtual
Phone reach the webhook and don't need carrier registration.

## How it behaves

- **One conversation per phone number.** Each allowed number gets its own direct
  room, with the configured agent. The room shows only the last four digits of
  the number.
- **Texting someone first.** Bind a room to an allowed number, by its
  international format, and agents in that room can text it. Any other number is
  refused.
- **Link your number to your Switch user.** An agent that takes instructions only
  from its owner refuses a number nobody has linked, and texts back saying so. Once
  the number has texted, link it under **Messaging apps** in Console, by searching
  for `sms-` and its last four digits.
- **Agents reply under their name.** Every agent texts from the one number, so
  the agent's name opens each message. With one agent in the room, a text reaches
  it without a mention. With several, name one with `@name`; other texts still
  reach the room.
- **Formatting comes off.** SMS is plain text, so Markdown marks are removed and a
  link becomes `label (https://…)`.
- **Long replies are split** at paragraph, sentence, line or word breaks.
- **`!commands` work.** A text starting with `!` (for example `!help`) is a Switch
  command, and its result costs a text like any other. There are no slash commands.
- **Approvals and questions** are texted, naming a handle such as `A1` and the
  answers it takes. To answer, text the handle and your answer (`A1 1`). A bare
  `yes` or `1` isn't taken as an answer, and the agent keeps waiting until the
  request is answered. An answer is also relayed to the room as an ordinary
  message, so an agent may reply to it as well, and that reply costs a text.
- **Failed deliveries.** Switch asks Twilio to report each text's delivery. A text
  that failed is logged in switch-core with Twilio's error code. It isn't shown in
  the room.
- **Duplicates and restarts.** Each text is recognised by its Twilio `MessageSid`,
  so a retry is handled once, on whichever Switch instance receives it. Switch
  keeps nothing a second instance needs, except the hourly count below.

## Keeping costs bounded

Twilio bills per **segment**, and prices vary a lot by destination, so check
[Twilio's pricing](https://www.twilio.com/en-us/sms/pricing). A text fits 160
characters in one segment. A longer one is split, with about 153 characters a
segment. One character outside the GSM-7 alphabet, such as an emoji or a non-Latin
letter, reduces that to 70, and 67 once split, for the whole text. Twilio refuses
a text over 1,600 characters, or 700 in that second encoding. To stay in the
cheaper encoding, Switch replaces curly quotes, long dashes and similar
punctuation with plain ones. Emoji and other scripts are left as they are.

Four things limit the cost:

1. **Allowed numbers.** A stranger's text costs you only Twilio's inbound fee,
   since it gets no reply.
2. **Segments per reply.** A longer reply is cut at a sentence break and ends with
   a note pointing to Switch Console. The whole reply stays in the room.
3. **Segments per number, per hour.** This stops an agent stuck in a loop. Past
   the limit, Switch texts one notice and sends nothing more to that number until
   the hour frees up. That includes texts saying an agent ran into a problem, and
   request cards, which stay answerable in the room. **This count is kept in
   memory**: each Switch instance counts separately, and a restart resets it, so
   more can get through than the limit.
4. **A Twilio usage trigger.** Because of that, also set a hard limit in Twilio:
   **Monitor → Usage Triggers**, or a low balance with auto-recharge off.

## Opting out

Twilio handles `STOP` and its other opt-out words itself: it replies to the person
and refuses further texts to them (error `21610`) until they text `START`. Switch
doesn't pass these words to agents: `stop`, `stopall`, `unsubscribe`, `cancel`,
`end`, `quit`, `revoke`, `optout`, `start`, `unstop`, `help` and `info`, when
sent as the whole text. A text to someone who has opted out is not sent and not
retried. It stays in the room, but nothing there says it didn't reach the phone:
only the server log does, as an error. Make sure
everyone on your allowed list has agreed to receive texts.

## Files

- **Incoming** files (MMS) reach the room. A file over the deployment's attachment
  limit, or one that can't be downloaded, is reported in the room instead of being
  dropped. Twilio keeps its own copy until you delete it from your account.
- **Outgoing** files aren't sent. The person gets a text naming the file. Twilio
  fetches outgoing media from a public address, which Switch doesn't offer
  for this, and Twilio's MMS reaches only a few countries.

## What SMS can't do

- **No threads.** Everything is one flat conversation, and a reply in a Switch
  thread arrives as an ordinary text.
- **No edits or deletes.** An edit or delete in Switch doesn't reach the phone. A
  request card isn't updated once it's answered. A late answer gets a text saying
  so.
- **No working indicator.** SMS has no typing indicator or reactions, and a
  "working" text would cost money, so the person sees nothing until the reply. If
  an agent runs into a problem someone has to act on, that is texted.
- **One-to-one only.** There are no group texts.
- **No channel creation or directory search.** A number is known only once it has
  texted or has been bound to a room, and nobody else can be added to its
  conversation.
- **One connection per number.** A number has one webhook address.
- **Lost in a crash.** Switch answers Twilio before handling a text. If Switch stops
  in that moment, that one text doesn't reach the room, and Twilio doesn't resend it.

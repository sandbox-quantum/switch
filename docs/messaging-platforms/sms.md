# SMS (Twilio)

Connect Switch to a phone number in your own Twilio account. People text the
number, their message reaches an agent, and the agent answers by text. Texts go
through your account, so Twilio bills you for them; this page also covers how to
keep that bounded.

## What to create on Twilio

1. Sign in to the [Twilio Console](https://console.twilio.com) and note the
   **Account SID** (starts with `AC`) and the **Auth Token** on the home page.
2. Get a phone number that can send and receive SMS under **Phone Numbers >
   Manage > Buy a number**, or use one you already own. A trial account works
   for testing, but it can only text numbers you have verified.
3. US numbers need registration before Twilio delivers to US carriers (A2P
   10DLC for local numbers, or toll-free verification). Without it, messages
   are filtered. Other countries have their own sender rules; check Twilio's
   guidelines for the countries you text.

Switch needs no other permission. It uses the Auth Token to send texts and to
check that each incoming request is from Twilio.

## Connect it in Switch Console

Open **Connect a messaging app**, choose **SMS** and fill in:

| Field | Meaning |
|---|---|
| Account SID | `AC` followed by 32 hex characters. |
| Auth Token | Kept secret. Rotating it in Twilio means editing the connection. |
| Twilio phone number | The number texts are sent from and received on, in E.164 form (`+15551234567`). |
| Allowed phone numbers | Who may text Switch, in E.164 form, separated by commas. At least one. |
| Segments per reply | Most segments one agent reply may use (4 to 20, default 8). |
| Segments per hour, per number | Most segments sent to one number in any hour (default 200). |

On save, Switch checks the Account SID and token with Twilio, that the account
is active and that it owns the number. A mistake is reported with Twilio's own
reason.

## Point Twilio at Switch

Once connected, the connection shows a webhook address:

```
https://<your server>/messaging/bridges/<bridge id>/events
```

In the Twilio Console open **Phone Numbers > Manage > Active numbers**, choose
the number, and under **Messaging Configuration** set **A message comes in** to
**Webhook**, **HTTP POST**, and paste the address exactly as shown. Switch
checks the `X-Twilio-Signature` on every request against that exact address, so
a different spelling (another host, a trailing slash) is refused as unsigned. If
the number belongs to a Messaging Service, set the incoming-message webhook on
the service instead.

The server must be reachable from the internet over https, with
`MESSAGING_PUBLIC_URL` set to its public origin. For local testing a tunnel such
as `ngrok http 8000` works; set `MESSAGING_PUBLIC_URL` to the https address it
prints. Without `MESSAGING_PUBLIC_URL` the connection refuses to start.

## How rooms map to phone numbers

SMS has no channels. A conversation is one phone number:

- The first text from an allowed number opens a direct room named after that
  number. Later texts from it go to the same room.
- A new room has no agents. Add one in Switch Console, or text
  `!invite-agent @agent-name`. Agents then answer in that room, and each reply starts
  with the agent's name because SMS has one sender.
- A text from a number that is not on the allow-list is dropped and never
  answered, so nobody else can start a room or cost you money. Only the last
  four digits of the number are logged. To let someone in, add their number to
  the connection.
- Switch also refuses to text any number that is not on the list.

## Long replies and cost

Twilio bills per segment. One segment holds 160 characters of the basic SMS
alphabet, or 70 if the text has anything outside it (a curly quote or an emoji
is enough). Longer texts are billed at 153 or 67 characters per segment.

- Replies are sent as plain text: Markdown markers are removed and a link keeps
  its address in brackets.
- A reply that fits in three segments goes out as one text. A longer one is
  split, preferring sentence ends, into numbered parts `(1/4)`, `(2/4)` and so
  on, each at most three segments.
- A reply may use at most "Segments per reply". Past that it is cut and ends
  with a note pointing to Switch Console, which has the full text.
- At most "Segments per hour, per number" are sent to one number in any hour.
  Past it nothing is sent to that number, and a warning is logged, until the hour
  moves on. The count is kept per switch-core process, so with several pods each
  has its own.
- For a hard ceiling on spend, also set a usage trigger or spending limit in the
  Twilio Console.

Approval and question cards are sent as short text; answer by texting back the
handle the card prints.

Twilio handles `STOP` and `START` itself: a person who texts `STOP` receives
nothing more from your number until they text `START`.

## What does not work on SMS

- No threads: replies are not grouped, and the thread of a message is ignored.
- No edits or deletes: a sent text cannot be changed, so a status that updates
  elsewhere is not shown as a changing message.
- No reactions or typing indicator, and no live activity cards.
- No channel creation and no directory search: only numbers on the allow-list
  can talk to agents.
- No pictures or files. A picture text is reported in the room as an attachment
  that was not relayed, and an agent's file is replaced by a text naming it.
- Retries are safe: Twilio sends each text with a unique message id, and a
  repeated delivery is handled once on any pod.

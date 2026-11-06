# SMS (Twilio)

Text your Switch agents from any phone. Switch uses your own Twilio account and
phone number: Twilio sends Switch each text the number receives, and Switch
replies through Twilio's API.

## How conversations map to rooms

- Each phone number that texts in is its own conversation, and becomes a
  **direct room** the first time it texts.
- The connection's **Agent that answers** is added to each new room. Leave it
  empty to add agents yourself with `!invite-agent <name>`.
- All agents share the one Twilio number, so each reply opens with the agent's
  name: `claude: Done, the tests pass.`
- `!commands` work by texting them, e.g. `!invite-agent reviewer`.

## Before you begin

- A Twilio account. A free trial works for testing.
- A Twilio phone number that can send and receive SMS (Phone Numbers > Manage >
  Buy a number).
- Switch reachable from the internet over https, with `MESSAGING_PUBLIC_URL`
  set to that address (see below). Twilio has to be able to call it.

## Create the connection

1. In the Twilio Console home page, copy your **Account SID** and **Auth Token**.
2. In Switch Console, open **Connect a messaging app** and choose **SMS (Twilio)**.
3. Fill in:
   - **Account SID**: starts with `AC`.
   - **Auth Token**: Switch uses it to call Twilio and to check that each
     incoming text really came from Twilio. Console masks it.
   - **Twilio phone number**: the number people text, in E.164 form, e.g.
     `+15005550006`.
   - **Allowed phone numbers**: who may text in, comma separated, in E.164 form,
     e.g. `+919812345678, +447700900123`.
   - **Agent that answers** (optional): the agent added to each new conversation.
   - **Most SMS segments per reply**: see *Keeping costs bounded*.
4. Connect. Switch checks the Account SID and Auth Token, and that the number
   belongs to that account, before saving.

You don't paste a webhook address into Twilio: when the connection starts,
Switch sets the number's **A message comes in** webhook to its own address for
this connection. Removing the connection clears it again.

## Keeping costs bounded

Every text costs money, in both directions. The connection limits that in three
ways:

- **Allow-list.** Texts from numbers not on the list are dropped without a
  reply, and Switch never texts a number that is not on the list, so a stranger
  cannot run up your bill.
- **Segment cap.** Twilio bills per segment: 160 plain characters, or 70 when the
  text contains emoji or non-Latin characters (153 and 67 per segment once a text
  is split). A reply longer than **Most SMS segments per reply** is cut short at
  a word and ends with a note to read it in full in Switch. The default is 6.
- **Nothing extra is sent.** No typing indicator, no "working on it" text, and
  no edit or delete texts.

A reply longer than Twilio's 1,600-character limit is sent as several texts,
split at paragraph, sentence or word boundaries.

## What SMS can't do

| Feature | On SMS |
|---|---|
| Threads | None. Every message in a conversation is in one flow, and replies go to the same number. |
| Edits and deletes | Not mirrored. A sent text can't be changed or taken back. |
| Formatting | Plain text. Markdown is converted: bold, code and headings become plain words, and links become `text (url)`. |
| Attachments | Pictures sent by MMS aren't relayed; the room says so. An agent's file arrives as a text naming it. |
| Working indicator | None, to avoid a text per turn. |
| Approval and question cards | Sent as text. Answer by texting back the handle the card prints. |
| Creating rooms from Switch | Not possible: a room appears when an allowed number texts in. |
| Directory search | None: the only people Switch knows are those who have texted in. |
| Slash commands | Use `!commands` instead. |

## Exposing Switch over https

Twilio calls `https://<MESSAGING_PUBLIC_URL>/messaging/bridges/<bridge id>/events`.
For a deployment, route `/messaging` on your public host to switch-core.
For local testing, a tunnel is enough:

```bash
cloudflared tunnel --url http://localhost:8000
```

Set `MESSAGING_PUBLIC_URL` to the https address it prints, and restart Switch.

## Notes on Twilio trial accounts and carriers

- A trial account can only text numbers you have verified in the Twilio Console,
  and its texts start with "Sent from your Twilio trial account".
- Twilio handles STOP and START opt-out keywords itself.
- Sending to US numbers needs A2P 10DLC or toll-free verification before
  carriers deliver it; other countries have their own rules. See Twilio's
  documentation for your destination.

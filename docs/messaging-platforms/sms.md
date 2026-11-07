# SMS (Twilio)

Let people text your agents through your own Twilio account and number.
Each phone number that texts it is a direct room of its own, and every agent
replies from your one number, with its name at the start of the text.

Twilio calls Switch for every incoming text (a webhook), so the server needs
an https address Twilio can reach.

## What you need from Twilio

1. A Twilio account, and a phone number on it that can send and receive SMS
   (**Phone Numbers → Manage → Buy a number**). A trial account can text only
   numbers you have verified.
2. From the Twilio Console's home page, the **Account SID** (it starts with
   `AC`) and the **Auth Token**.

## Connect it in Switch Console

**Connect a messaging app → SMS (Twilio)**, and fill in:

| Field | What it is |
|---|---|
| Name | How the connection is labelled in Switch Console |
| Account SID | From the Twilio Console |
| Auth Token | From the same page. Twilio signs every incoming text with it |
| Twilio phone number | Your number, in international form: `+14155550100` |
| Most segments per reply | Twilio bills each 153-character segment (67 for text with non-Latin characters). A longer reply is cut, with a note saying how much was left out. Three by default |
| Numbers that may text the agents | Numbers separated by commas. Empty takes texts from anyone |

Switch checks the SID and token with Twilio, and that the number is yours,
before it saves the connection.

You don't paste an address into Twilio: when the connection starts, Switch
sets your number's incoming-message URL to its own address. One connection per
number, since Twilio sends a number's texts to one address.

## The public address

- `MESSAGING_PUBLIC_URL` set to the server's public https origin; Twilio signs
  the exact address, so it must be the one Twilio calls.
- The `/messaging` path routed to switch-core; see
  `deploy/remote/helm/switch/samples/ingress.example.yaml`.
- For local development, a tunnel: `cloudflared tunnel --url
  http://localhost:8000` or `ngrok http 8000`.

## How a room maps to numbers

Each number that texts yours is its own direct room, named by that number.
There are no group texts: Switch cannot create a room with several numbers in
it, and the connection says so.

## Keeping costs bounded

- **Most segments per reply** caps what one reply can cost; a cut reply says
  how much was left out, so the person can ask for the rest.
- **Numbers that may text the agents** keeps strangers who learn your number
  from making your agents reply, and pay for it.
- Replies are plain text: Markdown's asterisks and fences are taken out, and
  a link is written as its text followed by its address.

## What SMS can't do here

| | |
|---|---|
| Threads | None; every text is at the top of its room |
| Edits and deletes | A text cannot be changed or taken back once sent |
| Group rooms and room creation | None; one direct room per number |
| Cards | Approval and question cards arrive as text with numbered options, answered by texting the answer back |
| Agent identities | One number speaks for every agent; each text starts with the agent's name |
| Directory search, typing | None |

# Webex

Connect Cisco Webex to Switch with a bot you create. Every agent speaks
through the bot, with its name in bold at the start of each message. A space
is a Switch room, a 1:1 space with the bot is a direct room, and a threaded
reply stays in its thread.

Webex calls Switch for every message (a webhook), so the server needs an
https address Webex can reach.

## Create the bot

1. Sign in at [developer.webex.com](https://developer.webex.com) and choose
   **Start building apps → Create a bot**.
2. Give it a name, a username and an icon, and create it.
3. Copy the **Bot access token** shown. Webex shows it once; regenerate it on
   the bot's page if you lose it.
4. Choose a **webhook secret**: any long random string, at least 16
   characters. Webex signs every event with it.

## Connect it in Switch Console

**Connect a messaging app → Webex**, and fill in:

| Field | What it is |
|---|---|
| Name | How the connection is labelled in Switch Console |
| Bot access token | From step 3 |
| Webhook secret | From step 4 |

Switch checks the token with Webex before it saves the connection: a wrong
token, or a person's token rather than a bot's, is refused with the reason.

You don't paste an address into Webex. When the connection starts, Switch
registers its own webhooks with the bot's token (`messages` and
`attachmentActions`, each signed with your secret), and replaces them on every
start, so a changed address or secret takes effect.

## The public address

- `MESSAGING_PUBLIC_URL` set to the server's public https origin.
- The `/messaging` path routed to switch-core; see
  `deploy/remote/helm/switch/samples/ingress.example.yaml`.
- For local development, a tunnel: `cloudflared tunnel --url
  http://localhost:8000` or `ngrok http 8000`, with `MESSAGING_PUBLIC_URL` set
  to the https URL it prints.

Without it the connection does not start, and says why.

## Using it

- Add the bot to a space. In a group space, mention it: `@Switch Bot hello`.
  In a 1:1 space with the bot, just write.
- `!commands` work: `!invite-agent @coder`, `!help`.
- Approval and question cards are Adaptive Cards with a button for each
  option; the text form goes with them, for clients that do not draw cards.

## What Webex can't do here

| | |
|---|---|
| Unaddressed messages in group spaces | Webex delivers a bot only the messages that mention it in a group space, so a message that mentions nobody does not reach the room. In a 1:1 space every message does |
| Agent identities | One bot speaks for every agent; each message starts with the agent's name |
| Directory search | A bot sees only the members of its own spaces |
| Typing indicator | Webex shows a bot none |
| Custom URL schemes | Webex links `http(s)` only |

## Several pods

Webhooks reach any pod, and each event carries only the message's id, which
the adapter reads with the bot's token. A retried delivery carries the same
id, so it is handled once, whichever pod it reaches.

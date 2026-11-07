# Webex

Connect Webex spaces to Switch rooms through a bot you create. Agents reply in
Webex spaces and threads, and people answer approval and question cards with
buttons in Webex.

Webex calls Switch over HTTPS for every event (a webhook), so the deployment
must be reachable from the internet. Switch registers the webhooks with Webex
itself, so there's no address to copy and paste.

## Before you start

- A Webex account that can create bots. A free account at
  [developer.webex.com](https://developer.webex.com/) works.
- `MESSAGING_PUBLIC_URL` set to the deployment's public https origin, with the
  `/messaging` path routed to switch-core. See
  [Exposing it over public HTTPS](../contributing/add-a-messaging-platform.md#exposing-it-over-public-https).
  For local testing, a tunnel is enough:

  ```bash
  cloudflared tunnel --url http://localhost:8000
  # then set MESSAGING_PUBLIC_URL to the https URL it prints, and restart switch-core
  ```

## 1. Create the bot

1. Sign in at [developer.webex.com](https://developer.webex.com/).
2. Open your avatar → **My Webex Apps** → **Create a New App** → **Create a Bot**.
3. Fill in:
   - **Bot name**: what people see. Only the first word shows when someone
     mentions the bot, so a single word reads best, for example `Switch`.
   - **Bot username**: its address, for example `acme-switch@webex.bot`.
   - **Icon** and **Description**.
4. Select **Add Bot** and copy the **Bot access token**. Webex shows it once. If
   you lose it, open the bot under **My Webex Apps** and regenerate it, then
   update the connection in Switch.

A bot needs no scopes or admin approval. It can act only in spaces it has been
added to, and only as itself.

## 2. Connect it in Switch Console

1. In Switch Console, open **Messaging Apps** → **Register messaging app** and choose **Webex**.
2. Paste the **Bot access token** and connect.

Switch checks the token before saving the connection. A token Webex rejects,
or a token that belongs to a person instead of a bot, is refused with the
reason.

Once the connection starts, Switch registers three webhooks on the bot, each
signed with a secret Switch generates for this connection:

| Webhook | What it carries |
|---|---|
| `messages` / `created` | messages people send the bot |
| `attachmentActions` / `created` | button presses on approval and question cards |
| `memberships` / `created` | the bot, or a person, being added to a space |

Every delivery is checked against that secret before Switch reads it. If Webex
disables a webhook after repeated failed deliveries, for example while the
deployment was down, Switch turns it back on the next time the connection
starts. Removing the connection deletes the webhooks.

## 3. Use it

- **Add the bot to a space.** Switch picks the space up as a room. Or have an
  agent create a space from Switch: the bot creates it and adds the people you
  choose.
- **Talk to an agent.** In a group space, mention the bot and then the agent:
  `@Switch @coder fix the failing test`. If the room has only one agent,
  `@Switch fix the failing test` is enough. In a 1:1 space with the bot, just
  write.
- **Threads.** A reply in a Webex thread stays in that thread, both ways.
- **Commands.** `!commands` work after the bot mention, for example
  `@Switch !invite-agent coder`.
- **Files.** Files sent to the bot are relayed to the room, up to the
  deployment's attachment limit. A larger file is refused with a note in the
  room. Agents can send files up to Webex's 100 MB limit, one file per
  message.
- **Approvals and questions.** These arrive as cards with one button per
  option. Webex does not allow a mention in a message that carries a card,
  so the person who should answer is mentioned in a message just above it.
  A press is recorded as answered from Webex, and the card and its mention
  are removed once it is answered. Typing the answer, as the card
  describes, works too.

## What Webex can't do

| | |
|---|---|
| **Messages that don't mention the bot** | In a group space, Webex gives a bot only the messages that mention it. A message that doesn't name the bot never reaches Switch, so it doesn't reach the room. In a 1:1 space every message reaches it. |
| **One identity for every agent** | Every agent posts through the one bot, with its name in bold at the top of the message. |
| **Typing indicator and reactions** | A bot can't set either. The agent's status message shows it's working. |
| **Edits** | Webex allows each message ten edits. A long-running turn's status stops updating partway and keeps its last edit for the final state. |
| **Directory search** | A bot can't search the organisation's directory, so Console can't look people up on Webex. |
| **Slash commands** | Webex has no slash commands for bots. Use `!commands`. |
| **Deleting a room** | The bot leaves the space rather than deleting it, so the space and its history stay with the people in it. |
| **Events while switch-core is down** | Webex promises no redelivery of an event it couldn't deliver, so a message sent while the deployment was unreachable may not be relayed. |

## Troubleshooting

- **The connection says `MESSAGING_PUBLIC_URL` is not set.** Webex has no
  address to call. Set it and restart switch-core.
- **Nothing arrives from Webex.** Check that the public URL is reachable over
  https from the internet, and that the message mentions the bot (in a group
  space).
- **"That token belongs to a person, not a bot."** You copied your personal
  access token from the developer portal. Use the bot's own token from
  **My Webex Apps**.

# Connect Webex

Put your Switch agents in Webex spaces, using a Webex **bot** that you create.

Webex calls Switch for every message, so unlike most platforms here **Switch
must be reachable from the internet over HTTPS**. Nothing else needs to be.

## Before you begin

- **A Webex account** that can create a bot at
  [developer.webex.com](https://developer.webex.com).
- **A public HTTPS address for your Switch server**, set as
  `MESSAGING_PUBLIC_URL` (scheme and host, no path) with the `/messaging` path
  routed to switch-core (port 8000). It is the same setting Slack's one-click
  app uses; see `deploy/remote/helm/switch/samples/ingress.example.yaml`. For
  trying this out on your own machine, a tunnel works:
  `cloudflared tunnel --url http://localhost:8000` or `ngrok http 8000`, then
  set `MESSAGING_PUBLIC_URL` to the https URL it prints.
- **An admin account on the Switch server** you are connecting to.

Without `MESSAGING_PUBLIC_URL` the connection refuses to start, with a message
saying so, because no message could ever arrive.

## Create the bot

1. Sign in at [developer.webex.com](https://developer.webex.com), open **My
   Webex Apps** and choose **Create a New App**, then **Create a Bot**.
2. Give it a **name** (shown as the sender of its messages), a **username**
   (`something.bot`) and an icon, and a short description.
3. **Copy the bot access token** when it is shown. Webex shows it once; if you
   lose it, generate a new one on the bot's page.

Switch needs no scopes to choose: a bot has what a bot has. It does not need
to be a moderator of any space.

## Connect it in Switch Console

1. Select the server in the sidebar switcher and open its **Home** page.
   **Messaging apps** lists what is connected.
2. Select **Connect**, then choose **Webex** under **Messaging app**. If there
   is no **Connect** button you are signed in without admin rights.
3. **Name** the connection after the organisation, "Acme Webex".
4. Paste the **Bot token**.
5. Select **Connect**. Switch asks Webex who the token belongs to before it
   saves anything, so a wrong token, or the token of a person instead of a
   bot, is reported here in words and nothing is stored.

Switch then registers its own webhooks with Webex, named `Switch <connection
id>`, pointing at the connection's address. They are kept up to date by Switch
and removed when you delete the connection. Do not edit or delete them in
Webex.

## Bring Switch into a space

In Webex, open the space and **add the bot by its username**. Switch creates
the room. Then add agents from inside the room:

```text
!invite-agent @agent-name
```

Webex has no native slash commands for bots, so the `!` form is the one that
works, and it has to be the first thing in the message (after the bot's
mention, in a group space).

To go the other way, create the room in Switch: Switch creates the Webex space
with the bot in it and adds the people you chose, unless you withheld space
creation from the connection.

## Talking to an agent

**In a group space, Webex only gives a bot the messages that mention it.** That
is how Webex works, not a choice Switch makes, and it has consequences:

- Start a message with the bot's mention and then the agent: `@Switch Bot
  @scout please look at this`. The bot's own mention is removed, and Switch
  reads `@scout please look at this`.
- A message that does not mention the bot **never reaches Switch**, so
  unaddressed conversation in a group space cannot appear in the room.
- **In a one-to-one space with the bot every message arrives**, so no mention
  is needed. Start it yourself: Webex only lets a person open a space with a
  bot.

## How it behaves

- **Agents speak under their own name.** Every agent posts through the one bot,
  so an agent's name is written in bold at the head of its message.
- **Threads.** A reply in a Webex thread is a Switch thread, both ways. Webex
  threads are one level deep.
- **Formatting.** Agents write Markdown and Webex renders its subset of it
  (bold, italics, lists, code, links, quotes). Webex has no headings, so a
  heading becomes a bold line, and tables are shown as text.
- **Long replies** are split between lines into several messages, never in the
  middle of a code block, because Webex rejects a message over 7,439 bytes.
- **Edits and deletes.** When Switch changes or deletes a message it posted,
  the Webex message is edited or deleted. What people do the other way is not
  mirrored: editing or deleting a message already relayed does not change the
  Switch room.
- **Files.** Files in a message reach the agent, and agents can send files,
  one to a message, up to Webex's 100 MB. A file bigger than the limit your
  Switch server allows is not relayed, and the room is told so. A file over
  Webex's limit is not sent, and the space is told so.
- **Working indicator.** Webex gives a bot no reactions and no typing
  indicator. While an agent works, its status is a message that is edited as
  the turn goes on.
- **Approvals and questions.** They are posted as text with numbered options.
  Answer by typing the option or its number as a reply, as the message says.
  They are not Adaptive Card buttons.
- **People.** A person is addressed by the local part of their email
  (`alice@acme.com` is `alice`).

## Restarting and running more than one Switch pod

- Webex calls the connection's address, and any Switch pod can answer. Core
  recognises a delivery it has already handled by its Webex message id, so a
  retried delivery writes nothing twice.
- Only the pod holding the connection registers the webhooks with Webex. When
  it starts, it makes them match the connection's settings, which also turns
  back on a webhook Webex switched off after failed deliveries.
- Messages sent while Switch is unreachable are not fetched afterwards. Webex
  decides how long it retries a failed delivery; Switch does not replay what
  Webex gave up on.

## What does not work on Webex

These are declared by the adapter, so Switch and Console know them without
asking:

| What | On Webex |
|---|---|
| Messages in a group space that do not mention the bot | Never delivered by Webex |
| Agents as separate accounts | No. One bot posts for every agent, under the agent's name in the text |
| Reactions and typing for a bot | None. Status is text |
| Buttons on approvals and questions | None yet. Answer by typing |
| Native slash commands | None. Use `!command` |
| Mirroring edits and deletes made in Webex | Not mirrored into Switch |
| A topic for a space | Webex has none, so a created space has a title only |
| Starting a one-to-one space from Switch | Not possible; the person starts it |
| Directory search | Not available to a bot |
| Links to Switch Console pages (`switchdash://`) | Not clickable; rewritten to https, which needs `GATEWAY_PUBLIC_URL` on the Switch server |
| Private notices to one person | None. They are posted in the space |

## Confirm it worked

- The connection is listed under **Messaging apps** with no error beside it.
- Webex lists two webhooks named `Switch <id>` for the bot (`GET
  https://webexapis.com/v1/webhooks` with the bot's token shows them).
- Adding the bot to a space makes the room appear under **Your Rooms**.
- A message that mentions the bot and an agent gets a reply headed by the
  agent's name.

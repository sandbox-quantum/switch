# Webex

Connect a Webex bot to Switch. Your agents can then talk in Webex spaces:
people mention the bot to bring an agent in, agents reply in threads, and
approval cards come with buttons you can answer in Webex.

## What you need

- A Webex account. A free one works.
- Switch reachable from the internet over **https**. Webex sends each message
  to Switch by webhook, so the deployment needs `MESSAGING_PUBLIC_URL` set to
  its public origin, with `/messaging` routed to switch-core. See
  [Exposing it over public HTTPS](../contributing/add-a-messaging-platform.md#exposing-it-over-public-https).
  For local development, a tunnel is enough:

  ```bash
  cloudflared tunnel --url http://localhost:8000
  # then set MESSAGING_PUBLIC_URL to the https URL it prints, and restart switch-core
  ```

## 1. Create the bot

1. Sign in at [developer.webex.com](https://developer.webex.com).
2. Open your avatar menu → **My Webex Apps** → **Create a New App** → **Create a Bot**.
3. Fill in:
   - **Bot name**: what people see, for example `Switch`.
   - **Bot username**: its address, for example `acme-switch@webex.bot`.
   - **Icon** and **description**: anything you like.
4. Click **Add Bot** and copy the **Bot access token** it shows. Webex shows it
   only once. If you lose it, open the bot under My Webex Apps and choose
   **Regenerate Access Token**.

Bots need no scopes or permissions. A bot can read the messages sent to it,
post, edit and delete its own messages, create spaces, and add people to
spaces it is in.

## 2. Connect it in Switch Console

1. Open **Connect a messaging app** and choose **Webex**.
2. Paste the **Bot access token**, as Webex showed it, without the word `Bearer`.
3. Click **Connect**.

Switch checks the token with Webex before saving. It refuses a token Webex
rejects, and a *personal* access token, because those expire after 12 hours
and the bridge would then stop without warning.

Once connected, Switch registers its own webhooks with Webex. You don't paste
an address anywhere. Each delivery is signed with a secret Switch generated
for this connection, and anything not signed with it is refused.

## 3. Add the bot to a space

In Webex, open a space and add the bot by its username (**People** → **Add
people**). Switch creates a room for the space as soon as the bot joins. You
can also message the bot directly; that 1:1 space is the bot's lobby.

To talk to an agent in a group space, **mention the bot and name the agent**:

```
@Switch @claude why did last night's deploy fail?
```

In a 1:1 space with the bot you don't need to mention it.

Commands start with `!`, for example `!invite-agent claude` or `!help`. In a
group space, mention the bot first: `@Switch !help`.

## The connection's fields

| Field | What it is |
|---|---|
| **Bot access token** | The token from step 1. Switch posts as the bot with it and registers the webhooks. |

## What Webex can't do

These are Webex limits for bots, not settings you can change:

- **In a group space, Webex sends the bot only messages that @mention it.**
  Messages that don't mention the bot never reach Switch, so they don't reach
  the room either. In a 1:1 space every message arrives.
- **No per-agent identity.** Every agent posts as the one bot. Each agent's
  name, with a coloured marker, heads its messages.
- **No reactions and no typing indicator for bots.** An agent's progress
  shows in its status message.
- **Edits made in Webex aren't mirrored.** Webex sends no webhook when a
  message is edited. Edits and deletes made by agents do show in Webex.
- **One file per message.** Several files from an agent arrive as several
  messages. Webex refuses files over 100 MB; Switch says so in the space
  instead of failing silently.
- **Answered cards are removed.** A Webex message can't drop its buttons once
  posted, so a card that has been answered is deleted rather than left with
  buttons that would no longer work.
- **Deleting a room leaves the space alone**, so the people in it keep their
  history.

## If it isn't working

- **The bot never answers in a group space**: the message has to mention the
  bot. Check that the mention turned into a highlighted name, not plain text.
- **Nothing arrives at all**: check that `MESSAGING_PUBLIC_URL` is set and
  reachable from the internet over https. Restarting switch-core re-registers
  the webhooks, which also re-enables any that Webex disabled after failed
  deliveries.
- **Messages sent during a restart**: when the bridge starts, Switch reads the
  last 15 minutes of each space's history and relays anything it missed.
  Messages it already relayed are not relayed twice.

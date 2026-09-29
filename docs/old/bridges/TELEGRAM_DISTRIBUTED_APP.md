# The distributed Telegram app

`TELEGRAM_SETUP.md` describes the bot **an operator registers for themselves**:
they create it in BotFather, paste its token into Switch, and add it to their
own chats. This page describes the other one — the bot **we** register once per
deployment, whose chats a customer connects with a link from Switch and which
never requires them to see a token.

They are two separate bots and they will both exist. Nothing here replaces the
other page.

A chat is connected to an organisation that **already exists**. Nothing done in
Telegram brings an organisation into being: every connection starts from a link
or code minted inside Switch by someone signed in to it.

## Why it cannot be the same bot

A self-registered bot is **polled**: Switch asks Telegram for its updates over
a connection it opens, so the deployment needs no inbound route. The shared bot
serves every organisation on the deployment, and Telegram gives a bot exactly
one delivery channel, so it is set up the other way round: Telegram posts every
update to a webhook on this deployment, and Switch works out which organisation
each belongs to from the chat it came from.

Two consequences follow, and both are enforced rather than advised:

- **The shared bot is never polled.** A webhook makes `getUpdates` fail, and a
  poller that got there first would take every organisation's updates. Its
  token is refused as a self-registered bridge, at registration, at start and
  on edit.
- **One bot is one credential for every organisation.** Its token lives in
  deployment secrets, never in the database or a connection's config, and is
  never shown to a customer. Treat it as the deployment's most sensitive
  messaging credential.

## Register the bot

1. In [@BotFather](https://t.me/BotFather), send `/newbot`, give it a display
   name and a username ending in `bot`, and save the token it replies with.
2. **Turn Group Privacy off before the bot joins any chat:** `/mybots` → the
   bot → **Bot Settings** → **Group Privacy** → **Turn off**. Telegram reads the
   setting when the bot joins a chat, so changing it later fixes no chat the
   bot is already in. Switch logs an error at boot if it is still on.
3. Leave **Allow Groups?** on (BotFather's default). A bot barred from groups
   cannot be added to one, and Telegram answers the link by opening a direct
   chat instead.

Set nothing else in BotFather. The command menu is published by Switch on
every start and would overwrite anything set there.

## Configure the deployment

| Variable | What it is |
| --- | --- |
| `TELEGRAM_APP_BOT_TOKEN` | The token BotFather issued, shaped `<bot id>:<secret>`. |
| `TELEGRAM_APP_WEBHOOK_SECRET` | A secret Telegram echoes back on every update, 1–256 characters of `A-Z a-z 0-9 _ -`. It is the whole of what proves an update came from Telegram. `openssl rand -hex 32` makes a good one. |
| `MESSAGING_PUBLIC_URL` | The origin Telegram posts to: `https`, scheme and host, no path, on port 443, 80, 88 or 8443 — the only ports Telegram delivers to. |

Set both `TELEGRAM_APP_*` values or neither; setting one is refused at startup,
as is a malformed token or secret, a missing origin, or a port Telegram will
not use. Setting them is the whole of turning the app on: there is no separate
switch.

With the Helm chart, set `switchCore.telegramApp.enabled` and
`switchCore.telegramApp.messagingPublicUrl`, and supply the two secrets as
`secrets.telegramAppBotToken` and `secrets.telegramAppWebhookSecret`. The
standalone compose file forwards both variables from `.env`.

**Route `/messaging` to Switch from the internet** — in the chart, add it to
`ingress.agentApiPaths`. Telegram gives up on a URL it cannot reach or whose
certificate it cannot verify.

## What Switch tells Telegram at boot

On every start Switch asks Telegram who the bot is (`getMe`), then points its
delivery at this deployment with `setWebhook` and publishes the command menu
with `setMyCommands`. Doing it on every start keeps the URL, the secret and the
update types in step with the running config: rotating the secret is a
redeploy, not a manual call. The webhook it sets, with `HOST` standing for
`MESSAGING_PUBLIC_URL`'s host:

```json
{
  "url": "https://HOST/messaging/telegram/events",
  "allowed_updates": ["message", "channel_post", "my_chat_member", "callback_query"]
}
```

The start runs in the background and retries, so an unreachable Telegram never
holds up a deployment serving other platforms. Until it succeeds Switch offers
no links, and updates Telegram already holds wait on its side. The webhook is
left set on shutdown, so Telegram holds and retries updates across a restart.

## How a chat is connected

In the dashboard, **Installed apps** → the Telegram card → **Connect a chat** shows a link
and a code. Both work once, for ten minutes.

- **A group:** the link opens Telegram's chat picker. Adding the bot through it
  posts the code into the group, which connects it; Switch creates the group's
  room and the bot says what it can see.
- **A channel:** Telegram carries nothing when a bot is added to a channel, so
  add the bot as an administrator with permission to post — **Administrators**
  → **Add Admin**, searching for the full `@username` the dialog shows, since
  Telegram does not find a bot by part of it — then post `/connect <code>` in
  the channel.

  What agents say in the room is posted to the channel either way. Posts in
  the channel reach the room only when its **Sign Messages** and **Show
  Authors' Profiles** settings are both on and the admin posts as themselves:
  a post made as the channel names no one, and is not bridged.

Who may connect one:

- **The first chat is an admin's.** It creates the organisation's Telegram
  connection, which is what turns Telegram on for it.
- **After that, any member** may connect more chats and disconnect any one of
  them, the last included. A chat is a room, and rooms are members'.
- **Turning Telegram off is an admin's**: it is deleting the connection, and
  connections are admins'.

Every chat an organisation connects shares its one connection, so a person
links their Telegram account once and is recognised in all of them.

When a connection does not happen, the bot says why in the chat: the link has
expired or was used, the code is not from this deployment, the chat is already
connected to Switch, or only an admin can connect the first chat. It never says
which organisation holds a chat. A retry Telegram sends of a claim that worked
is not answered.

A chat's room comes only from connecting it. The room form's **Use existing
channel** is off for the Telegram app, and a room cannot be moved onto it with
a chat id either: the bot is in every organisation's chats, so it could reach
one another organisation connected. A connected chat already has its room.

## What the bot does in chats nobody connected

The bot can be added to a group without a link — by anyone who finds it. It
then posts one message, ten seconds later and only if no connection has landed
in the meantime, saying the chat is not connected and how to connect it, and
after that it stays and says nothing. In a channel it posts nothing: a channel
is always added before its code is posted, and anything the bot said there
would reach every subscriber.

With Group Privacy off it still receives everything said there. **None of it is
stored, dispatched or logged.** Each such update is counted in
`switch.messaging.events_ignored` and dropped.

A direct message to the bot gets a reply saying direct messages reach no one,
as the self-registered bot's does.

## Disconnecting

- **A chat:** **Disconnect** on the chat's row in the Telegram card. The bot
  leaves the chat and its room becomes internal-only; every other chat keeps
  working. If Telegram refuses to let the bot leave, nothing changes and the
  error says to try again.
- **Removing the bot in Telegram** ends that chat's connection the same way,
  from Telegram's side.
- **Telegram itself:** the organisation's Telegram connection stays when its
  last chat goes, however it went, so Telegram stays on and a member can
  connect a chat again. To turn it off, an admin disconnects any chats left
  and then deletes the Telegram connection from the list of connections. The
  delete is refused while any chat is still connected, since the bot would
  stay in it. Deleting the connection also forgets everyone's linked Telegram
  account; the next admin to connect a chat starts a new one.

## Rotating credentials

- **The bot token:** send `/revoke` to BotFather, put the new token in
  `TELEGRAM_APP_BOT_TOKEN`, and redeploy. Nothing stored needs changing, because
  nothing stored holds it.
- **The webhook secret:** change `TELEGRAM_APP_WEBHOOK_SECRET` and redeploy.
  The next start sets it on the webhook.

## Watching it

- **Delivery.** Every five minutes Switch asks Telegram how delivery to the
  webhook is going (`getWebhookInfo`) and logs a warning on a new delivery
  error, or when the backlog of updates Telegram is holding grows past 50. It
  is the only view of what Telegram has given up on.
- **Lost messages.** A supergroup's messages sent between its conversion and
  the connection following it to the new chat id are lost, and are logged as
  an error with their count.
- **Rate limits.** One bot serves every organisation, so a burst in one holds
  back the others. `switch.bridge.throttle.held` with `delivery=shared` shows
  how long publications are held back.
- **Unclaimed traffic.** `switch.messaging.events_ignored` counts updates from
  chats nobody connected.

## Left out on purpose

- **Linking a Telegram account by direct message.** People link themselves the
  way they do on the self-registered bot, once per organisation.
- **Bridging direct messages.** A direct message belongs to no organisation.
- **Fair sharing of the bot's send rate between organisations.** Deferred until
  the metric above says it is needed.
- **Leaving unclaimed chats automatically.** The bot stays, quiet, so a channel
  admin can post the code after adding it.

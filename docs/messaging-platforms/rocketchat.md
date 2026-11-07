# Rocket.Chat

Connect a bot user on your own Rocket.Chat server to Switch. Your agents can
then talk in your channels: everything said in a channel the bot is in reaches
the room, agents reply under their own names and in threads, and approval cards
come with buttons you can answer in Rocket.Chat.

Tested with Rocket.Chat 8.9.

## What you need

- A Rocket.Chat server, and an administrator account on it.
- Switch able to reach that server. Switch connects out to it, so nothing has to
  reach Switch from the internet. If the server is on a private address, allow
  it with `OUTBOUND_ALLOWED_PRIVATE_HOSTS`.

## 1. Create the bot

In Rocket.Chat, as an administrator:

1. Open **Administration → Users → New user**.
2. Fill in an **Email**, a **Name** and a **Username** (for example `switch`), and
   tick **Mark email as verified**. Under **Password**, choose **Set manually** and
   enter one.
3. Under **Roles**, choose **bot**, and remove **user**. Click **Add user**.

## 2. Give the bot role two permissions

The `bot` role can't do either of these by default. Open **Administration →
Permissions** and tick the `bot` column for:

| Permission | Why |
|---|---|
| **Create Personal Access Tokens** | Without it the next step says *Not Authorized*. |
| **Delete Own Message** | So agents can take back what they posted. |

The `bot` role already has **Impersonate Other Users**, which lets each agent post
under its own name, and **Bypass Rate Limit for REST API**. If you take
impersonation away, Switch still works and writes the agent's name at the top of
each message instead.

## 3. Create the token

1. Log out, and log in as the bot.
2. Open your avatar menu → **Profile**, then **Personal Access Tokens** in the
   sidebar.
3. Enter a name, choose **Ignore Two Factor Authentication** from the list next to
   it, and click **Add**.
4. Copy the **Token** and the **User ID**. Rocket.Chat shows them only once.

## 4. Connect it in Switch Console

1. Open **Connect a messaging app** and choose **Rocket.Chat**.
2. Fill in the form, and click **Connect**.

Switch checks the token with your server before saving. It refuses a token the
server rejects, a deactivated user, and an account without the `bot` role.

## 5. Add the bot to a channel

Add the bot to a channel, or a private team channel, under **Members**. Switch
creates a room for the channel as soon as the bot joins. You can also send the
bot a direct message.

Everything said in the channel reaches the room. To talk to an agent, mention it:

```
@claude why did last night's deploy fail?
```

In a room with one agent, mentioning the bot does the same:

```
@switch why did last night's deploy fail?
```

Commands start with `!`, for example `!invite-agent @claude` or `!help`.

An agent takes instructions only from its owner, so link your Rocket.Chat account
to your Switch user first: Switch Console gives you a code, and you post
`!link-account <code>` in any room the bot is in.

## Answering a card

An approval card shows a button for each option. A button posts the same answer
you could type, for example `R7 1`, as you, so the answer is yours and it shows
in the channel. Once answered, the card loses its buttons and stays in the
channel, showing what was decided.

A card that needs more than one press, such as a form with several questions,
has no buttons. It says what to type instead.

## The connection's fields

| Field | What it is |
|---|---|
| **Server address** | The address you open Rocket.Chat at. |
| **Bot user ID** | The User ID from step 3. |
| **Personal access token** | The Token from step 3. |

## What Rocket.Chat can't do

These are limits of a bot user, not settings you can change:

- **No slash commands.** Registering one takes an app installed on the server,
  so commands start with `!`.
- **No typing indicator.** A 👀 reaction on your message shows an agent is working
  on it, ⏳ that it's queued, and a status message shows how far it has got.
- **Edits and deletes made in Rocket.Chat aren't mirrored** into the room. Edits
  and deletes made by agents do show in Rocket.Chat.
- **Files don't carry the agent's name** as other messages do, so it's written in
  the caption.

## If it isn't working

- **Not Authorized when creating the token**: do step 2.
- **Could not reach Rocket.Chat**, or a refusal that the address is not public:
  set `OUTBOUND_ALLOWED_PRIVATE_HOSTS` to the server's hostname, and restart
  switch-core.
- **The file is refused**: the server's own limit applies. It's under
  **Administration → Settings → File Upload → Maximum File Upload Size**. Switch
  says so in the thread.
- **Messages sent during a restart**: the bot's read mark in each room is where
  Switch picks up from. After a restart or a dropped connection, Switch relays
  what's newer than that mark, up to a day old. Messages it already relayed aren't
  relayed twice.

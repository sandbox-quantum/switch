# Connect Matrix

_Put your Switch agents in Matrix rooms on your homeserver, through one bot account you create_

You create an ordinary account for the bot on a Matrix homeserver, give Switch its access token, and invite it to rooms; people talk to agents from any Matrix client (Element, FluffyChat, Cinny, …). One bot account backs every agent on your Switch server, and because Matrix can't change who a message is from, each agent is identified by its name written at the head of what it posts.

The bridge is tested with Synapse. It should work with any homeserver that implements version 1.11 or later of the Matrix Client-Server API: it uses threads and relations, authenticated media, intentional mentions (`m.mentions`) and the user directory.

Matrix reaches Switch over a connection Switch opens outwards, so **nothing needs to be publicly reachable**.

**This is your homeserver, not Switch's.** Switch doesn't run a Matrix server and doesn't use Matrix internally: its rooms live in its own database. You'll see Matrix-looking names inside Switch itself (`matrix_room_id`, `m.room.message`); they're identifiers kept from an earlier design and have nothing to do with this connection. The only Matrix in this page is the bot talking to the homeserver you point it at.

**Warning**

**Encrypted rooms aren't supported.** The bot can't read or send end-to-end encrypted messages, and it checks a room isn't encrypted before it sends anything there. A Switch process that isn't syncing reads the room's state before every send. The process that syncs sees encryption being turned on as soon as it syncs, and otherwise trusts what it last read for up to a minute, so if syncing is stalled, a message can go out in plain text up to a minute after encryption was turned on. When it's invited to an encrypted room, or encryption is turned on in a room it bridges, it posts a notice saying so and leaves the room. Encryption can't be turned off again in Matrix, so make a new, unencrypted room for your agents. Element encrypts new private rooms by default: turn **Enable end-to-end encryption** off when you create the room.

## Before you begin

- **A Matrix homeserver** where you can register an account for the bot. A private homeserver, where only your organisation has accounts, is the right choice: see [Who can reach your agents](#who-can-reach-your-agents).
- **A Matrix account of your own** on a homeserver that can reach that one, to invite the bot and to talk to agents.
- **An admin account on the Switch server** you're connecting to. If Switch Console set that server up for you, you have one.

## Set up the bot account

### Register an account for the bot

Register it the way your homeserver registers anyone: from a client's sign-up page, or by your homeserver's administrator (`register_new_matrix_user` on Synapse). Give it a name people will recognise in a room, such as `switch` with the display name "Switch". Its full ID, such as `@switch:example.org`, goes on the connect form.

Use a dedicated account, and connect it to one Switch connection only: everything that connection posts comes from it, and Switch keeps its place in the conversation in the account's own (private) account data. Switch refuses a second connection on an account that is already connected, on any Switch tenant, because both would relay every room the account is in.

### Get its access token

The access token is what Switch signs in with. Either:

- **From the login API** (recommended, because the token belongs to a session nothing else uses):

  ```bash
  curl -XPOST https://matrix.example.org/_matrix/client/v3/login \
    -H 'Content-Type: application/json' \
    -d '{"type":"m.login.password",
         "identifier":{"type":"m.id.user","user":"switch"},
         "password":"<the bot password>",
         "initial_device_display_name":"Switch"}'
  ```

  The `access_token` in the answer is the token.

- **From Element:** sign in as the bot, then **Settings**, **Help & About**, **Advanced**, **Access Token**. Don't sign that Element session out afterwards: signing out revokes the token, and the connection stops.

**Warning**

The token grants complete control of the bot account, so never share it in a chat, ticket, or Switch room. If it leaks, sign out that session (or all of the bot's sessions) to revoke it, get a new one, and update **Access token** on the connection.

### Exempt the bot from rate limits

A busy agent posts often: its replies (a long one in several parts), a progress notice edited as it works, a 👀 on the message it's answering, and a reaction per option on every approval card. Homeservers limit how fast an account may send, and Synapse's default allows only a few messages a second. Switch waits and retries when the homeserver says to slow down: at least a second between tries, up to ten tries and half a minute for any one message, and a minute for a whole reply or approval card with its reactions. A homeserver asking for a wait longer than a minute isn't waited for. Past those limits, a long reply is cut short, with a notice saying how much of it arrived; a reply nothing of which arrived is tried again later.

So have the homeserver's administrator lift the limit for the bot account. On Synapse, with an administrator's access token:

```bash
curl -XPOST \
  "https://matrix.example.org/_synapse/admin/v1/users/@switch:example.org/override_ratelimit" \
  -H "Authorization: Bearer <an administrator's access token>" \
  -H 'Content-Type: application/json' \
  -d '{"messages_per_second": 0, "burst_count": 0}'
```

Zero for both means no limit. Other homeservers have their own setting for this; see their documentation.

## Connect Matrix to your Switch server

### Open the messaging apps for your server

In Switch Console, select the server in the sidebar switcher and open its **Home** page. **Messaging apps** lists what's connected.

### Start the connection

Select **Connect**, then choose **Matrix** under **Messaging app**.

If there's no **Connect** button, you're signed in to that server without admin rights. Connecting a messaging app is an administrator action, so ask whoever runs the server.

### Fill in the form

- **Homeserver URL**: the address clients use for the bot's homeserver, such as `https://matrix.example.org`. This isn't always the server name in the bot's ID: `@switch:example.org` may live at `https://matrix.example.org`. If you're not sure, `https://<server name>/.well-known/matrix/client` lists it. It must be `https`, because the token is sent to it with every request; plain `http` is accepted only for a homeserver on the Switch server's own machine, for development.
- **Bot user ID**: the bot account's full Matrix ID, such as `@switch:example.org`. Switch checks that the access token belongs to this account, and connects each account only once.
- **Access token**: the token from the previous step.
- **Accept invites from other homeservers**: off by default, so only accounts on the bot's own homeserver can invite it into a room, and anyone else's invite is declined. Turn it on if people on other homeservers should be able to bring the bot into their rooms.

If your homeserver is on a private network, the Switch server must be allowed to reach it: the server administrator lists it in `OUTBOUND_ALLOWED_PRIVATE_HOSTS`.

### Connect

Select **Connect**. Switch asks the homeserver whose token it is before saving anything, so a wrong or revoked token, a token of another account, or an address that isn't a homeserver's client API (a website at the server name, for example) is reported here with what to fix.

The first time a connection starts it begins from the present: messages already in the bot's rooms aren't replayed into Switch.

## Who can reach your agents

Anyone who can invite the bot into a room can talk to your agents there, and that room is created in Switch for them. **Accept invites from other homeservers** being off limits that to accounts on the bot's own homeserver, which is a real boundary only if that homeserver's accounts are your organisation's.

It doesn't protect you on a public homeserver such as matrix.org, where anyone can register an account and then invite the bot. Run the bot on a private homeserver, where registration is closed to people outside your organisation, or use the bot only in rooms you invite it to and keep its ID to yourselves.

Agents still answer only the people their addressing policy allows, wherever the room came from.

## Add the bot to a room

Invite the bot to the room like anyone else (in Element: **Invite to this room**, then its ID). The bot joins, Switch creates the room, and the room appears in Switch Console on its own. Then invite an agent with `!invite-agent @agent-name`.

A room with no name that only you and the bot are in is treated as a direct conversation: every message in it is for the room's one agent, without naming it. Any other room is a channel, where you address an agent by name.

When a room is upgraded to a new room version, the bot joins the new room, the Switch room moves with it, and the bot leaves the old room. The upgrade is followed only when the person who upgraded the room could also have invited the bot (see **Accept invites from other homeservers**) and the new room was created as the old one's replacement. If the bot can't join the new room, or the new room is encrypted, it says so in the old one.

## Link your Matrix account

On the server's **Home** page, find the connection under **Messaging apps** and select **Link my account…**, then search for yourself. Switch searches the homeserver's user directory. Most homeservers only show the bot people it shares a room with, or who are in a public room, so if you're not found, invite the bot into a room with you first, or post `!link-account <code>` in a room the bot is in.

## What to expect in Matrix

### Talking to agents

Address an agent by typing its name, such as `@coder`. Agents aren't Matrix accounts, so your client won't autocomplete their names or turn them into pills; post `!list-agents` to see which names the room has. Messages that don't name an agent still reach the room, where agents and the people in Switch can read them.

Mentioning the bot itself (a pill, or its ID) reaches the room's only agent, or the agent you've made the bot an alias for.

Agents mention people as real Matrix mentions (pills), which notify them. A room-wide `@room` is used only when Switch marks a message as room-wide, and needs the bot to have the power level to notify the room.

Notices (`m.notice`), which is how Matrix bots and integrations post, reach the room but never run a command or answer a card. The same goes for messages from another Switch bridge in the room.

### Threads and replies

Matrix threads are Switch threads, both ways: a message in a thread reaches the room in that thread, and an agent answering in a thread answers in the Matrix thread. A reply outside a thread (Element's **Reply**) is treated as a thread under the message it replies to, so the agent's answer goes there; a reply to a message that is itself in a thread belongs to that thread.

### Edits and deletions

Edits and deletions made in Matrix aren't carried into Switch yet; Switch's own edits and deletions are mirrored to Matrix. So when you edit a message in Matrix, the Switch room and its agents keep what you first wrote, and a message you delete in Matrix stays in the Switch room. To correct something an agent should act on, send it again as a new message. When an agent's message or status changes in Switch, it's edited in place in Matrix (shown as "(edited)"), and a message Switch removes is redacted.

### Formatting and message length

Agent Markdown is sent as formatted HTML, with the Markdown itself as the plain-text version for clients that don't show formatting. Raw HTML in an agent's text is shown as text, not rendered. Links go only to web, mail and Matrix addresses; any other link keeps its text and loses its target. An image an agent links from elsewhere is shown as its description, because Matrix clients show only images stored on a homeserver.

A long reply is split across several messages, on line boundaries, each starting with the agent's name. A code block that's split is closed at the end of one message and reopened in the next.

### Attachments

Files go both ways. Switch uploads an agent's file to the homeserver and posts it as an image, video, audio or file message, captioned with the agent's name. A file larger than the homeserver accepts (its upload limit) isn't uploaded, and the room gets a message naming the file and the limit instead; so does a file whose message the homeserver refuses.

Files people send are downloaded through the homeserver's authenticated media API. A file larger than the Switch server's attachment limit isn't downloaded, and the room is told which file wasn't relayed and why. Encrypted attachments can't be read and are reported the same way, as is a download the homeserver redirects to another server (the bot's token is never sent there).

### Commands

Switch commands are typed with `!`, such as `!invite-agent @coder` or `!list-agents`. Matrix has no way for a bot to register `/` commands, so there are none.

### Knowing an agent is working

The message that asked is marked with 👀 while the agent works on it (⏳ while it's queued behind other work), and the bot shows as typing when a turn starts. The agent's progress is a notice from the bot that's edited in place as the turn goes on.

### Approvals and questions

Matrix has no buttons, so a card asking you to approve something lists its options by number, and the bot adds one keycap reaction per option under it (1️⃣, 2️⃣, …). **React with the number of your choice**, or reply with the card's handle and the number as the card says (`A3 1`). Either way Switch records the answer as given from Matrix, the card is edited to show the outcome, and the keycaps are taken off it. Only the bot's own cards can be answered this way.

Only people allowed to address the agent can answer; anyone else is told in the card's thread that their answer didn't land. A card too long to show in full in one message says so and is answered in Switch Console instead.

### Creating rooms from Switch

An agent or a person in Switch Console can create a Matrix room for a new Switch room. Switch creates it on the bot's homeserver, asking for no encryption, and invites the people asked for. A private room is invite-only. A public one isn't listed in the room directory, but anyone who can reach the homeserver and knows the room's address can join it, people on other homeservers federated with it included.

Some homeservers encrypt every new room whatever is asked (on Synapse, `encryption_enabled_by_default_for_room_type`). Switch can't use such a room, so it leaves it and says why: turn that setting off for the bot's rooms, or create the room in Matrix without encryption and invite the bot.

Deleting the room in Switch makes the bot leave it; the Matrix room itself stays, as Matrix rooms can't be deleted.

### Links

A room gets an **Open in Matrix** link through `matrix.to`, which opens it in whatever client the reader uses. Matrix clients only open web links, so **Open in Switch Console** links work once the Switch server has a public address configured.

## What Matrix can't do here

- **Encrypted rooms** are refused, as above.
- **Edits and deletions made in Matrix** aren't carried into Switch yet.
- **Slash commands**: Matrix has none a bot can register. Use `!` commands.
- **A sender per agent**: every agent posts as the bot, with its name in the message.
- **Buttons**: cards are answered with reactions or a typed reply.
- **Stopping an agent from its status message**: use `!interrupt` in the room, or Switch Console.

## Several Switch processes, restarts and outages

Only the Switch process that holds the connection syncs with the homeserver; others only send. Switch keeps its place in the account data of the bot account, under a type named for the connection, and moves it on once each batch of events has reached Switch. After a restart, a move to another process or an outage, it carries on from there and reads back what the homeserver left out of the first batch, up to the 2,000 most recent events in each room. A batch that was being handled when a process stopped is read again, and nothing in it reaches the room twice, because each message is recognised by its Matrix event id.

If Switch can't take any of the events in a batch (its own database unavailable, say), it holds its place and reads the batch again, backing off up to a minute between tries, for as long as it takes; nothing is skipped, and the connection says so on the server's **Home** page meanwhile. If one event keeps failing while others in the same batch get through, that event alone is skipped after three tries, and the server log names it at error level, as it does every room whose history couldn't be read back. If syncing keeps failing, the connection says so on the server's **Home** page until it works again.

## Troubleshooting

- **"The homeserver … does not accept this access token"**: the token was revoked (its session was signed out) or mistyped. Get a new one.
- **"That access token belongs to …, not …"**: the token is another account's, or **Bot user ID** is mistyped.
- **"… is not a Matrix homeserver's client API"**: **Homeserver URL** points at a website, usually the server name. Use the address clients use; `https://<server name>/.well-known/matrix/client` lists it.
- **"Could not reach the homeserver"**: check **Homeserver URL**, and that the Switch server may reach it (`OUTBOUND_ALLOWED_PRIVATE_HOSTS` for a private one).
- **"… is already claimed"**: another connection, perhaps on another Switch tenant, already uses this bot account. Use a separate account for each connection.
- **The connection says the token is no longer accepted**: the token was revoked while the connection was running. Nothing reaches Switch until you paste a new one.
- **The connection says it has not been able to sync**: the homeserver is unreachable or answering with errors; the message says what it answered. Switch keeps trying.
- **Long replies arrive cut short, with a notice**, or **the connection says the homeserver is rate-limiting the bot**: [exempt it](#exempt-the-bot-from-rate-limits).
- **The connection says messages from Matrix are held**: Switch couldn't store them (the message says why). They're kept and retried until it can; nothing is skipped.
- **The bot doesn't join when invited**: it only accepts invites from its own homeserver unless **Accept invites from other homeservers** is on; a declined invite is logged on the Switch server.
- **The bot joined and left at once, with a notice**: the room is encrypted. Make an unencrypted room.
- **Agents don't answer**: check an agent is in the room (`!list-agents`), and that you addressed it by name in a room with more than one person.

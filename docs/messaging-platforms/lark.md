# Lark / Feishu

Connect a Lark or Feishu workspace to Switch with a custom app you create in
your own tenant. Lark is the international product (open.larksuite.com) and
Feishu the mainland-China one (open.feishu.cn). They work the same way, and
you choose which one when you connect.

Lark calls Switch for every event, so Switch has to be reachable over HTTPS
(see [Before you start](#before-you-start)).

## Before you start

- **Switch must have a public HTTPS address.** Set `MESSAGING_PUBLIC_URL` to the
  public origin (scheme and host, no path, https only), and route the
  `/messaging` path prefix to switch-core. For local testing, a tunnel works:
  `cloudflared tunnel --url http://localhost:8000` or `ngrok http 8000`, with
  `MESSAGING_PUBLIC_URL` set to the https URL it prints.
- **You need permission to create apps** in the Lark developer console for your
  tenant. In some tenants an admin must approve the app before it can be used.

## 1. Create the app

1. Open the developer console: [open.larksuite.com/app](https://open.larksuite.com/app)
   for Lark, or [open.feishu.cn/app](https://open.feishu.cn/app) for Feishu.
2. Click **Create Custom App**. Give it a name (for example *Switch*), a
   description and an icon. People see this name on every message the agents
   send.
3. Under **Add Features**, add **Bot**.
4. On **Credentials & Basic Info**, copy the **App ID** (starts with `cli_`)
   and the **App Secret**.

## 2. Grant permissions

On **Permissions & Scopes**, add:

| Permission | Why |
|---|---|
| `im:message:send_as_bot` | Post the agents' replies as the bot. |
| `im:message` | Edit and delete what the bot posted, and read message files. |
| `im:message.p2p_msg:readonly` | Receive direct messages sent to the bot. |
| `im:message.group_at_msg:readonly` | Receive group messages that mention the bot. |
| `im:resource` | Download files people send, and upload the agents' files. |
| `im:chat` | Create group chats for new rooms, add people, and leave a chat when its room is deleted. |
| `contact:user.base:readonly` | Show people's names in Switch. Without it, people appear by their Lark id. |

Optional: `im:message.group_msg` (read all group messages) lets every message in
a group reach the room, not only the ones that mention the bot. Lark treats it
as sensitive, and a tenant admin may have to approve it.

## 3. Set up encryption

On **Events & Callbacks → Encryption Strategy**:

1. Set an **Encrypt Key**. Switch accepts only encrypted, signed deliveries, so
   this is required.
2. Copy the **Encrypt Key** and the **Verification Token**.

## 4. Connect it in Switch

In Switch Console, open **Connect a messaging app** and choose **Lark**. Fill in:

| Field | What to enter |
|---|---|
| **Region** | *Lark* for open.larksuite.com, *Feishu* for open.feishu.cn. It must match where you created the app. |
| **App ID** | From Credentials & Basic Info. |
| **App Secret** | From Credentials & Basic Info. |
| **Encrypt Key** | From Events & Callbacks → Encryption Strategy. |
| **Verification Token** | From Events & Callbacks → Encryption Strategy. |

Switch checks the App ID and App Secret with Lark before saving. Once
connected, it shows the connection's address, ending in
`/messaging/bridges/<bridge id>/events`. Copy it.

## 5. Point Lark at Switch

Back in the developer console:

1. On **Events & Callbacks → Event Configuration**, choose **Send events to
   developer's server**, paste the address, and save. Lark checks the address
   straight away; Switch answers it.
2. Click **Add Events** and add:
   - `im.message.receive_v1` (Message received)
   - `im.chat.member.bot.added_v1` (Bot added to a group)
   - `im.chat.member.user.added_v1` (User added to a group)
3. On **Events & Callbacks → Callback Configuration**, choose **Send callbacks
   to developer's server**, paste the same address, and add the
   `card.action.trigger` callback. This is what makes the buttons on approval
   and question cards work.
4. **Create a version** of the app and publish it. Changes to permissions and
   events take effect only in a published version.

## 6. Use it

Add the bot to a group chat (group settings → **Bots** → **Add Bot**). Switch
creates a room for the chat. Mention an agent by name (`@helper`) to address it.
Direct messages to the bot work too.

## How things map

- **A group chat is a room**, and a direct chat with the bot is a direct room.
  A new room created from Switch creates a group chat.
- **Threads.** A reply inside a thread stays in that thread, and the agent
  answers there.
- **Agents.** One bot speaks for every agent. Lark gives an app no per-message
  name or avatar, so each message carries the agent's name as its title.
- **Approval and question cards** are interactive cards with a button per
  option. A card can also be answered by typing, as everywhere else. Once
  answered, the card is updated to show the outcome for everyone in the chat.
- **Files** go both ways. Files people send larger than the deployment's
  attachment limit are not relayed, and the room says so. Lark accepts uploads
  up to 10 MB for images and 30 MB for other files; an agent's file over that is
  refused in the chat with a message saying why.
- **Edits and deletes** that Switch makes to an agent's message are made in
  Lark too.
- **`!commands`** work as typed messages.

## What doesn't work

- **No typing indicator.** Lark has none for bots.
- **No directory search.** A bot can only see people who have messaged it or
  share a chat with it, so people are found when they first speak.
- **No slash commands.** Use `!commands` instead.
- **Edits people make in Lark are not mirrored** into the room. The room keeps
  the message as it was first sent.
- **Only http(s) links** are clickable in Lark.
- **Deleting a room** takes the bot out of its chat but leaves the chat itself.
  The chat's owner can delete it in Lark.

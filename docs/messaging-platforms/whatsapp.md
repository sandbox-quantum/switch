# Connect WhatsApp

_Let people message your Switch agents on WhatsApp, through your own Meta app and business number_

WhatsApp connects through the **WhatsApp Business Cloud API**, with a Meta app and a phone number that you own. People message that number, and each chat with it becomes a room in Switch. One number fronts all of your agents, so each agent is identified by its name in bold at the head of what it sends.

Meta delivers messages by calling Switch, so **Switch has to be reachable over public HTTPS** (see [The webhook address](#the-webhook-address)).

**Warning**

A WhatsApp chat always starts with the person. A business can't open a chat, and it can only write to someone **within 24 hours of their last message**. After that WhatsApp accepts only pre-approved template messages, which Switch doesn't send. So Switch can't create a chat or bind a room to a phone number you type in, and a reply after the window has closed isn't delivered: Switch logs why (see [The 24-hour window](#the-24-hour-window)).

**Warning**

A business number is public: anyone who knows it can message it, and every new chat becomes a room. So decide which agents a stranger can reach before you connect a number. Name them in **Agents in new chats**, and set each agent's addressing policy so it answers only the people it should. The commands that reach every agent on the server, `!invite-agent` and `!list-switch-agents`, are refused in WhatsApp chats. The one exception is `!invite-agent` for an agent named in **Agents in new chats**.

## Before you begin

- **A Meta developer account** at [developers.facebook.com](https://developers.facebook.com), and a **Meta business portfolio** to own the app.
- **A phone number for the business.** To try it out, the free test number Meta gives every new WhatsApp app is enough.
- **Switch reachable over HTTPS** from the internet, with `MESSAGING_PUBLIC_URL` set. For local development a tunnel works, as described below.
- **An admin account on the Switch server** you're connecting to.

## Set up the Meta side

### Create the app

1. In [Meta for Developers](https://developers.facebook.com/apps), select **Create app**.
2. Choose the use case **Connect with customers through WhatsApp**, and attach the app to your business portfolio.
3. Open **WhatsApp → API Setup**. Meta gives the app a test phone number.

### Collect what the connect form asks for

| Field in Switch | Where to find it |
|---|---|
| **App ID** | At the top of the app's dashboard. |
| **Phone number ID** | **WhatsApp → API Setup**, under the number. This is Meta's id for the number, not the number itself. |
| **Access token** | A permanent token for a system user (next step). |
| **App secret** | **App settings → Basic → App secret** (select **Show**). |
| **Verify token** | A phrase you make up. You'll enter the same phrase in Meta when you set up the webhook. |
| **Agents in new chats** | Optional. The names of the agents to put in each new chat, separated by commas, for example `triage, support`. |

### Generate a permanent access token

The token on the **API Setup** page expires after 24 hours, so use it only for a first test. For a connection that keeps working:

1. In [Business settings](https://business.facebook.com/settings), open **Users → System users** and add a system user (an **Admin** system user is simplest).
2. **Assign assets**: give it your app, and your WhatsApp account with full control.
3. **Generate new token** for your app, with the permissions **`whatsapp_business_messaging`** (to send and receive messages) and **`whatsapp_business_management`** (to manage the number). Choose **Never** for expiry.

**Warning**

The access token and the app secret together control your business number. Keep them in your password manager or your deployment's secret store, and never paste them into a chat, a ticket or a Switch room. If one leaks, generate a new token (or reset the app secret) and update the connection.

### Let the test number reach you

Meta's test number can only message phone numbers you've added as recipients. Under **WhatsApp → API Setup → To**, add your own number and confirm the code WhatsApp sends you. A number of your own, once registered, has no such limit.

## Connect WhatsApp to your Switch server

1. In Switch Console, select the server in the sidebar switcher and open its **Home** page.
2. Select **Connect** under **Messaging apps**, then choose **WhatsApp**.
3. Name the connection, and fill in the fields from the table above.
4. Select **Connect**.

Switch checks the credentials with Meta before saving, and says what's wrong if they don't work:

- a token that has expired or been revoked;
- a token from a different app than the app ID and secret;
- a token without the `whatsapp_business_messaging` permission;
- a wrong app secret;
- a phone number ID the token can't reach.

### One connection per Meta app

Meta sends all of an app's WhatsApp events to **one** webhook address, so one Meta app can back only one Switch connection. Switch refuses a second connection for the same app ID. To connect a second number, give it its own Meta app.

## The webhook address

Once connected, Switch shows the connection's webhook address, ending in `/messaging/bridges/<id>/events`. Then:

1. In your Meta app, open **WhatsApp → Configuration**.
2. Under **Webhook**, select **Edit**. Paste the address as the **Callback URL** and your phrase as the **Verify token**, then select **Verify and save**. Meta calls the address once to check it, and Switch answers only if the phrase matches.
3. Under **Webhook fields**, **subscribe to `messages`**. Without it, Meta delivers nothing.

Every delivery is signed with your app secret (`X-Hub-Signature-256`). Switch refuses any delivery whose signature doesn't match, before reading it, and every call Switch makes to Meta carries an `appsecret_proof`. That means you can turn on **Require App Secret** under **App settings → Advanced**.

The address must be public HTTPS with a certificate browsers trust:

- `MESSAGING_PUBLIC_URL` is set to Switch's public origin, for example `https://switch.example.com`. Without it the connection has no address and doesn't start.
- The `/messaging` path is routed to switch-core.
- For local development, run `cloudflared tunnel --url http://localhost:8000` or `ngrok http 8000`, and set `MESSAGING_PUBLIC_URL` to the https URL it prints.

## Confirm it worked

From your phone, send a message to the business number. The chat appears as a room in Switch named after you, and WhatsApp marks the message read.

If you named **Agents in new chats**, those agents are in the room, and a message that mentions one, like `@triage can you take a look?`, gets a reply under its name. A WhatsApp chat is a direct conversation, so Switch Console can't change its agents. If the chat began before you named an agent in **Agents in new chats**, send `!invite-agent @triage` in the chat to bring that agent in.

## What to expect in WhatsApp

### Chats and rooms

Every chat is one person and the business number, and that person can be someone with a WhatsApp username whose number isn't shared: Switch knows them by the id Meta gives them. In the room, a person goes by their WhatsApp profile name followed by a short code, so two people with the same name, or someone who named themselves after an agent, stay distinct, and the room never shows their number. Group chats aren't supported: a group message isn't relayed, and Switch logs that it was skipped. Messages that don't mention an agent still reach the room.

### Replies and threads

WhatsApp has no threads. When someone quote-replies to a message, Switch threads their message under the one they quoted, and an agent's reply in a thread quotes the message it answers.

### Approvals and questions

When an agent asks for approval or asks a question, the card arrives with **native WhatsApp buttons**:

- **Up to three options** arrive as reply buttons, each numbered as in the card.
- **Four to ten options** arrive as a list behind a **Choose an answer** button.
- **More than ten options**, or a question that needs typed input, arrive as text. You answer by typing, exactly as the card says.

A tap is attributed to the person who tapped, shows in the chat as their reply, and is recorded in Switch as answered from WhatsApp. WhatsApp can't edit a message once it's sent, so the buttons stay on the card after it's answered. If an answer doesn't land, for example a tap on a card that's already settled, Switch says so in the chat.

### Knowing an agent is working

The message that asked is marked with 👀 while the agent works, and WhatsApp shows the typing indicator. A turn's live progress isn't drawn, because a sent message can't be updated. If a turn fails, or the agent's host goes offline, the chat gets a message saying so.

### Commands

`!commands` work as on every platform: send `!list-agents` or `!interrupt` as a message. WhatsApp has no `/` command menu. `!invite-agent` and `!list-switch-agents` are refused here, with a reply saying why, because they reach every agent on the server and anyone can message a business number. `!invite-agent` is taken only for an agent named in **Agents in new chats**.

### The 24-hour window

WhatsApp is the authority on its own window. A reply outside it is refused, either straight away or, more often, a moment later in a delivery report. Switch logs either one as an error that names the 24-hour rule and the chat (by the last digits of the number). The reply isn't retried: write again once the person has.

### Formatting and message length

Agent replies are converted to WhatsApp formatting: `*bold*`, `_italic_`, `~strikethrough~`, `` `code` `` and code blocks. Headings become bold lines, and a link becomes its label followed by its address. A reply over 4,096 characters is split at paragraph breaks, and a code block split across two messages is closed and reopened, so both parts stay readable.

### Attachments

Files work both ways:

- **Sent from an agent:** JPEG and PNG images (5 MB), MP4 and 3GP video (16 MB) and common audio formats (16 MB) are sent inline. A larger one, and PDF, Word, Excel and PowerPoint files, are sent as documents (100 MB). Other text files, such as JSON or Markdown, are sent as plain text documents under their own names.
- **Not sent:** a file WhatsApp doesn't take (a GIF or a ZIP, say), or one over 100 MB, isn't sent. A message naming the file and the reason goes instead.
- **From the person:** images, video, audio, documents and stickers reach the room. A file over the server's attachment limit isn't downloaded, and the room is told so.
- **Locations and contacts** arrive as a line of text describing them.

### What WhatsApp can't do

| | |
|---|---|
| Start a chat, or create a channel for a room | No: the person starts every chat |
| Reply more than 24 hours after the person's last message | No: not delivered, and Switch logs why |
| Edit or delete a message once sent | No: edits and deletes in Switch stay in Switch |
| Group chats | No |
| Search the people who can be added | No: only people who have messaged the number are known |
| Show an agent under its own name and avatar | No: one number speaks for every agent, named in the message |
| Delete the chat when a room is deleted | No: the chat stays in WhatsApp |

## Running several replicas

A WhatsApp connection keeps nothing in one process. Any replica can take a delivery, and a retried delivery is recognised by its message ids and handled once, through the database. A delivery older than Switch remembers is dropped rather than taken as new, so a signed delivery played back later doesn't reach the room. The typing indicator and the 👀 mark both point at the message that asked, which the replica holding the connection is given with the work.

## Next steps

- [Create a room](../official/getting-started/create-a-room.md): rooms on WhatsApp appear when someone messages the number.
- [Onboard your agents](../official/getting-started/onboard-your-agents.md): register an agent with the server so you can name it in **Agents in new chats**.

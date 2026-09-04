# Connect Microsoft Teams

_Put your Switch agents in a Teams tenant — the one platform that needs Switch publicly reachable_

Published at <https://docs.flintai.dev/flintai/switch/deploy/messaging-apps/microsoft-teams> — link readers there, not to this file.

Microsoft Teams is the most involved platform to connect, and it's worth knowing why before you start. One Azure bot application backs every agent on your Switch server, and each agent's messages render as a card headed with its name.

Teams also needs **Switch reachable from the internet**. Microsoft pushes messages to Switch rather than Switch opening a connection outward, so the connection hosts its own HTTPS listener and Microsoft has to be able to reach it.

**Warning**

Most of the work here is Azure and Microsoft 365 administration, not Switch configuration. Treat it as an ops task with a directory administrator involved, and get all of it in place before you open the connect form — the form asks for things that don't exist yet otherwise.

## How Switch sees a Teams channel

Two Microsoft interfaces feed the connection, and the split explains a failure you'd otherwise spend a long time on:

- **The Bot Framework** delivers one-to-one chats and group chats in full, but channel messages **only when the bot is tagged**. It's also how Switch posts back.
- **Microsoft Graph change notifications** deliver everything else in a channel. Graph sends the message bodies encrypted, which is what the certificate below is for.

Set up the first and not the second and you get a bridge that looks like it works: agents answer when tagged, and quietly miss every other message in the channel.

## Before you begin

Each of these is created in Azure or the Microsoft 365 admin center, not in Switch:

- **An Azure AD app registration.** This gives you the bot client id, a client secret, and your tenant id.
- **An Azure Bot resource** on that app, with its messaging endpoint set to `https://<your-public-host>/api/messages` and the Microsoft Teams channel enabled.
- **A Teams app package** that includes the bot, installed into the target team so it can be added to channels and post without being spoken to first.
- **Graph permissions, admin-consented.** `ChannelMessage.Read.Group` — resource-specific, and the one to prefer — or tenant-wide `ChannelMessage.Read.All`. Plus `Channel.Create` and `TeamMember.ReadWrite.All` or `ChannelMember.ReadWrite.All` for provisioning.
- **An encryption certificate.** An X.509 certificate whose public half you hand to Graph and whose private key Switch holds to decrypt message bodies. Give it a stable id you can reuse.
- **Public HTTPS ingress** routing `https://<your-public-host>/api/messages` and `https://<your-public-host>/api/teams/notifications` to the Switch server's Teams listener. Graph needs valid TLS and an answer to its validation handshake within ten seconds.

On the Switch side you need one thing: **an admin account on the Switch server** you're connecting to. If Switch Console set that server up for you, you have one.

**Note**

Resource-data subscriptions draw on a per-tenant quota shared across everything using them in your organization. Worth checking before you add another consumer of it.

## Connect Teams to your Switch server

### Open the messaging apps for your server

In Switch Console, select the server in the sidebar switcher and open its **Home** page. **Messaging apps** lists what's connected.

### Start the connection

Select **Connect**, then choose **Microsoft Teams** under **Messaging app**.

If there's no **Connect** button, you're signed in to that server without admin rights. Connecting a messaging app is an administrator action, so ask whoever runs the server.

### Name the connection

**Name** is how this connection is labeled in Switch Console when you pick it for a room, so name it after the tenant.

### Fill in the Azure details

- **App Id** — the Azure AD app client id.
- **App Password** — its client secret.
- **Tenant Id** — your Azure AD tenant id.
- **Team Id** — the team that channels created from Switch are provisioned into.
- **Public Base Url** — the public HTTPS address your listener is reachable at. Switch builds the notification address it gives Graph from this, so it has to be the address Microsoft can actually reach.

### Fill in the channel-capture details

These come next on the form, and the required one comes last — read the labels rather than the order.

- **Encryption Certificate Id** *(optional)* — the stable id you gave the certificate.
- **Encryption Public Certificate** *(optional)* — the PEM public certificate handed to Graph.
- **Encryption Private Key** *(optional)* — the PEM private key Switch decrypts with.
- **Client State** — a shared secret Graph echoes back in every notification. **Required.**

The three encryption fields are marked optional because the connection runs without them. It runs *reduced*: outbound, chats and tagged messages work, and per-channel capture is skipped with an error in the log. Supply all three unless you only ever want agents to hear what's explicitly addressed to them.

### Connect

Select **Connect**.

### Link your Teams account

Switch Console then asks which Teams account is yours. Search for yourself and select **This is me**.

An agent set to answer only its owner can't recognize you until you do — your messages read as if from a stranger. **Skip for now** is available, and the connection's row offers **Link my account…** later.

**Note**

Client State isn't optional security. Graph encrypts message bodies with your public certificate, and anyone can encrypt to a public certificate — so encryption proves the message wasn't tampered with, not that Microsoft sent it. The shared secret is the only thing that establishes where a notification came from, and Switch checks it on every one.

## Bring Switch into a channel

Add the Switch app to the channel from Teams. The room is created when the bot is added, and you don't need to add an agent first.

Going the other way, a room created in Switch gets a Teams channel made for it, as long as you left channel creation allowed. That applies to rooms an agent creates as well as ones you create in Switch Console.

## Confirm it worked

- The connection is listed under **Messaging apps** on the server's **Home** page with no error beside its name.
- The channel appears under **Your Rooms** in Switch Console.
- An agent answers a message that **doesn't** tag it. This is the test that matters — a bot that only answers when tagged is the signature of channel capture not being configured.

## What to expect in Teams

- **Agents appear as cards.** Each message renders as a card headed with the agent name and avatar, rather than as a post from a named sender.
- **Only the `!` command form works.** Teams has no native slash command integration for Switch.
- **Attachments are named, not carried.** Files aren't relayed in either direction yet — the text bridges and a note says what wasn't carried, so nothing goes missing silently.
- **Mentions from agents are plain text.** An agent writing `@name` bridges as those characters rather than as a real Teams mention.
- **Rooms are channels, not direct messages.** A one-to-one conversation with an agent isn't supported here.
- **One Teams connection per listener port.** Running more than one on a host means giving each its own port and its own ingress route.

## Next steps

- [Create a room](../../getting-started/create-a-room.md) — Turn a Teams channel into a room, or let Switch make the channel

- [Onboard your agents](../../getting-started/onboard-your-agents.md) — Register an agent with the server so you can invite it into the room

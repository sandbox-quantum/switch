# Connect Microsoft Teams

_Put your Switch agents in a Teams tenant. Teams needs Switch reachable from the internet._

Published at <https://docs.switchagents.ai/switch-rooms/deploy/messaging-apps/microsoft-teams> — link readers there, not to this file.

import { Admin } from "/snippets/admin-badges.jsx";
import { BuddyGuide } from "/snippets/chat-message.jsx";
import { ComingIn } from "/snippets/version-badges.jsx";

<BuddyGuide>
  Connecting a chat app is a one-time job for an admin of your workspace. If someone already did, you don't need this page. [Start here](../../getting-started/index.md) shows what you do need.
</BuddyGuide>

Connecting Microsoft Teams takes Azure and Microsoft 365 administration, and a publicly reachable HTTPS address. One Azure bot application represents every agent in the Switch workspace you connect it to, and each agent's messages render as a card headed with its name.

Microsoft pushes messages to Switch, so the connection runs its own HTTPS listener, and **Microsoft must be able to reach it from the internet**.

**Note**

Complete the Azure and Microsoft 365 steps with a directory administrator before you open the connect form. The form asks for the values these steps produce.

## How Switch sees a Teams channel

Teams sends messages to Switch through two Microsoft interfaces. This split explains why tagged messages can work while other channel messages don't:

- **The Bot Framework** delivers one-to-one chats and group chats in full, but channel messages **only when the bot is tagged**. Switch also posts replies through the Bot Framework.
- **Microsoft Graph change notifications** deliver everything else in a channel. Graph sends the message bodies encrypted, and Switch creates the certificate that decrypts them when you connect.

If you set up only the Bot Framework, the connection looks like it works: agents answer when tagged, but miss every other message in the channel.

## Before you begin

In Azure and the Microsoft 365 admin center, you'll need:

- **An Azure AD app registration:** It gives you the bot client id, a client secret, and your tenant id.
- **An Azure Bot resource on that app:** Its messaging endpoint set to `https://<your-public-host>/api/messages`, with the Microsoft Teams channel enabled.
- **A Teams app package that includes the bot:** Installed into the target team, so the bot can be added to channels and post without being spoken to first. Switch ships one. See [Set up the Teams app](#set-up-the-teams-app).
- **Admin-consented Graph permissions:**
  - `ChannelMessage.Read.Group` (resource-specific, and preferred) or tenant-wide `ChannelMessage.Read.All`. Resource-specific consent can't capture messages in private or shared channels, so choose tenant-wide if you'll use those.
  - For provisioning: `Channel.Create`, `Channel.ReadBasic.All`, `User.ReadBasic.All`, `TeamMember.ReadWrite.All` for standard channels, and `ChannelMember.ReadWrite.All` for private channels. Grant all of them.
- **Public HTTPS ingress:** Routing `https://<your-public-host>/api/messages` and `https://<your-public-host>/api/teams/notifications` to the Switch server's Teams listener, which listens on port 3978 unless an admin has set another. Graph needs valid TLS and an answer to its validation handshake within ten seconds.

In Switch, you'll need:

- **An [admin](../../resources/glossary.md#admin) account on the Switch server you're connecting to:** If Switch Console set up the server for you, you have one.
- **A listener port of its own, if the server already has a Teams connection:** Each connection needs its own port and ingress route. An admin sets them.

**Note**

Resource-data subscriptions draw on a per-tenant quota shared by everything in your organization that uses them. Check it before adding another consumer.

## Set up the Teams app

A Teams app package puts the bot in your tenant. It's a zip holding the manifest and its
icons, and Switch ships a complete one.

### Save the manifest and the icons

Save the manifest below as `manifest.json`, and download the icons from
[`docs/old/bridges/teams-app/`](https://github.com/sandbox-quantum/switch/tree/main/docs/old/bridges/teams-app)
into the same folder: `color.png` (192×192) and `outline.png` (32×32).

A Teams manifest points at icons by filename inside the package, not by URL,
and a package without both won't install.

### Agent Switch app manifest

```json
{
    "$schema": "https://developer.microsoft.com/json-schemas/teams/v1.29/MicrosoftTeams.schema.json",
    "manifestVersion": "1.29",
    "version": "1.0.0",
    "id": "00000000-0000-0000-0000-000000000000",
    "developer": {
        "name": "Agent Switch",
        "websiteUrl": "https://example.com",
        "privacyUrl": "https://example.com/privacy",
        "termsOfUseUrl": "https://example.com/terms"
    },
    "name": {
        "short": "Agent Switch",
        "full": "Agent Switch \u2014 your AI agents, in your channels"
    },
    "description": {
        "short": "Work with your AI agents in Teams channels and chats.",
        "full": "Agent Switch puts your AI agents into Microsoft Teams. Mention an agent by name in a channel and it answers there, in the same conversation, with its progress shown on the message while it works. Each Switch room is a Teams channel, so the people and the agents share one thread of context rather than one per tool.\n\nThis app is the Teams end of a Switch deployment you run yourself. It talks only to your own Switch server: no conversation data reaches the app's authors, and there is no hosted service behind it.\n\nIn a chat, type /help. In a channel, mention the app first: @Agent Switch /help."
    },
    "icons": {
        "color": "color.png",
        "outline": "outline.png"
    },
    "accentColor": "#3F3C3B",
    "supportsChannelFeatures": "tier1",
    "bots": [
        {
            "botId": "00000000-0000-0000-0000-000000000000",
            "scopes": [
                "team",
                "personal",
                "groupChat"
            ],
            "supportsTargetedMessages": true,
            "isNotificationOnly": false,
            "supportsFiles": false,
            "commandLists": [
                {
                    "scopes": [
                        "team",
                        "groupChat",
                        "personal"
                    ],
                    "triggers": [
                        "mention"
                    ],
                    "commands": [
                        {
                            "title": "/help",
                            "description": "Show every in-room command"
                        },
                        {
                            "title": "/list-agents",
                            "description": "List the agents in this room"
                        },
                        {
                            "title": "/agents-status",
                            "description": "Show each agent's presence and capabilities"
                        },
                        {
                            "title": "/invite-agent",
                            "description": "Add an existing agent: /invite-agent @agent-name"
                        },
                        {
                            "title": "/agents-greet",
                            "description": "Have the agents here introduce themselves"
                        },
                        {
                            "title": "/roles",
                            "description": "List this room's roles and who holds each"
                        },
                        {
                            "title": "/list-aliases",
                            "description": "List this room's agent aliases"
                        },
                        {
                            "title": "/set-alias",
                            "description": "Give an agent a room alias: /set-alias @agent-name @alias"
                        },
                        {
                            "title": "/reset",
                            "description": "Reset an agent's session: /reset @agent-name"
                        },
                        {
                            "title": "/interrupt",
                            "description": "Interrupt an agent's current turn: /interrupt @agent-name"
                        },
                        {
                            "title": "/list-switch-agents",
                            "description": "List every agent on this Switch, to find one to invite"
                        },
                        {
                            "title": "/room-url",
                            "description": "Show this room's address in Switch"
                        }
                    ]
                },
                {
                    "scopes": [
                        "team",
                        "groupChat",
                        "personal"
                    ],
                    "triggers": [
                        "slash"
                    ],
                    "commands": [
                        {
                            "title": "help",
                            "description": "Show every in-room command"
                        },
                        {
                            "title": "list-agents",
                            "description": "List the agents in this room"
                        },
                        {
                            "title": "agents-status",
                            "description": "Show each agent's presence and capabilities"
                        },
                        {
                            "title": "invite-agent",
                            "description": "Add an existing agent: /invite-agent @agent-name"
                        },
                        {
                            "title": "agents-greet",
                            "description": "Have the agents here introduce themselves"
                        },
                        {
                            "title": "roles",
                            "description": "List this room's roles and who holds each"
                        },
                        {
                            "title": "list-aliases",
                            "description": "List this room's agent aliases"
                        },
                        {
                            "title": "set-alias",
                            "description": "Give an agent a room alias: /set-alias @agent-name @alias"
                        },
                        {
                            "title": "reset",
                            "description": "Reset an agent's session: /reset @agent-name"
                        },
                        {
                            "title": "interrupt",
                            "description": "Interrupt an agent's current turn: /interrupt @agent-name"
                        },
                        {
                            "title": "list-switch-agents",
                            "description": "List every agent on this Switch, to find one to invite"
                        },
                        {
                            "title": "room-url",
                            "description": "Show this room's address in Switch"
                        }
                    ]
                }
            ]
        }
    ],
    "permissions": [
        "identity",
        "messageTeamMembers"
    ],
    "validDomains": [
        "switch.example.com"
    ],
    "webApplicationInfo": {
        "id": "00000000-0000-0000-0000-000000000000",
        "resource": "https://graph.microsoft.com"
    },
    "authorization": {
        "permissions": {
            "resourceSpecific": [
                {
                    "name": "ChannelMessage.Read.Group",
                    "type": "Application"
                },
                {
                    "name": "ChannelSettings.Read.Group",
                    "type": "Application"
                }
            ]
        }
    }
}
```

### Replace the placeholders

- Replace the null GUID `00000000-0000-0000-0000-000000000000` in `id`, `bots[0].botId`, and `webApplicationInfo.id` with your Azure bot's app ID. Use the same value in each place. The shared ID ties the Teams app, the bot, and the
  Azure AD registration together.
- Replace `switch.example.com` in `validDomains` with the host of your public base
  address.
- Replace `https://example.com`, `https://example.com/privacy`, and `https://example.com/terms` with your
  organization's pages. Teams accepts the placeholders, but your users then see an app with no privacy policy.

Delete the `authorization` block unless you're using resource-specific
consent for channel capture. With tenant-wide `ChannelMessage.Read.All`,
the block asks every team owner to consent to something your deployment doesn't use.

### Zip the files, flat

```bash
zip -j agent-switch-teams.zip manifest.json color.png outline.png
```

Keep `-j`: Teams rejects a package whose files sit inside a folder.

### Upload it to your tenant

Choose the upload method your tenant allows:

- **Sideload it.** In Teams, select **Apps → Manage your apps → Upload an app → Upload a custom app**, pick the zip, and choose the team. This needs *Upload custom apps* turned on in your app setup policy. If **Upload a custom app** isn't offered, it's off. A policy change can take up to 24 hours to apply.
- **Have an admin publish it.** In the Teams admin center, select **Teams apps → Manage apps → Upload new app**. This doesn't need sideloading permission, and the app becomes available across the organization.
- **Register it in the Developer Portal.** At `dev.teams.microsoft.com`, select **Apps → Import app**. Choose this if you want to edit the manifest in a UI later.

**Warning**

Uploading a changed package with the same `version` has no effect, and it's the usual reason a new command never shows up. Teams replaces the app only when the `id` matches and the version is higher, so **raise `version` in the manifest** each time you upload a change.

**Note**

The Azure Bot resource has its own icon, separate from this package. Set it there too, or the bot shows a default avatar in some places.

## Connect Teams to your Switch workspace <Admin />

### Open the messaging apps for your server

In the Switch Console sidebar switcher, select the server, then open its **Home** page. **Messaging apps** lists what's connected.

### Start the connection

Select **Connect**. Under **Messaging app**, choose **Microsoft Teams**.

If there's no **Connect** button, you aren't an admin. Ask an admin to connect it.

### Name the connection

**Name** labels this connection when you pick it for a room in Switch Console, so name it after the tenant.

### Fill in the Azure details

- **App Id**: paste the Azure AD app client id.
- **App Password**: paste its client secret.
- **Tenant Id**: paste your Azure AD tenant id.
- **Team Id**: paste the id of the team that channels created from Switch are provisioned into.
- **Public Base Url**: enter the public HTTPS address your listener is reachable at. Switch builds the notification address for Graph from this value, so Microsoft must be able to reach it.

### Connect

Select **Connect**.

### Link your Teams account

Switch Console then asks which Teams account is yours. Search for yourself and select **This is me**.

Until you do, your own agents don't recognize you as their owner. You can select **Skip for now** and link at any time: the server's **Home** page shows **Link your Microsoft Teams account** until you do, and on the connection's row you can select **Link my account…**. For how linking works in every connected app, see [Link your account, and why it matters](how-connections-work.md#link-your-account-and-why-it-matters).

## Bring Switch into a channel

Installing the app into a team puts the bot in **every standard channel of that team at once**. For standard channels, there's no per-channel step and no "add app to this channel" button.

You do need to tell Switch which channel each room belongs to.

**Note**

Private and shared channels need more. In each one, add the app from the channel's **Add an app** list. A channel shared into your team has to be added from the team that hosts it. Graph refuses message subscriptions on these channels for apps using resource-specific consent, so full capture there needs tenant-wide `ChannelMessage.Read.All`. Full capture in private and shared channels is supported but hasn't been proven. Without it, the channel still gets messages that tag the bot.

### Copy the channel's id

In Teams, open the context menu on the channel (right-click, or press and hold) and select **Get link to channel**. The id is the first path segment of that link, URL-encoded:

```text
https://teams.microsoft.com/l/channel/19%3Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa%40thread.tacv2/My%20channel?groupId=…&tenantId=…
```

Decode it before you use it: `%3A` is `:` and `%40` is `@`, so the id in this example is `19:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@thread.tacv2`. The `groupId` in the same link is the team id, so you can check the channel is in the team your connection points at.

### Bind a room to it

In Switch Console, create the room, choose **Use existing channel**, and paste the id into **External channel ID**. Switch works out whether the channel is standard or private.

Once the room is linked, Switch posts a short notice in the channel, which confirms that Switch can post to the channel.

### Talk to an agent

Add an agent to the room and tag it by name in the channel.

If you or an agent creates a room in Switch, Switch creates a matching Teams channel when channel creation is allowed.

## Confirm it worked

- The connection is listed under **Messaging apps** on the server's **Home** page with no error beside its name.
- The channel appears under **Your Rooms** in Switch Console.
- An agent can see a message that tags nobody. Post one in a standard channel, then tag an agent and ask what you just said. This verifies that channel capture is working. If the agent can't see it, wait a minute and try again. If it still can't, see **Agents answer only when tagged** under [Troubleshooting](#troubleshooting).

## What to expect in Teams

- **Agents appear as cards.** Each message renders as a card headed with the agent's name and avatar, not as a post from a named sender.
- **Commands work with either `!` or `/`.** Typing `/` offers the Switch commands, and a command picked there reaches Switch without a mention. Other people in the channel don't see it. In a channel, a command you type out reaches Switch only when you mention the bot, unless channel capture is on.
- **"Open in Switch Console" links need the server's public address, and so do the links agents post to Switch Console pages.** Without it, Teams removes an Open in Switch Console link and only empty brackets show, and an agent's link to a page arrives as the page's name in words. See [Set the server's public address](../self-host.md#set-the-servers-public-address).
- **Attachments are named, not carried.** Files aren't relayed in either direction. The text bridges, with a note saying what wasn't carried.
- **Link your Teams account to get real mentions from agents.** An agent's mention of anyone who hasn't linked, and of every agent, bridges as plain `@name` text.
- **Threading follows the channel's layout.** In a threads-layout channel, agents behave as they do everywhere else: they choose whether to reply in a thread, and anything unprompted goes to the channel. In a posts-layout channel, an agent's reply lands in the post holding the message it's answering.
- **Renaming a channel or a group chat renames its room.** A room named after its team follows the team's name. Once someone renames the room in Switch, it keeps that name. A room renamed in Switch 0.31 or earlier wasn't marked as renamed, so while its name still matches the channel's, it follows the next rename. Rename it again in Switch to keep your name. Its settings in Switch Console then show the channel's current name, with **Use channel name** to take it. <ComingIn version="Switch 0.33" />
- **In a one-to-one chat, you don't need the `@`.** Only a person can start one, so open a chat with the Switch app yourself. Switch creates a room for the chat, and every message in it reaches the agent. Use one agent per chat. If you add a second agent, both receive every message.

## Troubleshooting

### Agents answer only when tagged

**Only the Bot Framework is set up, so Microsoft Graph change notifications aren't arriving.** The Bot Framework delivers channel messages only when the bot is tagged. See [How Switch sees a Teams channel](#how-switch-sees-a-teams-channel).

To fix it:

1. Grant the Graph permissions and set up the notifications route in [Before you begin](#before-you-begin).
2. In a private or shared channel, add the app from that channel's **Add an app** list. Installing the app into the team doesn't add it to private or shared channels. Resource-specific consent can't capture messages there, so use tenant-wide `ChannelMessage.Read.All`, or accept that the channel gets only messages that tag the bot.
3. If the connection has only just started, wait a minute and try again. Switch keeps retrying while capture starts.
4. If agents still miss untagged messages, check the Switch server's log for the cause. On a Compose deployment, run `docker compose logs -f switch`. The log records the first failure in full and after that only changes in the error, so a single older entry can still be the current cause.

### A second Teams connection won't start

**Switch refuses a second connection on a listener port that's already taken, and names the port.**

To fix it, ask the administrator of your Switch server to give each connection its own port and its own ingress route.

## Next steps

- [Create a room](../../getting-started/create-a-room.md) — Turn a Teams channel into a room, or let Switch make the channel

- [Add a custom agent](../../getting-started/add-a-second-agent.md) — Register an agent with the server so you can invite it into the room

# Connect Microsoft Teams

_Put your Switch agents in a Teams tenant — the one platform that needs Switch publicly reachable_

Published at <https://docs.switchagents.ai/switch-rooms/deploy/messaging-apps/microsoft-teams> — link readers there, not to this file.

Microsoft Teams is the most involved platform to connect. One Azure bot application backs every agent on your Switch server, and each agent's messages render as a card headed with its name.

Teams also needs **Switch reachable from the internet**. Microsoft pushes messages to Switch, so the connection runs its own HTTPS listener and Microsoft has to be able to reach it.

**Warning**

Most of the work here is Azure and Microsoft 365 administration, not Switch configuration. Treat it as an ops task with a directory administrator involved, and have all of it in place before you open the connect form, which asks for the results.

## How Switch sees a Teams channel

Two Microsoft interfaces feed the connection, and the split explains a failure that's otherwise hard to diagnose:

- **The Bot Framework** delivers one-to-one chats and group chats in full, but channel messages **only when the bot is tagged**. It's also how Switch posts back.
- **Microsoft Graph change notifications** deliver everything else in a channel. Graph sends the message bodies encrypted, and Switch creates the certificate that decrypts them when you connect.

Set up only the first and the bridge looks like it works: agents answer when tagged, and miss every other message in the channel.

## Before you begin

In Azure and the Microsoft 365 admin center, you'll need:

- **An Azure AD app registration:** it gives you the bot client id, a client secret and your tenant id.
- **An Azure Bot resource on that app:** its messaging endpoint set to `https://<your-public-host>/api/messages`, with the Microsoft Teams channel enabled.
- **A Teams app package that includes the bot:** installed into the target team, so the bot can be added to channels and post without being spoken to first. Switch ships one; see [Set up the Teams app](#set-up-the-teams-app).
- **Admin-consented Graph permissions:**
  - `ChannelMessage.Read.Group` (resource-specific, and preferred) or tenant-wide `ChannelMessage.Read.All`
  - For provisioning: `Channel.Create`, `Channel.ReadBasic.All`, `User.ReadBasic.All`, and `TeamMember.ReadWrite.All` or `ChannelMember.ReadWrite.All`
- **Public HTTPS ingress:** routing `https://<your-public-host>/api/messages` and `https://<your-public-host>/api/teams/notifications` to the Switch server's Teams listener, which listens on port 3978 unless a server administrator has set another. Graph needs valid TLS and an answer to its validation handshake within ten seconds.

In Switch, you'll need:

- **An admin account on the Switch server you're connecting to:** if Switch Console set up the server for you, you have one.

**Note**

Resource-data subscriptions draw on a per-tenant quota shared by everything in your organization that uses them. Check it before adding another consumer.

## Set up the Teams app

A Teams app package puts the bot in your tenant. It's a zip holding one
manifest and two icons, and Switch ships a complete one.

### Save the manifest and the icons

Save the manifest below as `manifest.json`, and download the two icons from
[`docs/bridges/teams-app/`](https://github.com/sandbox-quantum/switch/tree/main/docs/bridges/teams-app)
into the same folder: `color.png` (192×192) and `outline.png` (32×32).

A Teams manifest points at icons by filename inside the package, not by URL,
and a package without both won't install.

### Agent Switch app manifest

```json
{
    "$schema": "https://developer.microsoft.com/json-schemas/teams/v1.19/MicrosoftTeams.schema.json",
    "manifestVersion": "1.19",
    "version": "1.0.0",
    "id": "00000000-0000-0000-0000-000000000000",
    "developer": {
        "name": "Agent Switch",
        "websiteUrl": "https://github.com/sandbox-quantum/switch",
        "privacyUrl": "https://example.com/privacy",
        "termsOfUseUrl": "https://example.com/terms"
    },
    "name": {
        "short": "Agent Switch",
        "full": "Agent Switch — your AI agents, in your channels"
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
    "bots": [
        {
            "botId": "00000000-0000-0000-0000-000000000000",
            "scopes": [
                "team",
                "personal",
                "groupChat"
            ],
            "isNotificationOnly": false,
            "supportsFiles": false,
            "commandLists": [
                {
                    "scopes": [
                        "team",
                        "groupChat",
                        "personal"
                    ],
                    "commands": [
                        { "title": "/help", "description": "Show every in-room command" },
                        { "title": "/list-agents", "description": "List the agents in this room" },
                        { "title": "/agents-status", "description": "Show each agent's presence and capabilities" },
                        { "title": "/invite-agent", "description": "Add an existing agent: /invite-agent @agent-name" },
                        { "title": "/agents-greet", "description": "Have the agents here introduce themselves" },
                        { "title": "/roles", "description": "List this room's roles and who holds each" },
                        { "title": "/list-aliases", "description": "List this room's agent aliases" },
                        { "title": "/set-alias", "description": "Give an agent a room alias: /set-alias @agent-name @alias" },
                        { "title": "/reset", "description": "Reset an agent's session: /reset @agent-name" },
                        { "title": "/interrupt", "description": "Interrupt an agent's current turn: /interrupt @agent-name" }
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

- The null GUID `00000000-0000-0000-0000-000000000000` in `id`,
  `bots[0].botId` and `webApplicationInfo.id` takes your Azure bot's app id,
  the same value in each. That's what ties the Teams app, the bot and the
  Azure AD registration together.
- `switch.example.com` in `validDomains` takes the host of your public base
  address.
- `https://example.com/privacy` and `https://example.com/terms` take your
  organization's own pages. Teams doesn't check them on upload, so the
  placeholders install fine and then tell your users the app has no privacy policy.

Delete the `authorization` block unless you're using resource-specific
consent for channel capture. With tenant-wide `ChannelMessage.Read.All`, it
asks every team owner to consent to something your deployment doesn't use.

### Zip the three files, flat

```bash
zip -j agent-switch-teams.zip manifest.json color.png outline.png
```

Keep `-j`: Teams rejects a package whose files sit inside a folder.

### Upload it to your tenant

Whichever of these your tenant allows:

- **Sideload it.** In Teams, **Apps → Manage your apps → Upload an app → Upload a custom app**, pick the zip, choose the team. This needs *Upload custom apps* turned on in your app setup policy; if **Upload a custom app** isn't offered, it's off. A policy change can take up to 24 hours to apply.
- **Have an admin publish it.** Teams admin center, **Teams apps → Manage apps → Upload new app**. No sideloading permission needed, and it becomes available across the organization.
- **Register it in the Developer Portal.** At `dev.teams.microsoft.com`, **Apps → Import app**. Useful if you want to edit the manifest in a UI later.

**Warning**

Changing the app later only works if you **raise `version` in the manifest** and upload again. Teams matches on `id`, so the same id with a higher version replaces the app, and the same version does nothing, silently. This is the usual reason a new command never shows up.

**Note**

The Azure Bot resource has its own icon, separate from this package. Set it there too, or the bot shows a default avatar in some places.

## Connect Teams to your Switch server

### Open the messaging apps for your server

In Switch Console, select the server in the sidebar switcher and open its **Home** page. **Messaging apps** lists what's connected.

### Start the connection

Select **Connect**, then choose **Microsoft Teams** under **Messaging app**.

If there's no **Connect** button, you're signed in to that server without admin rights. Ask whoever runs the server.

### Name the connection

**Name** labels this connection when you pick it for a room in Switch Console, so name it after the tenant.

### Fill in the Azure details

- **App Id** — the Azure AD app client id.
- **App Password** — its client secret.
- **Tenant Id** — your Azure AD tenant id.
- **Team Id** — the team that channels created from Switch are provisioned into.
- **Public Base Url** — the public HTTPS address your listener is reachable at. Switch builds the notification address it gives Graph from this, so it must be one Microsoft can reach.

### Connect

Select **Connect**.

### Link your Teams account

Switch Console then asks which Teams account is yours. Search for yourself and select **This is me**.

Until you do, an agent set to answer only its owner reads your messages as a stranger's. You can select **Skip for now** and use **Link my account…** on the connection's row later. For how linking works in every connected app, see [Link your account, and why it matters](how-connections-work.md#link-your-account-and-why-it-matters).

## Bring Switch into a channel

Installing the app into a team puts the bot in **every standard channel of that team at once**. There's no per-channel step and no "add app to this channel" button.

What you do need is to tell Switch which channel a room belongs to.

### Copy the channel's id

In Teams, right-click the channel and select **Get link to channel**. The id is the first path segment of that link, URL-encoded:

```text
https://teams.microsoft.com/l/channel/19%3Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa%40thread.tacv2/My%20channel?groupId=…&tenantId=…
```

Decode it before you use it: `%3A` is `:` and `%40` is `@`, so that one is `19:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@thread.tacv2`. The `groupId` in the same link is the team id, so you can check the channel is in the team your connection points at.

### Bind a room to it

Create the room, choose **Use existing channel** and paste the id into **External channel ID**. Switch works out whether the channel is standard or private.

Once the room is linked, Switch posts a short notice in the channel, which confirms outbound works.

### Talk to an agent

Add an agent to the room and tag it by name in the channel.

Going the other way, a room created in Switch, by you or by an agent, gets a Teams channel made for it, as long as channel creation is allowed.

**Warning**

Private and shared channels need more. The app has to be added to each one individually, and it's offered for them only if the manifest declares `supportsChannelFeatures` at schema v1.25 or later, which the shipped one doesn't. Graph also refuses message subscriptions on them for apps using resource-specific consent, so full capture there needs the tenant-wide permission.

## Confirm it worked

- The connection is listed under **Messaging apps** on the server's **Home** page with no error beside its name.
- The channel appears under **Your Rooms** in Switch Console.
- An agent can see a message that tags nobody. Post one in a standard channel, then tag an agent and ask what you just said. This is the test that matters. If the agent can't see it, wait a minute and try again, because capture can fail for a short while after the connection starts and Switch keeps retrying. If it still can't, channel capture isn't running, though tagged messages still work. The Switch server's log says why. It records the first failure in full and after that only a change in the error, so a single older entry is still the current cause.

## What to expect in Teams

- **Agents appear as cards.** Each message renders as a card headed with the agent's name and avatar, not as a post from a named sender.
- **Commands work with either `!` or `/`.** Teams has no server-registered slash commands, so `/help` is an ordinary message that Switch parses; the app's command menu types it for you. In a channel the bot has to be tagged for the message to reach Switch at all, unless channel capture is on.
- **Attachments are named, not carried.** Files aren't relayed in either direction yet. The text bridges, with a note saying what wasn't carried.
- **Link your Teams account to get real mentions from agents.** An agent's mention of anyone who hasn't linked, and of every agent, bridges as plain `@name` text.
- **Threading follows the channel's layout.** In a threads-layout channel agents behave as they do everywhere else: they choose whether to reply in a thread, and anything unprompted goes to the channel. In a posts-layout channel an agent's reply lands in the post holding the message it's answering, because posting at the channel level there would start a new conversation instead of answering.
- **A one-to-one chat works, and it's the one place you don't need the `@`.** Only a person can start one, so open a chat with the Switch app yourself, and Switch picks it up as a room. Keep it to a single agent: with a second, every message reaches both.
- **One Teams connection per listener port.** Switch refuses a second connection on a port that's already taken, and names the port. To run more than one on a host, a server administrator gives each its own port, and each needs its own ingress route.

## Next steps

- [Create a room](../../getting-started/create-a-room.md) — Turn a Teams channel into a room, or let Switch make the channel

- [Onboard agents](../../getting-started/onboard-your-agents.md) — Register an agent with the server so you can invite it into the room

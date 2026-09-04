# Connect Mattermost

_Put your Switch agents in a Mattermost server, where each one gets a bot account of its own_

Published at <https://docs.flintai.dev/flintai/switch/deploy/messaging-apps/mattermost> — link readers there, not to this file.

Mattermost is the platform Switch treats most like a real workplace: each agent gets its own Mattermost bot account, named for the agent, and that bot joins channels as an ordinary member. Agents show up in the channel member list, which they don't on any other platform.

Mattermost reaches Switch over a connection Switch opens outwards, so **nothing needs to be publicly reachable**.

**Note**

If Switch Console set up your server — on this computer or on a remote host — it started a Mattermost server alongside it and connected it already. It's listed under **Messaging apps** on the server's **Home** page, and **Sign-in details…** on its row gives you the account to log in with. There's nothing on this page to do unless you're connecting a Mattermost server of your own.

## Before you begin

- **A Mattermost server** that your Switch server can reach. It doesn't have to be reachable from the internet — a private or tailnet address is fine.
- **An admin account on that Mattermost server.** Switch signs in as this account to create the per-agent bot accounts, so it can't be an ordinary user.
- **A team** on that server for bridged channels to live in. You need its URL slug, not its display name.
- **An admin account on the Switch server** you're connecting to.

## Prepare Mattermost

### Allow bot accounts to be created

In the Mattermost **System Console**, open **Integrations**, then **Bot Accounts**, and turn on **Enable Bot Account Creation**.

Every agent that works in a bridged channel gets a bot account, so this isn't optional — without it, agents can't appear at all.

### Have the admin account and team ready

Note the admin username and password Switch will sign in as, and the slug of the team that bridged channels belong to. Check that the admin can create channels and manage members on that team.

## Connect Mattermost to your Switch server

### Open the messaging apps for your server

In Switch Console, select the server in the sidebar switcher and open its **Home** page. **Messaging apps** lists what's connected.

### Start the connection

Select **Connect**, then choose **Mattermost** under **Messaging app**.

If there's no **Connect** button, you're signed in to that server without admin rights. Connecting a messaging app is an administrator action, so ask whoever runs the server.

### Name the connection

**Name** is how this connection is labeled in Switch Console when you pick it for a room, so name it after the server — "Acme Mattermost" rather than "Mattermost".

### Fill in the connection details

- **Url** — the base URL your *Switch server* connects to. This can be internal.
- **Admin User** and **Admin Password** — the account Switch signs in as.
- **Team Name** — the team slug, as it appears in the URL.
- **Public Url** *(optional)* — the address your *people* use, when it differs from **Url**. Links Switch posts are built from this, so set it whenever the internal address wouldn't open in someone's client.
- **Default Member** *(optional)* — a person to add to every channel this connection creates. Worth setting when agents create rooms: a private channel made by an agent has no human members otherwise, and nobody can read it.

### Connect

Select **Connect**. Switch signs in as the admin, resolves the team, and opens its connection immediately, so wrong credentials or a mistyped team slug are reported here rather than later.

### Link your Mattermost account

Switch Console then asks which Mattermost account is yours. Search for yourself and select **This is me**.

An agent set to answer only its owner can't recognize you until you do — your messages read as if from a stranger. **Skip for now** is available, and the connection's row offers **Link my account…** whenever you come back to it.

## Bring Switch into a channel

Mattermost works differently from the other platforms here, and it's the thing to get right: **there's no Switch app to invite**. Each agent has its own bot account, so adding an *agent* to a channel is what creates the room.

- **To turn an existing channel into a room**, add one of your agents to it, by the bot account named for that agent.
- **To go the other way**, create the room in Switch and Switch creates the Mattermost channel with it — as long as you left channel creation allowed. That applies to rooms an agent creates as well as ones you create in Switch Console.

Once the room exists, add more agents from inside the channel:

```text
!invite-agent @agent-name
```

Mattermost has no native slash commands for Switch, so the `!` form is the one that works here. It has to be the first thing in the message.

## Confirm it worked

- The connection is listed under **Messaging apps** on the server's **Home** page with no error beside its name.
- The channel appears under **Your Rooms** in Switch Console.
- The agent's bot account is visible in the channel member list — this is the one platform where that's true.

## What to expect in Mattermost

- **Agents are real accounts.** Each one is a bot account named for the agent, so people can see who's in a channel the ordinary way.
- **One-to-one conversations work here, and only here.** Mattermost is the one platform where you can talk to an agent privately rather than in a channel. Start it yourself — Mattermost only lets a person open a direct message, so Switch can't — and message the agent's bot. Switch picks the conversation up as a room.
- **Only the `!` command form works.** There's no native slash command integration.

## Next steps

- [Create a room](../../getting-started/create-a-room.md) — Turn a Mattermost channel into a room, or let Switch make the channel

- [Onboard your agents](../../getting-started/onboard-your-agents.md) — Register an agent with the server so you can invite it into the room

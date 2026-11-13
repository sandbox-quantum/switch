# Bring your team in

_Get your teammates working with your agent in the chat app they already use_

Published at <https://docs.switchagents.ai/switch-rooms/getting-started/grow-your-team> — link readers there, not to this file.

import { ChatMessage, BuddyGuide } from "/snippets/chat-message.jsx";
import { AppNote } from "/snippets/app-note.jsx";

Once switch-buddy has done its first task, you can bring select teammates in with your agent in the chat app where your team already works.

You'll need to set up the following, in this order:

- **Your chat app, connected to Switch,** so the rooms switch-buddy makes are channels your team can use.
- **An agent with a job to do,** and a room to do it in.
- **Permission for your teammates** to work with the agent. A new agent answers only you and your own agents until you extend that permission to others.

## Before you begin

You'll need:

- **Switch Console open, with switch-buddy answering in its chat.** If you haven't done that yet, start with [Set up Switch](quickstart.md).
- **Permission to add an app to the chat workspace your team uses**. Many workspaces need an admin to approve app connections, so you may need to ask a colleague for help.

**Note**

Your teammates can reach your agent only while it's running. For an agent Switch Console runs on your computer, Switch Console must be open. See [What keeps your agent running](what-keeps-your-agent-running.md).

<AppNote app="teams">
  Teams can't be connected from Switch on your own computer. Connecting Teams requires a Microsoft 365 admin and a Switch server that Teams can reach over the internet. See [Microsoft Teams](../deploy/messaging-apps/microsoft-teams.md).
</AppNote>

<AppNote app="telegram">
  Switch can't create Telegram chats, so switch-buddy can't make the room's channel for you. Make the group in Telegram and [add the bot to it](../deploy/messaging-apps/telegram.md#add-the-bot-to-a-chat), and Switch turns it into a room. Then ask switch-buddy to set up the agent and add it to that room.
</AppNote>

## Connect your chat app

switch-buddy can show you where to start. In Switch Console, in your chat with switch-buddy, ask for help and name your app. For example:

<ChatMessage>

Help me connect Slack to Switch.

</ChatMessage>

Then follow your chat app's page to:

1. Create a new app in your chat app for Switch to use.
2. Paste the app's details into Switch Console.
3. Link your own account, so your agent knows which messages are yours.

- [Slack](../deploy/messaging-apps/slack.md)
- [Discord](../deploy/messaging-apps/discord.md)
- [Telegram](../deploy/messaging-apps/telegram.md)

Once the connection is made, come back to this page. switch-buddy then helps you set up your first agent and its room.

## Set up an agent and a room

<BuddyGuide>
  Connect your chat app before you ask me for a room. A room I make before then stays private to you.
</BuddyGuide>

With your chat app connected, ask switch-buddy to set up an agent with a job to do, and create a room for it in your chat app.

### Ask switch-buddy

In Switch Console, open switch-buddy's chat, and describe the job and the room where the team will collaborate. For example:

<ChatMessage>

Set up an agent that drafts our weekly marketing update, and a new Slack channel called #weekly-update with the agent in it.

</ChatMessage>

### Refine the plan

switch-buddy tells you what it plans to create and waits for you to agree. Work with switch-buddy until you agree with the plan, then say yes to approve agent and room creation.

### Open the new Switch room

In your chat app, open the channel switch-buddy created for your new room. If it isn't there, see [You can't see the new channel](#cant-see-the-channel).

### Check that your agent is there

Type `!list-agents` in the channel, and make sure your agent is listed.

**Tip**

Most chat apps don't show agents in the member list, and `!list-agents` works in every chat app.

## Invite your teammates to work with your agent

Add your teammates to your room, and give them permission to work with your agent.

### Add your teammates to the room

Invite them the way you'd add anyone to a channel in your chat app.

### Permit them to talk to the agent

In Switch Console, open the agent's settings. Under **Who can talk to your agent**, choose one of these options:

- **Anyone:** everyone in the agent's rooms can address it.
- **Custom rules:** only the people and rooms you name can address it.

To learn more about each choice, see [Choose who can instruct the agent](agent-settings.md#choose-who-can-instruct-the-agent).

### Welcome your team

Your agent doesn't greet people unless it's set up to, so post a welcome that says what it does and how to give it work. Replace the example name and job with your own:

```text
Meet weekly-update-agent, our new agent. It drafts our weekly marketing update.

To give it work, type @ and its name, then say what you need. For example, ask it to draft this week's update from the notes in this channel.

It may say it's starting before it answers. There's nothing to install. For more about working with agents in Switch, see https://docs.switchagents.ai/switch-rooms/using/index
```

The message leaves out the `@` on purpose. Any message that mentions the agent with `@` sets it to work.

If your agent is always running, switch-buddy can also set it up to greet each person who joins. An agent on your computer greets them only once Switch Console is open again, so keep the welcome message too.

### Ask a teammate to say hello

Have a teammate mention the agent by name in the channel. The agent replies to them. If it doesn't, see [When an agent doesn't answer](../using/agent-not-answering.md).

## Troubleshooting

### You can't see the new channel

Check these in order:

- **You aren't in the channel yet.** Switch can add you only if it knows your account in that chat app. Link your account on the server's **Home** page in Switch Console, or tell switch-buddy your exact username in the chat app, and ask it to add you.
- **Your chat app wasn't connected when switch-buddy made the room.** The room was made without a channel, and it can't be moved into one later. Connect your chat app, then ask switch-buddy for a new room.
- **switch-buddy reported an error.** Do what the error says. It names the fix, such as asking an admin to allow channel creation, or giving the bot permission in your chat app.
- **You have more than one chat app connected.** The channel may be in the other one. Ask switch-buddy which app it used.

## Next steps

- [Use cases](../use-cases/index.md) — Ideas for more jobs you can give to your agents

- [Agent settings](agent-settings.md) — Change what your agent does and who it answers

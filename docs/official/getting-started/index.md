# Switch quickstart

_Set up Switch and prove it works in around 10 minutes_

Published at <https://docs.switchagents.ai/switch-rooms/getting-started> — link readers there, not to this file.

Switch gives people and AI agents a room to work in together. This quickstart takes you from installing Switch Console for the first time to an AI agent answering you in a Switch room.

**Note**

If someone has already added you to a Switch room, you don't need to set anything up. Jump to [Meet Switch](../using/index.md) to learn how to collaborate in Switch.

If you're setting up a server for your whole team, see [Host Switch for your team](../deploy/self-host.md).

## Before you begin

What you need depends on whether you connect to your team's server or run Switch on this computer.

### Connect to an existing server

To connect to your team's server, you'll need:

- **Access to your team's server:** its Gateway URL, its API URL, and an account on it.
- **An account on your team's messaging app:** the one the server is connected to.

You may need to ask for these from whoever runs Switch for your team. In the meantime, you can continue with setup steps 1 and 2.

### Run Switch on this computer

To run Switch on this computer, you'll need:

- **Docker, installed and running:** Switch runs its server on your computer inside Docker. You can use [Docker Desktop](https://docs.docker.com/get-started/get-docker/), Rancher Desktop, or Docker installed through Homebrew.

You'll also need:

- **An AI coding agent on this computer:** Claude Code, Codex, or OpenCode.
- **An account to sign in to it with:** a subscription or an API key.

**Warning**

Switch doesn't include its own AI agent, and setup can't finish without one. If Claude Code, Codex, or OpenCode isn't set up on this computer yet, follow [Set up agent providers](set-up-agent-providers.md) first.

## Set up Switch

### Install Switch Console

Switch Console is the desktop app you use to set up Switch and run your agents. Download the version you need from [Install Switch Console](install-switch-console.md#download-switch-console), then install and open it.

### Check your AI coding agent status

Select **Settings** at the bottom of the sidebar, then **Agent providers**, and find your AI coding agent in the list.

If the line under its name reads **Signed in**, continue to step 3, **Add a server**. (For OpenCode, the line reads **Backend connected**.)

### Not signed in

Select the agent row. Its details show the sign-in command for your agent, with a **Copy** button:

- **Claude Code:** `claude auth login`
- **Codex:** `codex login`
- **OpenCode:** `opencode auth login`

Run the command in a terminal on this computer and sign in when it asks. Then select **Recheck**.

If the line reads **CLI not installed**, install the agent first. See [Set up agent providers](set-up-agent-providers.md).

### Add a server

The server is where your rooms live and where your agents connect. Select **Add a server**, then follow the instructions that apply to you:

### Connect to an existing server

1. Select **Connect to an existing server**.
2. Enter the Gateway URL and API URL, then your **Email** and **Password**.
3. When Switch Console asks you to **Link your messaging accounts**, select **Link** for your team's messaging app.
4. Search for your name as registered in the app and select **This is me**, then select **Done**.

**Warning**

Don't skip the link. Switch uses it to find your messaging account, and step 4 can't create a room without it.

### Run Switch on this computer

1. Select **Run a server on this computer**.
2. Wait for **Docker is ready.**, then select **Start**. If the message doesn't appear, open Docker and wait for it to finish starting.

   The first start downloads a few GB. When the server is running, the top of the sidebar reads **Running locally**.
3. Sign in to Mattermost, the messaging app that comes with the server. On the server's **Home** page, under **Messaging apps**, open the menu on the Mattermost row and select **Sign-in details…**. Select **Open in Mattermost** and sign in.

Switch links your Mattermost account to you automatically.

**Note**

A server on this computer is for you alone, so colleagues can't connect to it. It keeps running when you quit Switch Console, but it doesn't restart after you restart your computer.

See [Add a server](add-a-server.md) for additional details. 

### Create the Switch expert

In Switch Console, use the built-in Switch expert template to create an agent you can ask about Switch setup, features, and workflows.

1. Select **Templates** in the sidebar.
2. Under **Built in**, find **Switch expert** and select **Use**.
3. Turn on **Start it in a room**. Leave the room choice under it set to a new room.
4. Note the room name in the preview of the agent and its room. You open that room next.
5. Select **Create agent and room**.

Switch Console creates a private room named **Ask** followed by the agent's short name, default **Ask switch-expert**. The room's first message tags the agent and asks it to introduce itself and answer a question about Switch.

## Confirm the setup

### Open the room

Open the new room in your messaging app. You can also open it in Switch Console, which shows the same conversation.

### Approve the Switch repo download

Before it answers, the agent may ask for permission to download the Switch repository, which the Switch expert uses as its knowledge base. Select **Allow** or **Allow for this session** to unblock the agent response.

**Tip**

If the agent seems stalled, the permission request may be waiting in a message thread.

### Read the agent reply

The agent answers the first message with a short introduction and its response.

### Ask your own question

Ask it a question about Switch. Start your message with `@` and the agent's name, spelled exactly as it is in the first message. This is how the agent knows you're addressing it.

This initial interaction validates that Switch is set up and an agent on your computer is answering you in a Switch room.

## Troubleshooting

### The agent didn't answer

1. Check to make sure Switch Console is running. The agent answers only while the console is running.
2. Check that your message starts with `@` and the agent's name, spelled exactly as it is in the first message. The agent ignores a message that doesn't address it, without showing an error.

For additional help, see [Getting an agent running](../resources/troubleshooting.md#getting-an-agent-running).

### No room was created

If **Start it in a room** was off in the template, or you chose an existing room, the template didn't create a new room. Use the room you chose, or add the agent to a room yourself. See [Invite an agent to the room](create-a-room.md#invite-an-agent-to-the-room).

## Next steps

- [Add a custom agent](add-a-second-agent.md) — Build an agent of your own and have it learn from the Switch expert

- [Meet Switch](../using/index.md) — Learn how a room works, and what makes it different from a group chat

- [Connect a messaging app](../deploy/messaging-apps/index.md) — Create a room in Slack, MS Teams, or another compatible app

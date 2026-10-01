# Stand up a Switch expert

_Create an agent from the built-in Switch expert template to answer questions about Switch and help you design what to build_

Published at <https://docs.switchagents.ai/switch-rooms/getting-started/switch-expert> — link readers there, not to this file.

Switch has more surface than anyone reads up front. A Switch expert is an agent that answers questions about Switch and helps you work out what to build with it, so people can ask instead of going looking. It works from a copy of the Switch repository, which holds the documentation and the source code.

It's a good agent to start with: the thing it explains is the thing you have just set up.

Switch Console ships the Switch expert as a template, so you don't write its instructions or choose its working directory.

## Before you start

You need an agent provider that's already set up. See [Set up agent providers](set-up-agent-providers.md).

The template runs on Claude Code, Codex, or OpenCode. It uses the first of those, in that order, that's installed on the machine where the agent runs.

## Stand it up

### Open the template

In the sidebar, select **Templates**. Under **Built in**, find **Switch expert** and select **Use**.

### Check the settings

**Agent name** is filled in for you. Change it if you like.

**Advanced** summarizes the provider, where the agent runs, and its working directory, such as `~/.switch/agents/switch-expert`. Select **Change** to edit any of them.

If you change the working directory, don't choose one holding your own work. Switch Console copies the Switch repository into it.

### Choose whether it starts in a room

**Start it in a room** is off by default, so the agent is created on its own and you invite it to a room afterwards.

Turn it on to start the agent in a new room made for it, or in a room you pick. In a new room, a first message addressing the agent is posted in your name, so the agent starts answering straight away.

### Create the agent

Select **Create agent**. Switch Console copies the Switch repository into the agent's working directory before the agent first runs.

If you left **Start it in a room** off, invite the agent to a room now. See [Create a room](create-a-room.md#invite-an-agent-to-the-room).

Unlike an agent you onboard yourself, which answers only you by default, this agent answers anyone in a room it's in, so your team can ask it things too.

## Ask it something

In the agent's room, mention the agent by its name and ask a question you already know the answer to, so you can judge the reply:

> How do I add a server in Switch Console?

See [Talk with an agent](../using/mention-and-message.md) for more on addressing an agent.

**Note**

It answers only while a session is running. **Auto-create a session on notify** covers the first message of the day; if your team comes to rely on the agent, run it somewhere that stays up rather than on a laptop that closes — see [Onboard a remote host](../deploy/host-remotely.md).

## Next steps

- [Meet Switch](../using/index.md) — How a room works, and what makes it different from a group chat

- [Build with Switch](../building/index.md) — Worked setups to copy, once you know what you want to build

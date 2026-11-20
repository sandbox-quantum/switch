# Get started with Switch Rooms

_Find the quickest way to start with Switch Rooms_

Published at <https://docs.switchagents.ai/switch-rooms/getting-started> — link readers there, not to this file.

import { DecisionTree } from "/snippets/decision-tree.jsx";
import { startHereTree } from "/snippets/start-here-tree.jsx";
import { BuddyGuide } from "/snippets/chat-message.jsx";

Switch Rooms brings people and AI agents together in shared chat rooms. If your team already uses Switch, you can join a room without installing anything.

- **A [room](../resources/glossary.md#room)** is a channel in the chat app your team already uses, such as Slack, where people and AI agents work side by side.
- **An [agent](../resources/glossary.md#agent)** is an AI teammate. You ask it for help by name in a room. Every agent has an owner who controls who can use it.
- **switch-buddy** is your AI assistant in Switch. Ask it in plain words to set up agents and rooms for you. It can also guide you through other setup and configuration.

## Choose your path

- [Work with your team's agents](../using/index.md) — <Badge color="green">Nothing to install</Badge> Your team already uses Switch, and you want to work with the agents in its rooms. Ask whoever runs Switch for your team to add you to a room. Each agent answers only the people its owner permits. If one can't help you, it replies once to say why and what to do.
- [Bring your own agent](add-your-agent-to-your-team.md) — <Badge color="blue">Install Switch Console</Badge> Your team already uses Switch on a server teammates can sign in to, and you want an agent of your own in its rooms. You need the server's address and a way to sign in: an account from whoever runs it, or your company sign-in if the server uses single sign-on.
- [Set up Switch](quickstart.md) — <Badge color="orange">Install Switch Console and choose a server</Badge> Nobody on your team has set up Switch yet. You'll choose where it runs as part of setup.

## Not sure?

<BuddyGuide>
  If you're already in a room with agents, you don't need to install anything. Otherwise, answer the questions below to find your path.
</BuddyGuide>

<Visibility for="humans">

</Visibility>

<Visibility for="agents">
  Answer a few questions, and they point you to the right page.

### Has someone already set up Switch for your team?

- **Yes:** Go to the next question.
- **No:** [Set up Switch](quickstart.md).
- **Not sure:** Have you been added to a room with agents in it?
  - **Yes:** Go to the next question.
  - **No:** If your team already uses Switch, ask to be added to a room. There's nothing to install. See [Meet Switch](../using/index.md). If you want to try Switch yourself, or set it up for your team, see [Set up Switch](quickstart.md).

### What do you want to do?

- **Use agents already in a room:** There's nothing to install. Ask to be added to a room, then see [Meet Switch](../using/index.md).
- **Set up an agent for yourself or your team:** Go to the next question.

### Do you have your team's server address and a way to sign in?

- **Yes:** [Bring your own agent](add-your-agent-to-your-team.md).
- **No:** Ask whoever runs Switch for them, then follow [Bring your own agent](add-your-agent-to-your-team.md). If teammates can't sign in to the server, you can still work with its agents in your messaging app. See [Meet Switch](../using/index.md).

</Visibility>

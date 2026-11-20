# Choose how to run Switch

_Compare the ways to run a Switch server, and pick the one that fits your team_

Published at <https://docs.switchagents.ai/switch-rooms/deploy> — link readers there, not to this file.

import { DecisionTree } from "/snippets/decision-tree.jsx";
import { runSwitchTree } from "/snippets/run-switch-tree.jsx";
import { BuddyGuide } from "/snippets/chat-message.jsx";

Switch has these parts:

- **[Switch Console](../resources/glossary.md#switch-console)** is the desktop app you install on your computer. You use it to set up Switch and run your agents.
- **A [Switch server](../resources/glossary.md#server)** is where your rooms live and your agents connect. Switch Console can run one for you, on your computer or on a remote host, or your team can deploy one.

This page helps you choose where your server runs and who can reach it.

<BuddyGuide>
  Joining a team that already uses Switch? You don't need to choose a server. [Start here](../getting-started/index.md#not-sure) helps you find your next step.
</BuddyGuide>

<div className="sw-run-options">

| Option | Choose it when | Who it's for | Runs |
| :-- | :-- | :-- | :-- |
| [**Run a server on this computer**](../getting-started/quickstart.md) | You're trying Switch out, or your agents only need to answer while you're working. | Just you. Teammates can use your agents in Slack, Discord, or Telegram. | Until your computer restarts. Quitting Switch Console leaves the server running, but stops the agents Switch Console runs. |
| [**Run a server on a remote host**](host-remotely.md) | Your team works with your agents in a chat app, and needs them answering around the clock. | Just you. Teammates can use your agents in Slack, Discord, or Telegram. | While the host is up. After a host restart, you start the server again yourself. Your agents keep answering only if they run on the host too. |
| [**Deploy your own server**](self-host.md) | You want to use your agents in Microsoft Teams, or teammates will add agents of their own. | Your team. Each person signs in and can bring their own agents. | Always. Whether an agent answers depends on what runs it. See [What keeps your agent running](../getting-started/what-keeps-your-agent-running.md). |
| **Switch Cloud** | Coming soon | — | — |

</div>

**Note**

Where your agents run is a separate choice. See [What keeps your agent running](../getting-started/what-keeps-your-agent-running.md).

## Still not sure?

Answer a few questions, and we'll point you to the options that fit.

<Visibility for="humans">

</Visibility>

<Visibility for="agents">
  Answer these questions in order to choose how to run Switch.

  1. Has someone already set up Switch for your team?
     - Yes: you don't need to set up a server. To work with the agents your team already has, there's nothing to install. If you're not in a room yet, ask whoever runs Switch for your team to add you (see [Meet Switch](../using/index.md)). To add your own agent, install Switch Console and connect it to the server your team runs (see [Bring your own agent](../getting-started/add-your-agent-to-your-team.md)).
     - No, nobody has: go to question 2.
     - Not sure: have you been added to a chat with agents in it? If so, your team already uses Switch, so follow the "Yes" answer. If not, before you install anything, ask whoever told you to start with Switch, or your chat room administrator, for the best way to get started.
  2. Do you want to use your agents in Microsoft Teams?
     - Yes: deploy your own server, with Docker Compose or on Kubernetes (see [Host Switch for your team](self-host.md)), or Switch Cloud, which is coming soon.
     - No: go to question 3.
  3. Will teammates add agents of their own?
     - Yes: deploy your own server, with Docker Compose or on Kubernetes (see [Host Switch for your team](self-host.md)), or Switch Cloud, which is coming soon.
     - No, they'll use mine: go to question 4.
  4. Must your agents keep answering when your computer is off?
     - No: run a server on this computer (see [Set up Switch](../getting-started/quickstart.md)), or Switch Cloud, which is coming soon. Teammates can use your agents in Slack, Discord, or Telegram.
     - Yes: run a server on a remote host and run your agents there too (see [Onboard a remote host](host-remotely.md)), or Switch Cloud, which is coming soon.
</Visibility>

## Next steps

- [Connect Switch to a messaging app](messaging-apps/index.md) — Connect the chat app your team already uses

- [What keeps your agent running](../getting-started/what-keeps-your-agent-running.md) — Choose where your agents run

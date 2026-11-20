# What keeps your agent running

_Find out whether Switch Console or a managed machine keeps your Switch agent answering_

Published at <https://docs.switchagents.ai/switch-rooms/getting-started/what-keeps-your-agent-running> — link readers there, not to this file.

import { Since } from "/snippets/version-badges.jsx";

Switch Console runs some agents, and a managed machine runs others. Which one runs yours decides what keeps it answering in its rooms.

## Find out what runs your agent

In the Switch Console sidebar, select **Your Agents**, then select the agent.

| On the agent's page or in Switch Console | Switch Console runs it | A managed machine runs it |
| :-- | :-- | :-- |
| **on** followed by a machine's name, at the top of the page | No | Yes |
| A **Provider sign-in** section | Yes | No |
| The agent's sessions, listed in Switch Console | Yes | No |

Some settings also work differently for the two kinds. See [Agent settings](agent-settings.md).

## Keep your agent connected

An agent answers in a room only while something holds its connection to Switch.

- **Switch Console runs it on this computer:** Switch Console holds the connection. If you quit Switch Console, the agent stops answering.
- **Switch Console runs it on a host you've onboarded:** A small process Switch Console puts on the host holds the connection, so the agent keeps answering when you quit Switch Console. A host reboot stops it until Switch Console reaches the host again. See [Run an agent on the host](../deploy/host-remotely.md#run-an-agent-on-the-host).
- **A managed machine on this computer runs it:** Switch Console starts the machine's agent controller and stops it when you quit, so the agent stops answering.
- **A managed machine elsewhere runs it:** The machine's agent controller holds the connection, so the agent isn't tied to Switch Console being open. The machine has to be on and its agent controller running. If it isn't, Switch posts in the room that the machine is offline or reconnecting.

If your agent stops answering, see [When an agent doesn't answer](../using/agent-not-answering.md) for what each reply in the room means, and **Getting an agent running** in [Troubleshooting](../resources/troubleshooting.md#getting-an-agent-running) for the fixes.

## When your agents move to a managed machine

On a server where [agent management](../deploy/self-host.md#turn-on-agent-management) is active, Switch Console automatically moves the agents it runs for you onto a managed machine. Agent management is active by default on a server Switch Console runs. <Since version="Switch Console 0.40" /> On a server your team deploys, it's only active if the administrator of the Switch server turned it on. Switch Console moves only agents you own. Agents someone else owns stay where they are.

The managed machine is the computer the agent already ran on, so its working directory and credentials are still there. An agent on a remote host you've onboarded moves onto a managed machine on that host.

- **Any turn in progress is cut.** The agent picks up again the next time someone addresses it.
- **Switch Console doesn't announce the move.** A room where a turn was cut is told, and asked to send the request again. The agent's page and its sessions change as described in [Find out what runs your agent](#find-out-what-runs-your-agent).
- **Some advanced settings may not carry over, and nothing tells you which.** After a move, check the agent's page against how you had it set.

If an agent now runs on a different computer, it was created or moved there. If it can't reach its files, see **Your agent can't reach its files** in [Troubleshooting](../resources/troubleshooting.md#getting-an-agent-running).

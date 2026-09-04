# Run a smoke test

_Prove the installation works with one human, one agent, and one task_

Published at <https://docs.flintai.dev/flintai/switch/getting-started/smoke-test> — link readers there, not to this file.

**Objective**: Send one task into one room, watch your agent do it, and check that the answer could only have come from your machine.

**Prerequisites**: Follow the Get started instructions in this guide to:

- Installing and configuring Switch Console
- Create a Switch room
- Onboard an agent in that room

**Note**

If a step doesn't go as described, stop there and jump to [When a step doesn't match](#when-a-step-doesnt-match).

## Send one task

### Open the room in your messaging app

Open the channel, not Switch Console. You want to test the room your team will use.

If Switch Console set your server up, the messaging app is a Mattermost it started alongside it. Open your server's **Home** page, find the connection under **Messaging apps**, and select **Sign-in details…** on its row for the account to sign in with.

_The room appears like an ordinary channel with your agent among its members._

### Address the agent by @name or @alias

Mention the agent by its registered name and ask it for something small and specific in the working directory you selected when you onboarded it, like a file with an obscure name.

_Check the reply for something only your machine could know. If you get a generic response that could have come from anywhere, double check where you configured the agent to run._

### Ask a follow-up that leaves out the context

Ask a second question that depends on the first without restating it. For example, ask the agent why it gave that answer.

_The agent should carry on from the first answer. If it asks you to repeat yourself, it's answering each message cold rather than working in the room._

### Have somebody else address the same agent

Skip this step if you're setting up Switch alone.

Your agent starts on **Only me (default)**, so a colleague is refused until you widen it. Open the agent under **Your Agents** in Switch Console and set **Who can talk to your agent** to **Anyone**, or name them under **Custom rules**. Then bring them into the channel and ask them to address the agent themselves.

_Your colleague should be able to follow the thread and get an answer, with nothing to set up on their side. If they're told they aren't permitted to direct messages to the agent in this room, the setting didn't take._

### When a step doesn't match

Work down this list in order. From inside the channel, these problems can look similar.

| What you saw | Possible problem | What to do |
| --- | --- | --- |
| The agent replies that it only takes instructions from its owner, and that this chat account isn't linked. | Switch can't tell that the account you're messaging from is yours. | Link your chat account from your server's **Home** page in Switch Console. See [Add a server](add-a-server.md). |
| The agent replies that you're not permitted to direct messages to it in this room. | The agent is restricted to particular people and you aren't one of them. | Ask the agent's owner to widen who it answers. Only its owner can change that. See [Onboard your agents](onboard-your-agents.md). |
| The agent replies that it isn't available, or that no session is connected | The agent is in the room and nothing is running behind it. Switch answered on its behalf. | Start a session in Switch Console, or post the command the reply gives you. Turn on **Auto-create a session on notify** so Switch starts one whenever the agent is addressed. See [Onboard your agents](onboard-your-agents.md). |
| The agent never replies at all | Nothing was addressed, or a session is running and isn't receiving room events. | Check the address first — a message that addresses nobody produces no error and no hint. See [Work with your team](../using/mention-and-message.md). If the address is right, see [Agent is connected but never answers](../resources/troubleshooting.md#getting-an-agent-running). |
| The agent replies but has no information from the working directory. | It may be pointed to an unexpected directory. | Re-check the working directory you gave the agent when you onboarded it, and which machine you set it to run on |
| The agent forgets the previous message | The reply came from outside the room's context. | Check that you addressed the agent and that the response came from the room rather than another conversation. |
| Nothing in the room responds at all | The server may be unavailable. | Check the server before checking the agents. When every agent is silent at once, the server is the thing they have in common |

## Confirm it worked

The smoke test is successful when:

- The agent responds with information from its configured working directory
- The agent continues a conversation without needing the context repeated
- A colleague (if you invited one) can follow the thread and address the same agent, with nothing to set up on their side

**Check**

You have a working Switch room.

## Your room is a real chat channel

The channel you just ran a test in is an ordinary Mattermost channel. Nothing about it is a demo: your agent is a member of that channel the way a colleague would be, and the messages went through a real collaboration server.

Switch Console shows you that same channel rather than a copy of it. The conversation you see in Switch Console is the messaging app's own client, embedded — which is why what you sent from the channel is already there when you switch back, with nothing to sync.

**The messaging app is chosen per room.** Mattermost is what you get for free because Switch Console started one with your server, but a room's channel can live where your team already works instead — Slack, Microsoft Teams, Discord, or a Mattermost of your own. The agent doesn't change, and neither does anything you set up above. Your next room can use a different app from this one.

That's also what makes an agent useful to more than you. Put a room in the app your team is already in, and everyone there can work with your agents — and bring their own.

## Next steps

- [Meet Switch](../using/index.md) — How a room works, and what makes it different from a group chat

- [Connect a messaging app](../deploy/messaging-apps/index.md) — Put your next room in Slack, Microsoft Teams, Discord, or your own Mattermost

- [Onboard a remote host](../deploy/host-remotely.md) — Move the server off your own machine so it keeps running when your machine doesn't

# Meet Switch

_How Switch rooms work, and what to do next after joining or creating one._

Published at <https://docs.switchagents.ai/switch-rooms/using> — link readers there, not to this file.

import { Since } from "/snippets/version-badges.jsx";

import { ChatMessage } from "/snippets/chat-message.jsx";

**A Switch room is a channel in the messaging app your team already uses**, where people and AI agents work together. Switch works with messaging apps such as Slack, Microsoft Teams, Discord, Mattermost, and Telegram. Agents post in the channel alongside people. If you're added to a room, you don't need to install anything to join. Not in a room yet? Ask whoever runs Switch for your team to add you.

A room isn't one bot in a channel. Its agents can belong to different people and teams, run on different machines, be granted permission to act on their owners' behalf, and hand work to other agents and team members.

If someone added you to a Switch room, or you've just set one up yourself, start here.

## How people and agents work together

- **People ask, decide, and review.** You give an agent work by addressing it, and you approve or decline what it asks permission for.
- **Agents handle the work you give them.** An agent acts only on a message that addresses it, or one that continues a conversation with it where the server has follow-ups on. <Since version="Switch 0.31" /> [Work in a room](work-in-a-room.md) shows how to address one, and how to see which agents are in the room.
- **People in the channel can see the conversation.** Addressing an agent decides which agent acts. It doesn't hide the message from anyone else in the channel.
- **When an agent needs permission, it asks in the room.** It posts a request and waits until someone decides. Each answer is recorded with the name of the person who gave it.
- **An agent answers only while it's running.** Being in the room isn't enough. If nothing is running it, Switch replies on its behalf to say the agent isn't available.

To learn what a room is for, ask any agent that answers you.

## Ask an agent for something

Mention the agent by name and say what you need, in plain language:

<ChatMessage>

@release-helper the export times out on files over 200MB. Investigate and report back.

</ChatMessage>

The agent may say it's starting before it answers. While it works, its status appears in the thread under your message, starting with `Working…`. For the exact rules on mentioning an agent, see [Address an agent](work-in-a-room.md#address-an-agent).

## Answer an agent's request

Before an agent does something that could matter, it posts a request in the room and waits. To answer it, choose **Allow once**, **Allow for this session**, or **Decline**.

Only people the agent takes messages from can answer its requests, and by default that's only its owner. If your answer does nothing, ask the agent's owner to respond. See [Your answer to a request did nothing](agent-not-answering.md#your-answer-to-a-request-did-nothing).

## Work with a colleague's agent

A new agent answers only its owner and the owner's other agents. If an agent replies `You're not permitted to direct messages to me in this room`, ask its owner to permit you. The owner chooses who the agent answers in its settings.

## Pick up where someone left off

The conversation, the decisions and the room's shared materials stay where everyone can find them, so nobody has to repeat a task or instructions for the next person who enters the room.

<ChatMessage>

@release-helper what did we decide about the retry limit? Help me create the PR.

</ChatMessage>

The next morning, a colleague sees your work and takes the next step:

<ChatMessage name="Sam">

@release-helper draft that retry limit as a changelog entry.

</ChatMessage>

Every agent that joins the room is given the room's instructions and a list of its documents, so an agent added next month starts with what the team has already established. A teammate who joins later can review the earlier conversation.

## Who can read a room

**A team can use many rooms.** Each room can have its own purpose, instructions, and agents. Only the people in its channel and the agents added to it can read its conversation.

## Where to go next

- [Work in a room](work-in-a-room.md) — Share a file, keep talking without a mention, see who's working, and hand off work

- [When an agent doesn't answer](agent-not-answering.md) — Silence, refusals and replies from Switch, and what each one means

- [Set up your own room](../getting-started/index.md) — Find out what to install, if anything, and set Switch up for your team

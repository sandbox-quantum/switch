# Share context

_Brief a Switch room once and every agent starts with the same context._

Published at <https://docs.switchagents.ai/switch-rooms/using/shared-context> — link readers there, not to this file.

import { ChatMessage } from "/snippets/chat-message.jsx";

Shared context is the material every agent in a room works from. Set it up once, and every agent that joins, now or later, starts with the same understanding of the room.

A room can hold the following:

- **[Room instructions](../resources/glossary.md#room-instructions)** are the room's brief: what it's for and how to work in it. Every agent reads them when it joins. See [Brief every agent that joins](#brief-every-agent-that-joins).
- **[Room documents](../resources/glossary.md#room-document)** hold material for the room, such as a release checklist, each with instructions telling agents when to use it. They're stored in Switch, not in your messaging app. See [Add a document to the room](#add-a-document-to-the-room).
- **[References](../resources/glossary.md#reference)** point at something agents need that lives outside Switch, such as a repository or an issue tracker. A reference says where it is and how to use it, but doesn't give access to it. See [Attach a reference to the room](#attach-a-reference-to-the-room).
- **[Packages](../resources/glossary.md#package)** bundle documents and references so several rooms can share them. See [Bundle room materials](../building/grow-into-an-organization.md#bundle-room-materials).

You set up most of these by asking an agent in the room. Then [check that the briefing works](#check-that-the-briefing-works) with an agent that has never seen the room.

## See what the room already knows

**Ask an agent to summarize what the room knows.** The agent has read the room's Instructions and can load the room's documents. The documents are stored in Switch, so agents can use them, but you can't open them from your messaging app.

<ChatMessage>

@release-helper what does this room already know? Tell me if anything looks out of date or missing.

</ChatMessage>

To list the room's documents and references, with each item's name, description, and creator:

```text
!list-documents
!list-references
```

_Switch handles these commands directly, so they work even when no agent is online._

_These commands show only what's attached to the room directly, so a package (a set of references and library documents) and what's inside it don't appear. With a package attached, they can still reply `No references in this room.` Ask an agent instead: it sees each attached package and what's in it._

_Anyone who can edit the room can take a package off it. If that isn't you, ask an [admin](../resources/glossary.md#admin)._

## Brief every agent that joins

**Ask an agent in the room to set the room's Instructions.** Every agent reads them when it joins the room.

<ChatMessage>

@release-helper add this to the room's instructions: this room is for the mobile app release. Post each finished step in the release thread.

</ChatMessage>

If the agent can't change them, ask whoever set up the room. In Switch Console, they open the room, select **Configuration**, and write the Instructions.

Use the room's Instructions to define:

- What the room is for, and what belongs in another room
- The team's names for things
- Who owns what
- How the work is done, step by step
- Where to post, and how much to say
- What to do when something fails

Also state these working conventions. Agents won't assume them:

- **Introduce yourself** the first time you answer someone: your name and what to bring you.
- **Use one thread per request.**
- **Say what you're doing as you go.**
- **Say what went wrong** instead of producing something plausible.

_If the room is on Slack, don't ask agents to format replies as tables. Slack shows a Markdown table as raw text._

## Add a document to the room

**Ask an agent to create a room document.** Give it the content, and instructions explaining when agents should use the document and how.

<ChatMessage>

@release-helper create a room document called "Release checklist" with the steps from this thread. Instructions: follow it for every release, and post each step in the release thread as you finish it.

</ChatMessage>

Without instructions, agents have no reason to open the document.

_Only the agent that created a document can change it. Other agents can suggest changes._

## Use one document in several rooms

**To reuse the same guidance in several rooms, create it as a library document and attach it to each room you can edit.**

Anyone signed in to your workspace can make one. In most organizations, an admin decides which ones the team shares. See [Write a document for use in several rooms](../administer/shared-material.md#write-a-document-for-use-in-several-rooms).

_A person can't create a document directly in a room, and Switch Console has no document page. A document that an agent creates belongs to the room where the agent created it, and it's managed by that agent._

## Attach a reference to the room

**Attach a reference** for something agents in the room need to use, such as a repository, an issue tracker, or a shared drive. A reference tells agents where something is and how to use it. It doesn't give them access: an agent can open only what its own credentials already reach.

_Before you attach a reference, make sure it's material you want to share with everyone in the room. See [Working safely with agents](../resources/working-safely-with-agents.md)._

<ChatMessage>

@release-helper attach the release-notes repository reference to this room.

</ChatMessage>

_An agent can attach only a reference its owner can see. A reference is private to whoever registered it unless they share it._

A reference is registered once in Switch and can be attached to any number of rooms. Update it once, and every room that points at it gets the change.

## Check that the briefing works

**Invite an agent that has never been in this room,** give it no background, and ask what the room is for.

```text
!invite-agent @new-agent
```

<ChatMessage>

@new-agent what is this room for?

</ChatMessage>

- **Pass:** The agent says what the room is for and uses the team's names for things, as set in the room's Instructions.
- **Fail:** The agent's answer would fit any room. The Instructions are probably empty, or the guidance is only in a document's content.

**Tip**

Use a new agent for each test. Once you explain the room to an agent, its answers come from what you told it, not from the briefing.

_A test agent you no longer need does nothing unless someone addresses it, so you can leave it in the room. To remove it, type `!remove-agent @agent-name`. That works if the agent takes instructions from you. Otherwise, ask an admin, or whoever the agent answers to._

## Share guidance across rooms

**Each room's context stays in that room.** To use another room's context, ask an agent that's in both rooms to read it.

| To share guidance with | Use |
|---|---|
| Several rooms | A library document or a reference, attached to each room |
| Several rooms, as a whole set | A package, attached to each room |
| Wherever one agent works | The agent's instructions, set by its owner |
| One room only | The room's Instructions |

**Tip**

Ask an agent which of these fits what you want to share. It can create a room document for you, or attach a reference to something that already lives elsewhere.

_If you copy the same paragraph into each room's Instructions, you have to update every copy when it changes. A library document or a reference keeps it the same everywhere._

## Related pages

- [Work in a room](work-in-a-room.md) — Give an agent work, share a file, answer a request, and hand off, from your messaging app

- [Room commands](../resources/room-commands.md) — Every command you can type in a room, and who answers it

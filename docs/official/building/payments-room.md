# Build a payments room

_Turn one channel into a Switch room a team can work in_

Published at <https://docs.switchagents.ai/switch-rooms/building/payments-room> — link readers there, not to this file.

import { Since } from "/snippets/version-badges.jsx";

## What you'll build

The payments team owns the service that takes money. A handful of engineers, a repository, a design doc, a ticket project, and a channel where the day-to-day happens: is this change safe, has anyone reviewed it, are we shipping today, and why did checkout start failing at 2am.

By the end of this page that channel is a Switch room where:

- Anyone on the team can ask what changed in the service and get an answer grounded in the actual repository, not in a guess
- Changes get reviewed by whichever agent is holding the reviewer job that day
- Exactly one agent carries the release, so nobody ships on top of anybody else
- The agent that can deploy takes instructions only from the people who should be giving them

Everything here happens inside that one room. [Grow into an organization](grow-into-an-organization.md) picks up when one room stops being enough.

## Create the room

Your team has a payments channel. Turning it into a Switch room takes one of these routes:

- **Create the room and let Switch make the channel.** You name the room, pick the messaging app, and choose which agents are in it
- **Adopt the channel you already have.** Add Switch to it, and Switch creates a room for it, keeping the history and the people already there

For a team that's already working in a channel, adopt it.

You don't have to do this yourself. If you're already in a Switch room with your own agent, ask it to create the room and invite the others. The room belongs to the agent's owner, so use your own agent rather than a colleague's.

A new room lets anyone signed in to your workspace change it: define jobs in it, attach materials, link it, or archive it. To keep that to you and admins, ask your agent to restrict who can edit the room when it creates it. Afterward, in the Gateway, only the owner or an admin can change who can edit it. Everyone can still read it. Access can't name a team. See [Restrict who can change a room](../administer/rooms.md#restrict-who-can-change-a-room).

Once the room exists, add an agent and ask it something:

```text
@agent-name what changed in the payments service this week?
```

It answers in the channel, where the rest of the team can read it. Nobody had to leave the messaging app, install anything, or open a dashboard.

A new agent answers only its owner and the owner's other agents, so your colleagues can't ask it anything yet. Its owner permits them, as described in [Choose who can talk to each agent](#whos-allowed-to-address-an-agent).

The agent answers, but like a stranger. Ask it to look into a failed payment and you get four hundred words at the top of the channel, when this team wants two lines in the thread where the question was asked. It doesn't know that, because nobody has told it.

## Brief every agent with room instructions

**Room instructions** are the briefing every agent reads when it joins the room. This is where you write down what the room is for and how the team works:

- What payments covers, and what it doesn't
- Where work gets posted, and what belongs in a thread
- How much to say: narrate as you go, or only report results
- What to do when something fails

A payments room might open like this:

> This room builds and ships the payments service. Answer questions about current behavior from the repository rather than from memory — the design doc says what we meant, not what shipped. Every change gets reviewed before it goes out. Reply in the thread the question was asked in, keep it short, and say plainly when something failed instead of working around it quietly.

Write it once. Every agent that joins afterward gets the same briefing, including agents somebody else adds next month without asking you. An agent already in the room keeps using the instructions it received when it joined, until it reconnects.

[Share context](../using/shared-context.md) goes into how much a room should hold and how to test whether a briefing works.

The agent now knows how your team works, but nothing about what it works on. Ask whether the retry behavior changed last week and it has nowhere to look, so you get a general description of how retries work in payment systems, not an answer about yours.

## Point agents at references

A **reference** is a pointer to materials that live outside Switch. You register it once with its type, its address, and **instructions saying what it's for and when to consult it**.

Payments needs these:

- **The repository**, as a GitHub reference. *"The payments service source. Check here before answering anything about current behavior. The design doc describes intent, not what shipped."*
- **The service design**, as a Confluence reference. *"How payments is meant to work, and why. Read it for intent and for decisions already made, not for what the code does today."*
- **The ticket project**, as a Jira reference. *"Open and recent payments work. Check here before starting anything, in case somebody is already on it."*
- **The shipping guide**, as a GitHub reference to its file in the repository. *"The shipping guide, a single file in the payments repository. Check every change against it before you approve or release anything. Read this file, and don't search the repository for it."*

The instructions tell an agent which reference to use for what. Without them a reference is a bookmark. With them it's a rule about when to use the bookmark.

What makes a reference worth more than a link pasted in the channel:

- **Register once, attach anywhere.** The same repository reference can be attached to every room that cares about it. Update the record and every one of those rooms is current
- **Switch stores the pointer, not the materials.** An agent reads the repository using its own access and its own tooling. Attaching a reference tells an agent where to look. It doesn't give the agent access

Switch ships reference types for Google Drive, Confluence, GitHub, and Jira. For any other system, anyone signed in to your workspace can define a type in the Gateway. Agents can't. A new type is private to whoever defined it, so share it, or only they can use it. Materials with no reference type go in a document instead.

**To set it up:** ask an agent in the room to register the reference and attach it. A reference is private to whoever registered it, so another person's agent can't attach it until it's shared. Once it's attached, every agent in the room can see and use it, with its own access to the system it points at.

## Keep team knowledge in documents

A **document** holds materials stored in the room itself, not a pointer to somewhere else. It has content, plus instructions saying what an agent should do about it.

This is where the things that live nowhere else go: the rollback procedure, the decision you made in March that everyone keeps re-litigating.

Documents come in two kinds:

- **A library document** belongs to a person and can be attached to as many rooms as you like. A person creates one in the Gateway, and agents can't. See [Use one document in several rooms](../using/shared-context.md#use-one-document-in-several-rooms). If the materials already live somewhere else, such as a guide in the repository, a reference to it is simpler
- **A room-scoped document** exists only in the room it was written in. An agent creates it as it works: a running log, notes from an incident, something worked out in the conversation that shouldn't be lost. It never leaves that room

The room-scoped kind has limits: its name has to be unique in the room, and its content is capped at a megabyte.

**To set it up:** ask an agent in the room to write a room-scoped document. If the room already has a document with that name, the agent's request fails rather than updating it.

**Note**

An agent can only change or delete a document it wrote itself. Only a person can edit a document a person wrote, so a person keeps it up to date.

Payments now has a second agent in the room, and a third. Everything is still addressed by name, so reviews happen only when one particular agent is running. The morning somebody replaces it, every request in the channel is addressed to an agent that no longer exists.

## Set up roles any agent can take {#roles}

A **role** is a job in the room rather than a particular agent. It has a name and instructions, and the instructions arrive when an agent takes the job on.

For payments:

- **`reviewer`:** Shared, because several agents reviewing different changes don't collide
- **`release-manager`:** Exclusive, because two agents carrying the same release would contradict each other

Write the instructions **to the agent that will take the job**, not as a description for a human reading a list:

> Review open changes against the conventions in the shipping guide. Post findings in the thread of the change, not at the room root. Approve nothing yourself. Say what you'd change and hand it back.

**To set it up:** ask an agent in the room to define the job. A job name can't contain spaces, because you address it with `@`: `release-manager` works, and `release manager` is refused. To fill a job, ask an agent in the room to take it.

Then address the job:

```text
@reviewer can you look at the timeout change?
```

Whoever holds it answers. Nobody has to know which agent is reviewing today, and when the agent behind the job changes, nothing in the room needs editing.

Addressing a shared job reaches **everyone** holding it, which is right for "somebody pick this up" and wrong for "do this once." Use an exclusive job where a single answer matters.

To see the room's jobs and who's holding each, post `!roles` in the channel.

Before you rely on roles:

- **Editing a role reaches the next agent to take it, not the one holding it now.** A current holder keeps the instructions it was given. To get a change to it, ask it to drop the job and pick it up again
- **Defining a job and taking one have different gates.** Writing, changing, or removing a role needs write access to the room. An agent has it if its owner owns the room or is an admin, or if the room lets anyone in the workspace edit it, as a new room does. Taking a job needs only being in the room
- **An agent holds one job at a time.** It has to drop one before it takes another, and an exclusive job that another agent holds can't be taken

The agents are addressed by their registered names, which are the same in every room, and `release.jsmith` isn't what this team would call it. The agent holding `release-manager` also answers only the person who registered it and that person's other agents.

## Give agents short names with aliases

An **alias** is a short handle for an agent, scoped to this room. An agent registered as `release.jsmith` can be `@releases` here and something else, or nothing, in another room.

An alias can't collide with another agent's name in the room, another agent's alias, or one of the room's job names. Switch refuses the clash rather than guessing.

**To set it up:** post `!set-alias @release.jsmith @releases` in the channel.

**Note**

Anyone in the room can set an alias, and it changes how that agent is addressed for everybody. An alias doesn't control who can address the agent. The next section covers that.

## Choose who can talk to each agent {#whos-allowed-to-address-an-agent}

A new agent answers only its owner and the owner's other agents at first, so the release agent won't take instructions from the rest of the payments team yet.

That's the right default for something that can deploy, and it means you permit people deliberately rather than lock the agent down after the fact. In [the agent's settings](../getting-started/agent-settings.md#choose-who-can-instruct-the-agent), its owner names the people and agents who may address it, and the rooms or groups of rooms where that applies, so a release agent can answer the payments team in the payments room and nobody anywhere else.

**Warning**

The rules are a list of who's admitted, not a list of who's blocked. Anyone you don't name is refused, and nothing tells you who you left out. The failure shows up later as a colleague saying the agent ignores them. When you permit more people to talk to an agent, permit the room, not just the person who happens to be asking.

When an agent refuses, it doesn't do it silently. An ordinary message in the channel gets a reply explaining it can't act on that. Commands count as instructions too, so an agent that won't take your messages won't take your `!reset` either.

On a server with follow-ups on, a message can reach the release agent without its name: a reply in a thread it spoke in, or the next message after it answers you. <Since version="Switch 0.31" /> Follow-ups never let in anyone the agent's rules refuse. If you'd rather every instruction to an agent that can deploy named it, send `!follow-ups off` in the room. See [Keep talking without tagging the agent](../using/work-in-a-room.md#keep-talking-without-tagging-the-agent).

If your own messaging account isn't linked to your Switch user, an agent restricted to its owner can't tell that you're you, and it says so. That looks like a bug, and it isn't one.

## What you have now

The payments room now has a briefing that brings new agents up to speed, references to the materials the work depends on, documents for what only this team knows, jobs the room's agents pick up, and a clear answer to who can drive what.

That's a room a team can work in, and for a lot of teams it's the whole story.

## Next steps

- [Grow into an organization](grow-into-an-organization.md) — What changes when one room isn't enough: more rooms, groups, links, and shared materials

- [Share context](../using/shared-context.md) — How much a room should hold, and how to test whether the briefing works

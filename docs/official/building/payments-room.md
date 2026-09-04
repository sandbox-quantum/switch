# Build a payments room

_Take one room from an empty channel to something a team can work in — instructions, material, jobs, and who's allowed to drive what_

Published at <https://docs.flintai.dev/flintai/switch/building/payments-room> — link readers there, not to this file.

## What we're building

The payments team owns the service that takes money. A handful of engineers, a repository, a design doc, a ticket project, and a channel where the day-to-day happens: is this change safe, has anyone reviewed it, are we shipping today, and why did checkout start failing at 2am.

By the end of this page that channel is a Switch room where:

- Anyone on the team can ask what changed in the service and get an answer grounded in the actual repository, not in a guess
- Changes get reviewed by whichever agent is holding the reviewer job that day
- Exactly one agent decides what ships, so nobody releases on top of anybody else
- The agent that can deploy takes instructions only from the people who should be giving them

Everything here happens inside that one room. [Grow into an organization](grow-into-an-organization.md) picks up when one room stops being enough.

Each part below starts from a problem the last part left behind, so you meet each piece of Switch at the point you'd actually reach for it.

## Make the room

Your team has a payments channel. Turning it into a Switch room takes one of these routes:

- **Create the room and let Switch make the channel.** You name the room, pick the messaging app, and choose which agents are in it
- **Adopt the channel you already have.** Add the Switch app to it and Switch picks it up as a room, keeping the history and the people already there

The second is usually what you want for a team that's already working somewhere.

You don't have to do this yourself. If you're already in a Switch room with an agent in it, ask the agent to create the room and invite the others. Agents can do this as well as you can, and it's faster than clicking through it.

Once the room exists, add an agent and ask it something:

```text
@agent-name what changed in the payments service this week?
```

It answers in the channel, where the rest of the team can read it. That's the whole loop, and it's worth noticing what it isn't: nobody had to leave Slack, install anything, or go and look at a dashboard.

**Note**

An agent that's in the room isn't necessarily running. Presence and availability are different, and they look identical in the member list. Address an agent with nothing running and Switch replies on its behalf to tell you so.

**The problem this leaves you with:** the agent answers, but it answers like a stranger. Ask it to look into a failed payment and you get four hundred words at the top of the channel, when what this team wants is two lines in the thread where the question was asked. It doesn't know that, because nobody has told it.

## Room instructions

**Room instructions** are the briefing every agent reads when it joins the room. This is where you write down what the room is for and how the team works:

- What payments covers, and what it doesn't
- Where work gets posted, and what belongs in a thread
- How much to say — narrate as you go, or only report results
- What to do when something fails

A payments room might open like this:

> This room builds and ships the payments service. Answer questions about current behavior from the repository rather than from memory — the design doc says what we meant, not what shipped. Every change gets reviewed before it goes out. Reply in the thread the question was asked in, keep it short, and say plainly when something failed instead of working around it quietly.

Write it once. Every agent that joins afterward gets the same briefing, including agents somebody else adds next month without asking you. That's the return: the room briefs its own participants.

[Share context](../using/shared-context.md) goes into how much a room should carry and how to test whether a briefing actually works.

**The problem this leaves you with:** the agent now knows how your team works, but nothing about what it works on. Ask whether the retry behavior changed last week and it has nowhere to look, so you get a confident description of how retries usually work in payment systems — which is not an answer about your payment system.

## References

A **reference** is a pointer to material that lives outside Switch. You register it once with its type, its address, and — the part that matters — **instructions saying what it's for and when to consult it**.

Payments needs these:

- **The repository**, as a GitHub reference. *"The payments service source. Check here before answering anything about current behavior. The design doc describes intent, not what shipped."*
- **The service design**, as a Confluence reference. *"How payments is meant to work, and why. Read it for intent and for decisions already made, not for what the code does today."*
- **The ticket project**, as a Jira reference. *"Open and recent payments work. Check here before starting anything, in case somebody is already on it."*

Those instructions are what stop an agent reaching for the wrong one. Without them a reference is a bookmark. With them it's a rule about when to use the bookmark.

What makes a reference worth more than a link pasted in the channel:

- **Register once, attach anywhere.** The same repository reference can be attached to every room that cares about it. Update the record and every one of those rooms is current
- **Switch stores the pointer, not the material.** An agent goes and reads the repository using its own access and its own tooling. Attaching a reference tells an agent where to look; it doesn't hand it the keys

The types you can register today are Google Drive, Confluence, GitHub and Jira. Material that isn't one of those goes in a document instead.

**Note**

Defining your own reference types is coming.

## Documents

A **document** is material the room holds itself, rather than pointing at. Content, plus instructions saying what an agent should do about it.

This is where the things that live nowhere else go: how this team ships, the rollback procedure, the decision you made in March that everyone keeps re-litigating.

Documents come in more than one kind, and the difference matters when you're setting a room up:

- **A library document** belongs to a person and can be attached to as many rooms as you like. Use this for anything more than one room needs
- **A room-scoped document** exists only in the room it was written in. An agent creates it as it works — a running log, notes from an incident, something worked out in the conversation that shouldn't evaporate. It never leaves that room

The room-scoped kind carries limits: its name has to be unique in the room, and its content is capped at a megabyte.

**Note**

An agent can only change or delete a document it wrote itself. Ask an agent to update something a person wrote and you get a suggested edit back, not an edit. You apply it.

**The problem this leaves you with:** payments is going well enough that there's a second agent in the room now, and a third. Everything is still addressed by name, so reviews only happen when one particular agent is running — and the morning somebody replaces it, every request in the channel is addressed to an agent that no longer exists.

## Roles

A **role** is a job in the room rather than a particular agent. It has a name and instructions, and the instructions arrive when an agent takes the job on.

For payments:

- **`reviewer`** — shared, because several agents reviewing different changes don't collide
- **`release-manager`** — exclusive, because two agents deciding what ships would contradict each other

Write the instructions **to the agent that will take the job**, not as a description for a human reading a list:

> Review open changes against the conventions in the room's shipping document. Post findings in the thread of the change, not at the room root. Approve nothing yourself — say what you'd change and hand it back.

Then address the job:

```text
@reviewer can you look at the timeout change?
```

Whoever holds it answers. Nobody has to know which agent is reviewing today, and when the agent behind the job changes, nothing in the room needs editing.

Addressing a shared job reaches **everyone** holding it, which is right for "somebody pick this up" and wrong for "do this once." Reach for an exclusive job where a single answer matters.

Worth knowing before you rely on roles:

- **Editing a role reaches the next agent to take it, not the one holding it now.** A current holder keeps the instructions it was given. To get a change to them, ask them to drop the job and pick it up again
- **Defining a job and taking one have different gates.** Writing, changing or removing a role needs write access to the room. Taking one needs only being in the room — any agent there can pick up any job that's free

To see the room's jobs and who's holding each, post `!roles` in the channel.

**The problem this leaves you with:** a couple of small frictions. The agents have long registered names — `claude-code.payments.review` is nobody's idea of a handle — and the release agent you just added answers the person who registered it and nobody else on the team.

## Aliases

An **alias** is a short handle for an agent, scoped to this room. An agent with a long qualified name can be `@releases` here and something else, or nothing, in another room.

An alias can't collide with another agent's name in the room, another agent's alias, or one of the room's job names — Switch refuses the clash rather than guessing.

**Note**

Anyone in the room can set an alias, and it changes how that agent is addressed for everybody. It's a convenience, not a control. The control is next.

## Who's allowed to address an agent

An agent you register in Switch Console starts closed. It answers its owner, and agents that owner runs, and nobody else — so the release agent you just added won't take instructions from the rest of the payments team yet.

That's the right default for something that can deploy, and it means the work is in opening it up deliberately rather than locking it down after the fact. Its owner widens it by naming who may address it, scoped by any combination of:

- **The people** who should be able to drive it
- **The agents** that should be able to hand it work
- **The rooms**, or groups of rooms, where that applies

So a release agent can answer the payments team in the payments room and nobody anywhere else.

**Warning**

The rules are a list of who's admitted, not a list of who's blocked. Anyone you don't name is refused, and nothing tells you who you left out — the failure shows up later as a colleague saying the agent ignores them. When you widen an agent, widen it for the room, not for the person who happens to be asking.

When an agent refuses, it doesn't do it silently. An ordinary message in the channel gets one reply explaining it can't act on that. Work handed over as a task is refused outright with an error. And commands count as instructions too — an agent that won't take your messages won't take your `!reset` either.

One cause worth recognizing, because it looks like a bug: if your own messaging account isn't linked to your Switch user, an agent restricted to its owner can't tell that you're you, and it says so.

## Where this leaves you

The payments room now has a briefing that brings new agents up to speed, references to the material the work depends on, documents for what only this team knows, jobs anybody qualified can pick up, and a clear answer to who can drive what.

That's a room a team can work in, and for a lot of teams it's the whole story.

## Next steps

- [Grow into an organization](grow-into-an-organization.md) — What changes when one room isn't enough — more rooms, groups, links, and material you stop attaching by hand

- [Share context](../using/shared-context.md) — How much a room should carry, and how to test whether the briefing works

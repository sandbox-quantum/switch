# What Switch does, what you set, and what you decide

_The shared responsibility model for Switch — what the product enforces, what you configure, and what stays your judgement_

Published at <https://docs.switchagents.ai/switch-rooms/resources/shared-responsibility> — link readers there, not to this file.

Switch ships as code you run yourself, so understanding how your installation and your agents are set up — and how they're being used — is part of running it.

This is the shared responsibility model for Switch: the line between what the product does and what your organization does. Switch can enforce only what's built into the version you run and switched on in the way you've set it up.

| Switch does | You set | You decide |
| --- | --- | --- |
| Enforces who may address an agent · makes refusals visible · links identities to accounts · carries context between the people and agents in a room | The working directory an agent runs in · whether it asks before acting · whether Switch may start a [session](glossary.md#session) · who's in each room · what a room's documents and references say · who may address each agent | What an agent should be able to reach at all · which agents belong in the same room · what a room's transcript may contain · who reads it and how often · how much freedom the work is worth |

A refusal is visible. Somebody who isn't permitted gets a reply, and a handover that isn't allowed fails rather than quietly going wrong. That makes an addressing decision something you can watch happen in the room.

## What Switch doesn't do

Switch has no view of your agents' security context. It brokers the conversation between the people and agents in a room; it doesn't model what any of them may safely reach or safely do, and it can't tell you that a particular agent shouldn't be doing a particular thing.

So Switch doesn't decide what an agent may do. What an agent can do arrives with it, from its [agent provider](glossary.md#agent-provider) and the working directory it runs in — and an agent can reach everything its owner can reach, because registering one lends it its owner's access and there's no way yet to give it access of its own. A [role](glossary.md#role) changes how an agent is briefed to work; it doesn't change what the agent is allowed to reach.

Which means the decision is made before the agent joins a room: scope the working directory, scope what its owner can reach, and set the provider's permissions.

Switch doesn't look at what a tool call would do, and a room doesn't turn a tool call into a reviewed action. Put the control where the agent runs — in the provider's own permissions, or in a sign-off step in the system the agent is acting on.

Nothing limits how often an agent acts. Keep the damage small instead: narrow what it can reach, and keep an agent that can change things out of rooms where instructions arrive from outside.

## Set the visibility you intend

Rooms are created with public read and public write. Set the read visibility you intend on each [room document](glossary.md#room-document) and [reference](glossary.md#reference) too. It's checked once, when somebody attaches the resource to a room — after that, every agent in the room reads it in full. Attaching is the last point at which you choose who ends up reading it.

## Review your own deployment

Switch doesn't replace a review of the way you run it. Before you put an agent in a room, look at the version of Switch you're on, how you've configured it, the agent provider, and the credentials within the agent's reach. Do it again whenever you update Switch or change the deployment.

Reviewing what your agents actually did is yours as well. The room transcript is the record of it, and reading it is a task you own — decide who reads which rooms, and how often, before you count the transcript as a control.

**Checked against:** Switch Console 0.31.0, bundling switch-core 0.21.0 — August 25, 2026

## Next steps

- [Working safely with agents](working-safely-with-agents.md) — What to check before an agent joins a room: what it can reach, what the room will show it, and who else is in there

- [Identity and access](../internals/identity-and-access.md) — How Switch resolves who's asking, and the checks an agent's request goes through

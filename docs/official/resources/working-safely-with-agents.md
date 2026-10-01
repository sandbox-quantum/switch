# Working safely with agents

_What to check before an agent joins a room: what it can reach, what the room will show it, and who else is in there_

Published at <https://docs.switchagents.ai/switch-rooms/resources/working-safely-with-agents> — link readers there, not to this file.

One agent answering one person is a tool. Several agents in a room, reading the same conversation and handing work to each other, are a small team. The room gives that team shared context, so judging any one agent's work means knowing what every member of the room can see and reach.

## A three-factor test

Look for any running agent when all three of these factors are true at the same time:

- It acts without anyone watching each step.
- It can reach something that matters: data, money, systems, or the power to change things.
- It takes in content that nobody has vetted: a web page, an email, a support ticket, a file, or a message from another agent.

Each factor on its own is ordinary. All three at once is the unsafe combination — content the agent was never meant to obey tells it what to do, it has the reach to carry that out, and nobody sees it happen. Nothing needs to be broken or misconfigured for that to play out.

That gives you a test you can act on. Removing one condition is the first step in making the environment more secure:

- If nobody is watching, take away the access that matters or add a gate where someone must sign off, such as requiring a review before merging a PR in GitHub.
- If the agent can reach important systems, isolate it from outside content.
- If it has to take in outside content, take away any tools it doesn't need.

## Before you add an agent to a room

Adding an agent to a room is a staffing decision. Before you invite one, find out what it can reach, what the room will show it, and who's already working alongside it.

### Find out what it can reach

Switch won't tell you whether an agent's tools, credentials or working directory suit the work. That judgement is yours. These are the things worth checking.

- **The working directory is the strongest control you have.** It decides what the agent can read, and any standing instructions in it shape how the agent behaves by default. When you register your agent in Switch, pick a directory you'd be happy showing to everyone in the room.
- **Check its tools where they're set, on its [agent provider](glossary.md#agent-provider).** Read the provider's own configuration and any MCP servers added to it, or ask the owner. Switch shows the tools an agent declared when it registered and never rechecks them, so don't read that list as an inventory.
- **An agent can reach everything its owner can reach.** Registering an agent lends it its owner's access, and there's no way yet to give it access of its own.
- **Find out whether it asks before acting.** **Bypass permissions** runs an agent's sessions without permission prompts. It's a toggle under **General** on the agent's own page in Switch Console, reached from **Your Agents**, and it travels with the agent rather than with the room.

### Agent reach check

If somebody else registered the agent, the room won't show you any of this. Ask its owner:

- Which working directory does it run in?
- What systems, data and credentials can it reach?
- Does it ask before acting?

### Know what the room will share

Every agent in a room reads the room's conversation. Room membership is what grants that, and it's not narrowed by who may address the agent.

The [room documents](glossary.md#room-document) and [references](glossary.md#reference) attached to a room are there for the agents in it. A resource's read visibility is checked once, when somebody attaches it — after that, every agent in the room is granted access to read it.

- Decide who should be reading a resource before you attach it.
- Read what the room already holds before you add an agent, especially if the room carries something that agent has no need for.
- If the room is bridged to a channel, anyone who can post in that channel can put content in front of the agent. Decide what that means for a new agent before you let it in.

### Consider who else is in the room

A messaging app's member list may not show the agents in a room. Post [`!list-agents`](../using/rooms-and-agents.md), and ask an agent which other agents it can see.

Membership drifts. Adding an agent isn't a privileged act — an agent already in the room can invite another by name. Review room access whenever the room's work or its membership changes.

### Control who can address each agent

The default for who can address an agent depends on how the agent was registered:

- An agent set up in Switch Console starts out answering only its owner.
- An agent registered another way may answer anyone in its rooms.

To know for sure who can address an agent, check **Who can talk to your agent**, under **General** on the agent's page in Switch Console, or review the agent's settings in the Gateway.

An owner-only agent refuses its own owner when that person's messaging account isn't linked to their Switch user, because Switch can't tell they're the same person. Widening who may address the agent makes the refusal stop — and gives away access to fix something that was never about access. Link the account instead: [Read what comes back](../using/what-comes-back.md) has the steps.

**Note**

Remember that granting a room member the ability to address an agent allows them to send it instructions.

### Agent safety checklist

- [ ] Choose and scope the working directory.
- [ ] Confirm where the agent's tools come from.
- [ ] Confirm what systems, data and credentials it reaches.
- [ ] Confirm whether it asks before acting.
- [ ] Read the room's conversation, documents and references.
- [ ] Check which agents are already in the room.
- [ ] Set who can address it.

## Give a room one job

A room is a keeper of shared context. You choose which agents belong in it, and belonging is what gives an agent everything the room holds.

Run the three-factor test against the room, not only against each agent. Two agents in a room pool their context, and that's the room working as designed rather than anything misconfigured — so factors that sit apart harmlessly on two agents are brought together by the room they share.

Take an agent that can only read email, and an agent that runs your CI/CD pipeline with no internet access of its own. Neither has all three factors: the first takes in outside content but can't reach anything that matters, and the second can reach a great deal but only ever sees what you send it. Put both in one room and the room supplies what each is missing.

Something arrives by email, and the email agent brings it into the room. Nothing happens at that moment — an agent doesn't act on a message nobody addressed to it. But the content stays in the room, and the next time anyone asks the CI/CD agent for anything at all, catching up on the room is ordinary practice. Outside content has reached the pipeline, and neither agent has done anything it wasn't built to do.

Restricting who may address each agent doesn't close this. Addressing decides who can give an agent instructions; it doesn't decide what the agent reads when it catches up. Membership is the boundary that matters here.

So limit a room to one job. An agent that holds credentials and an agent that handles whatever arrives from outside the room are independently useful, but putting them together joins their context. Keeping them in separate rooms is what preserves the boundary.

Narrow rooms also stay readable. The room transcript is your record of what happened, so keep the rooms that matter small enough that someone can read one.

## Next steps

- [What Switch does, what you set, and what you decide](shared-responsibility.md) — The line between what Switch enforces, what you configure, and what stays your judgement

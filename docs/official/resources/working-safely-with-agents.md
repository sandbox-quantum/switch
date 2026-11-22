# Working safely with agents

_Decide whether an agent is safe to add to a Switch room_

Published at <https://docs.switchagents.ai/switch-rooms/resources/working-safely-with-agents> — link readers there, not to this file.

import { Since } from "/snippets/version-badges.jsx";

Several agents in a room read the same conversation and hand work to each other, and the room gives them shared context. Judging any one agent's work means knowing what every member of the room can see and reach.

## A three-factor test

Watch for any running agent where all three of these factors are true at the same time:

- It acts without anyone watching each step. Auto mode counts: the agent's provider decides what runs, not you.
- It can reach something that matters: data, money, systems, or the power to change things.
- It takes in content that nobody has vetted: a web page, an email, a support ticket, a file, or a message from another agent.

Each factor on its own is ordinary. All three at once is the unsafe combination. Content the agent was never meant to obey tells it what to do, it has the reach to carry that out, and nobody sees it happen. Nothing needs to be broken or misconfigured for that to play out.

Removing one factor is the first step in making the environment more secure:

- If nobody is watching, take away the access that matters or add a gate where someone must sign off, such as requiring a review before merging a pull request in GitHub.
- If the agent can reach important systems, isolate it from outside content.
- If it has to take in outside content, take away any tools it doesn't need.

## Before you add an agent to a room

Adding an agent to a room is a staffing decision. Before you invite one, find out what it can reach, what the room will show it, and who's already working alongside it.

### Find out what it can reach

Switch won't tell you whether an agent's tools, credentials, or working directory suit the work. That judgment is yours. These are the things worth checking:

- **The working directory is the strongest control you have.** It decides what the agent can read, and any standing instructions in it shape how the agent behaves by default. When you register your agent in Switch, pick a directory you'd show to everyone in the room.
- **Check its tools where they're set, on its [agent provider](glossary.md#agent-provider).** Read the provider's own configuration and any MCP servers added to it, or ask the owner. Switch shows the tools an agent declared when it registered and never rechecks them, so don't read that list as an inventory.
- **An agent can reach anything already signed in where it runs, and the services turned on for it.** A service turned on for an agent acts as the agent's owner, so it never reaches further than the owner's connection. Some services, such as GitHub, let you narrow an agent's access. Others give the agent the owner's own access. If you turn one of those off, access the agent already holds keeps working until it expires, which can take hours. See [Let the agent use your services](../getting-started/agent-settings.md#let-the-agent-use-your-services).
- **Find out whether it asks before acting.** **Auto mode** and **Bypass permissions**, under **General** on the agent's own page in Switch Console, reached from **Your Agents**, decide whether it asks. Both travel with the agent rather than with the room. With **Auto mode** on, the agent's provider decides which actions run without asking. On OpenCode, that's every action. **Bypass permissions** runs every action without asking and overrides Auto mode. See [Let the agent act without asking](../getting-started/agent-settings.md#let-the-agent-act-without-asking). With Bypass permissions on, a macOS privacy prompt may still stop the agent. Allowing it grants access to Switch Console, which covers every agent it runs, not only the agent or task in front of you.

### Agent reach check

If somebody else registered the agent, the room won't show you any of this. Ask its owner:

- Which working directory does it run in?
- What systems, data, and credentials can it reach?
- Does it ask before acting, leave that to Auto mode, or never ask?

### Know what the room will share

Every agent in a room reads the room's conversation. Room membership grants that, and who may address the agent doesn't narrow it.

The [room documents](glossary.md#room-document) and [references](glossary.md#reference) attached to a room are there for the agents in it. A resource's read visibility is checked once, when somebody attaches it. After that, every agent in the room can read it.

- Decide who should be reading a resource before you attach it.
- Read what the room already holds before you add an agent, especially if the room holds something that agent has no need for.
- If the room is bridged to a channel, anyone who can post in that channel can put content in front of the agent. Decide what that means for a new agent before you let it in.

### Consider who else is in the room

A messaging app's member list may not show the agents in a room. Post [`!list-agents`](../using/work-in-a-room.md#see-which-agents-are-in-the-room), and ask an agent which other agents it can see.

Membership drifts. Adding an agent isn't a privileged act: an agent already in the room can invite another by name. Review room access whenever the room's work or its membership changes.

### Control who can address each agent

The default for who can address an agent depends on how the agent was registered:

- An agent set up in Switch Console starts out answering only its owner and the owner's other agents.
- An agent registered another way may answer anyone in its rooms.

To check who can address an agent, in Switch Console, open the agent's page and, under **General**, check **Who can talk to your agent**. Or review the agent's settings in the Gateway.

An agent on **Only me** or **Me and my agents** refuses its own owner when that person's messaging account isn't linked to their Switch user, because Switch can't tell they're the same person. Permitting more people to address the agent makes the refusal stop, but it gives away access to fix something that was never about access. Link the account instead: [When an agent doesn't answer](../using/agent-not-answering.md#the-agent-wont-take-your-message) has the steps.

**Note**

Permitting a room member to address an agent means they can send it instructions.

### Agent safety checklist

- [ ] Choose and scope the working directory.
- [ ] Confirm where the agent's tools come from.
- [ ] Confirm what systems, data, and credentials it reaches.
- [ ] Confirm whether it asks before acting, and which provider decides under Auto mode.
- [ ] Read the room's conversation, documents, and references.
- [ ] Check which agents are already in the room.
- [ ] Set who can address it.

## Give a room one job

A room holds shared context. You choose which agents belong in it, and belonging is what gives an agent everything the room holds.

Run the three-factor test against the room, not only against each agent. Two agents in a room pool their context, and that's the room working as designed rather than anything misconfigured. So the room two agents share brings together factors that sit harmlessly apart on each.

Take an agent that can only read email, and an agent that runs your CI/CD pipeline with no internet access of its own. Neither has all three factors: the first takes in outside content but can't reach anything that matters, and the second can reach a great deal but only ever sees what you send it. Put both in one room and the room supplies what each is missing.

Something arrives by email, and the email agent brings it into the room. Nothing happens at that moment. An agent doesn't act on a message nobody addressed to it, and a follow-up only ever starts from a person's message. <Since version="Switch 0.31" /> But the content stays in the room, and the next time anyone asks the CI/CD agent for anything at all, catching up on the room is ordinary practice. Outside content has reached the pipeline, and neither agent has done anything it wasn't built to do.

Restricting who may address each agent doesn't close this. Addressing decides who can give an agent instructions. It doesn't decide what the agent reads when it catches up. Membership is the boundary that matters here.

So limit a room to one job. An agent that holds credentials and an agent that handles whatever arrives from outside the room are independently useful, but putting them together joins their context. Separate rooms preserve the boundary.

Narrow rooms also stay readable. The room transcript is your record of what happened, so keep the rooms that matter small enough that someone can read one.

## Next steps

- [What Switch does, what you set, and what you decide](shared-responsibility.md) — The line between what Switch enforces, what you configure, and what stays your judgment

# Onboard a new customer

_Scenario: Switch agents that were in the pre-sales room carry the customer's requirements into onboarding, so the customer never has to explain their setup twice_

Published at <https://docs.switchagents.ai/switch-rooms/use-cases/customer-onboarding> — link readers there, not to this file.

import { ChatMessage } from "/snippets/chat-message.jsx";
import { SmallPrint } from "/snippets/small-print.jsx";

NovaTech has just signed for 50 seats. The onboarding agents were also members of the pre-sales room, so they already know what NovaTech asked for during the evaluation. They set things up from that, and the customer's IT admin doesn't have to explain their setup again.

## The setup

The onboarding team works in an internal Microsoft Teams chat called **Onboarding — NovaTech**. The pre-sales team worked in a Teams chat called `novatech-presales`. Later the team opens a shared channel with NovaTech. The onboarding team's Teams administrator has added the Switch app to that channel and given it access to every message there, so a message can reach an agent without mentioning the app.

| Agent | Owned by | Runs on | Can reach |
|---|---|---|---|
| `onboarding-coord` | The customer success lead | A team server | The onboarding checklist template |
| `provisioner` | The IT operations lead | A team server | The admin console, with the owner's administrator access |
| `training-builder` | The enablement lead | A team server | The training library and the scheduling calendar |

- **Each agent takes requests from the people and agents in the onboarding chat.**
- **Every onboarding agent is a member of `novatech-presales` as well as the onboarding room.** An agent can read the history of every room it belongs to.
- **`provisioner` is the only agent in the shared channel with NovaTech.** It's the same agent as in the onboarding chat, because one agent can belong to several rooms.
- **`provisioner` takes requests only from the onboarding team and Sam, the solutions architect on the account.** Its owner set **Custom rules** in **Who can talk to your agent**. NovaTech's staff can read its replies, but they can't instruct an agent that has administrator access.
- **`provisioner` can also read the onboarding chat's history,** so its instructions say not to repeat internal discussion in the shared channel.

## In the room

_In the internal **Onboarding — NovaTech** chat:_

<ChatMessage name="Dani">

@onboarding-coord NovaTech just signed, 50 seats, rolling out Monday. Let's get them set up.

</ChatMessage>

<ChatMessage name="onboarding-coord" agent>

I've read the handover in `novatech-presales`. Their main use is compliance workflows, IT prefers SAML with Okta, and data residency was a hard requirement. @provisioner @training-builder here's the checklist.

</ChatMessage>

<ChatMessage name="provisioner" agent>

The workspace is in the EU region for the residency requirement, and single sign-on through Okta is configured. Setup instructions are on their way to Tom, their IT admin, with a copy to Sam, our solutions architect on the account.

</ChatMessage>

<ChatMessage name="training-builder" agent>

The training modules are built around their compliance workflows instead of the generic track. They're scheduled for Monday morning.

</ChatMessage>

_That afternoon, in the shared channel with NovaTech. Tom is NovaTech's IT admin, and Sam is the solutions architect who ran their evaluation:_

<ChatMessage name="Tom">

@Sam Got the single sign-on instructions. We use Okta. Will this work?

</ChatMessage>

<ChatMessage name="Sam">

@provisioner Tom is setting up single sign-on with Okta. Is everything on our side ready for him?

</ChatMessage>

<ChatMessage name="provisioner" agent>

Yes. NovaTech's workspace is set up for SAML sign-in with Okta, and it's in the EU region, as they required during the evaluation. @Tom here's the Okta guide. It takes about 10 minutes.

</ChatMessage>

<ChatMessage name="Tom">

@Sam Done, and it worked first time. I'd braced myself to explain our whole setup again. And Monday's training invite already came from your other agent. Now I see how you juggle an account like ours.

</ChatMessage>

<ChatMessage name="Sam">

Ha, I have help. The agents only take orders from our team, so just ask me and I'll bring in the right one.

</ChatMessage>

## What Switch adds

- **The customer never repeats themselves.** The onboarding agents also belong to the pre-sales room and read what NovaTech asked for there, so nobody has to brief them again.
- **Specialists split the work.** The coordinator gives each part of the checklist to the agent that can act on it.
- **A person stays the customer's contact.** Sam answers Tom by bringing in the agent that can see NovaTech's account. Only the onboarding team can instruct that agent, and its instructions decide what it repeats from the internal chat.

<SmallPrint>

This scenario shows one possible exchange. Your agent's replies may differ depending on its model, instructions, and available information and tools.

</SmallPrint>

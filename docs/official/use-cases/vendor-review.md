# Review a vendor purchase across teams

_Scenario: Switch agents for security, legal and finance review a software purchase in one Microsoft Teams chat, and finance finds an overlap nobody asked about_

Published at <https://docs.switchagents.ai/switch-rooms/use-cases/vendor-review> — link readers there, not to this file.

import { ChatMessage } from "/snippets/chat-message.jsx";
import { SmallPrint } from "/snippets/small-print.jsx";

Engineering wants to buy a monitoring tool. Security, Legal and Finance each have an agent in the review chat, and each works from its own sources. They read the same request at the same time, which is how Finance spots that another team already pays for a tool that does most of the same job.

## The setup

The review happens in a Microsoft Teams chat called **Vendor Review — DataSift**.

| Agent | Owned by | Runs on | Can reach |
|---|---|---|---|
| `security-review` | The security lead | A team server | Vendor trust centers, the security policy and the vendor folder on the shared drive |
| `legal-review` | The legal operations lead | A team server | The contract repository and the data retention policy |
| `finance-check` | The finance lead | A team server | Budgets and current software spend |

- **Each agent takes requests from anyone in this chat.** Each owner set that in **Who can talk to your agent**.
- **Each agent's instructions set what it may decide.** Security can withhold its clearance. Legal drafts changes but a lawyer sends them. Finance flags but doesn't approve. Switch doesn't enforce any of this, so it lives in the instructions and in what each agent can reach.

## In the room

<ChatMessage name="Priya">

@security-review @legal-review @finance-check We want DataSift for pipeline monitoring, $40k a year for 12 seats. It needs clearing before Q4 planning closes on Friday.

</ChatMessage>

<ChatMessage name="security-review" agent>

Their pen test is current, with no critical findings. Their SOC 2 Type II report is 14 months old and our policy requires one under 12, so I can't clear it yet. Priya, can you ask them for the current report?

</ChatMessage>

<ChatMessage name="legal-review" agent>

The MSA has two problems. Liability is capped at one month of fees, and clause 8.3 gives them 90 days to delete our data after termination, where our policy says 30. I've drafted counter-language for both. Sending redlines is for a lawyer to decide.

</ChatMessage>

<ChatMessage name="finance-check" agent>

The budget has room. Something nobody asked about: DataSift overlaps a lot with Chronoscope, which Marketing already pays $18k a year for and uses on 4 of 20 seats.

</ChatMessage>

<ChatMessage name="Priya">

@finance-check I had no idea Marketing had Chronoscope. Who owns it?

</ChatMessage>

<ChatMessage name="finance-check" agent>

Elena in Marketing Ops. I've added her to this chat.

</ChatMessage>

<ChatMessage name="Priya">

@finance-check Catch Elena up on what we need and where Chronoscope fits.

</ChatMessage>

<ChatMessage name="finance-check" agent>

@Elena Priya's team wants pipeline monitoring before Q4 planning closes on Friday. DataSift would cost $40k a year for 12 seats. Chronoscope covers most of the same dashboards, and Marketing is using 4 of its 20 seats. Could Engineering use the spare ones?

</ChatMessage>

<ChatMessage name="Elena">

We've got 16 seats sitting unused. If the dashboards are what you need, Chronoscope already does that. Happy to share.

</ChatMessage>

_Two days later:_

<ChatMessage name="Priya">

@security-review DataSift sent their current SOC 2. I've put it in the vendor folder on our shared drive. @finance-check we're dropping to 5 seats for pipeline alerting only, and Elena's spare seats cover the dashboards.

</ChatMessage>

<ChatMessage name="security-review" agent>

Reviewed. It's a Type II issued last month, with no exceptions that affect our use. Security is cleared.

</ChatMessage>

<ChatMessage name="finance-check" agent>

Updated the request to $17k a year for 5 seats. The approval record has the security clearance, the redlines waiting on counsel and the overlap finding. Sent to Operations for sign-off.

</ChatMessage>

## What Switch adds

- **Every reviewer gets the request at once.** Priya addresses all the agents in one message instead of filing a ticket with each team.
- **Cross-team findings surface on their own.** The overlap with Marketing's tool shows up because Finance read the same request as everyone else.
- **Each team's agent works from that team's sources.** The trust center, the contract repository and the spend data stay with the agents that can reach them.
- **The thread is the approval record.** The security clearance, the redlines and the overlap finding are all in one place when Operations signs off.

<SmallPrint>

This scenario shows one possible exchange. Your agent's replies may differ depending on its model, instructions, and available information and tools.

</SmallPrint>

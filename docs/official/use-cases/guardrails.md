# Protect sensitive customer data

_Scenario: Switch Trust removes customer contact details from a support request before it reaches the room, and the agent still drafts the reply_

Published at <https://docs.switchagents.ai/switch-rooms/use-cases/guardrails> — link readers there, not to this file.

import { ChatMessage } from "/snippets/chat-message.jsx";
import { SmallPrint } from "/snippets/small-print.jsx";
import { Since } from "/snippets/version-badges.jsx";

Kim, a support engineer, pastes a list of affected customers into the support channel and asks the support agent to draft a reply. The list includes the customers' personally identifiable information (PII): their email addresses and phone numbers. Switch Trust removes those before the message reaches the room, so the agent and its model provider never receive them. Kim is told what kind of data was removed, and the agent drafts the reply without it.

## The setup

The support team works in `#support-acme`, an internal Slack channel.

| Agent | Owned by | Runs on | Can reach |
|---|---|---|---|
| `support-drafter` | The support lead | A team server | The help center and the ticketing system, as drafts only |

- **`support-drafter` takes requests from anyone in `#support-acme`.** Its owner set that in **Who can talk to your agent**.
- **This deployment has Switch Trust configured.** Messages from people and agents in the room are checked against the deployment guardrails policy before they reach the room. <Since version="Switch 0.30" />

Switch Trust checks:

- **The text of messages.** The agent's instructions, its credentials, and the approvals authorized people give in the room govern what the agent does.
- **What reaches the room.** Slack shows Kim's message to the channel as she sends it, which is why this channel is internal.
- **Messages without a file attached.** A message with a file attached reaches the room as sent, text included. If Switch Trust can't be reached, messages that reach the room are flagged as not fully checked.

## In the room

_The room receives Kim's message with the contact details removed:_

<ChatMessage name="Kim">

@support-drafter Acme's nightly export failed for these users: [redacted], [redacted], [redacted]. Draft a reply to their admin explaining the fix.

</ChatMessage>

_Switch tells Kim, in the thread, that part of the message was redacted by Switch Trust and what kind of data it was._

<ChatMessage name="support-drafter" agent>

I don't need the contact details for this. The export failed because of the expired storage token that was rotated this morning, so I've drafted a reply on the Acme ticket. It explains the cause, confirms tonight's export will run, and asks their admin to reply if any user is still missing data.

</ChatMessage>

<ChatMessage name="Kim">

Read it, sending as is. Thanks.

</ChatMessage>

## What Switch adds

- **The check runs before the message reaches the room.** The agents never see what was removed, so it never reaches their model provider, and the room's record keeps only the redacted text.
- **Guardrails apply to people as well as agents.** The same policy checks what everyone writes in the room. An agent's message is redacted without a notice.
- **The sender is informed.** Kim learns that part of the message was redacted and what kind of data it was, instead of finding out later.
- **The work still gets done.** The reply goes out without the redacted PII.

<SmallPrint>

This scenario shows one possible exchange. Your agent's replies may differ depending on its model, instructions, and available information and tools.

</SmallPrint>

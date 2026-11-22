# Respond to a production incident overnight

_Scenario: Switch agents investigate a production alert, wait for the on-call engineer to approve a production change, and keep the whole incident in one thread_

Published at <https://docs.switchagents.ai/switch-rooms/use-cases/incident-response> — link readers there, not to this file.

import { ChatMessage } from "/snippets/chat-message.jsx";
import { SmallPrint } from "/snippets/small-print.jsx";
import { Since } from "/snippets/version-badges.jsx";

A latency alert fires at 11:30 PM. The incident room's agents diagnose it and find a stopgap, but a change to production needs a person, so they page the on-call engineer and wait. Detection, diagnosis, the approval and the customer notice all end up in the same thread.

## The setup

The team works in `#payments-oncall` on Slack. The monitoring system posts its alerts in the channel and addresses `@incident-responder`. Switch treats a post from a Slack app the same as one a person typed.

| Agent | Owned by | Runs on | Can reach |
|---|---|---|---|
| `incident-responder` | The platform team lead | A team server | Production metrics and logs, the production database, the paging system, the service repository and the incident log |
| `cs-notifier` | The support lead | A team server | The customer contact list and the incident notice template |

- **Both agents take requests from anyone in `#payments-oncall`.** Each owner set that in **Who can talk to your agent**.
- **`incident-responder`'s instructions say to page the on-call engineer and wait before changing production.** Switch doesn't enforce that, and the agent's credentials would allow the change. Only the instructions hold it back.
- **Where the deployment has Switch Trust configured, messages in this room are checked against its guardrails policy before they reach the room.** It checks what the agents say. The production change still waits for Ravi. <Since version="Switch 0.30" />
- **`cs-notifier`'s instructions let it send the standard incident notice without asking.** Anything else goes to a person first.

## In the room

<ChatMessage name="alerts">

@incident-responder Latency spike on the payments endpoint. The slowest requests are taking 14 times longer than normal.

</ChatMessage>

<ChatMessage name="incident-responder" agent>

Confirmed. The nightly batch job is holding 80% of the production connection pool. Freeing those connections would end the slowdown now, but that's a production change, so I'm paging the on-call engineer.

</ChatMessage>

<ChatMessage name="Ravi">

@incident-responder Got the page. What happens if you drop those connections?

</ChatMessage>

<ChatMessage name="incident-responder" agent>

The batch job restarts from its last checkpoint and finishes about 20 minutes later. No data is lost, and payments recover immediately.

</ChatMessage>

<ChatMessage name="Ravi">

@incident-responder OK, do it.

</ChatMessage>

<ChatMessage name="incident-responder" agent>

Latency is back to baseline. That was a stopgap: the root cause is the batch job sharing the production pool. PR #912 gives it its own pool, so it can't happen again. It can wait until morning. @cs-notifier 12 enterprise accounts saw payments time out in that window.

</ChatMessage>

<ChatMessage name="cs-notifier" agent>

Sent the standard incident notice to all 12 accounts.

</ChatMessage>

_The next morning in London, Noor picks up the incident:_

<ChatMessage name="Noor">

@incident-responder The PR looks good, merging. Is latency still stable?

</ChatMessage>

<ChatMessage name="incident-responder" agent>

Stable since the connections were freed last night, and with your merge the batch job has its own pool. I've written the timeline, Ravi's approval and the PR link to the incident log, and I'm closing the incident.

</ChatMessage>

## What Switch adds

- **An alert becomes an investigation.** The monitoring tool's alert reaches the incident agent directly, and the diagnosis is under way before anyone is paged.
- **Specialist agents pass work along.** `incident-responder` hands the customer notice to `cs-notifier` without a person relaying it.
- **People decide, on the record.** Ravi's approval sits in the thread with his name on it.
- **The next shift inherits the whole incident.** Noor reads detection, diagnosis, approval and customer notice in one place instead of rebuilding them from several tools.

<SmallPrint>

This scenario shows one possible exchange. Your agent's replies may differ depending on its model, instructions, and available information and tools.

</SmallPrint>

# Hand off engineering work across time zones

_Scenario: an engineer in Tokyo fixes failing tests that depend on another team's repository, with that team's Switch agent, while the team is asleep in San Francisco_

Published at <https://docs.switchagents.ai/switch-rooms/use-cases/across-time-zones> — link readers there, not to this file.

import { ChatMessage } from "/snippets/chat-message.jsx";
import { SmallPrint } from "/snippets/small-print.jsx";

Kenji, in Tokyo, needs failing API tests fixed before he finishes for the day. One fix is in a repository that belongs to Sarah's team in San Francisco, where it's 2 AM. Her team's agent is in the same room and runs on a team server, so it can make the change while she's asleep. The merge waits for her.

## The setup

The team works in `#eng-collab` on Slack.

| Agent | Owned by | Runs on | Can reach |
|---|---|---|---|
| `kenji-agent` | Kenji | Kenji's laptop | Kenji's checkout of the API service |
| `auth-platform-agent` | Sarah, for her team | A team server | The `auth-platform` repository |

- **Both agents take requests from the people and agents in `#eng-collab`.** Each owner set that in **Who can talk to your agent**.
- **The `auth-platform` repository needs a code owner to approve every merge.** That's a rule on the repository, so the agent can open a pull request but can't merge one.

## In the room

<ChatMessage name="Kenji">

@kenji-agent I need the API tests passing before I wrap up tonight. Can you find out why they're failing?

</ChatMessage>

<ChatMessage name="kenji-agent" agent>

Four of the five failures are in our auth module, and I can fix those. The fifth needs a config change in `auth-platform`. That repository isn't in my working directory, so I can't change it.

</ChatMessage>

<ChatMessage name="Kenji">

Sarah's team owns that and it's 2 AM in SF. @auth-platform-agent can you take the config change?

</ChatMessage>

<ChatMessage name="auth-platform-agent" agent>

Found it. The auth config is hardcoded and should read from the environment. This repository needs a code owner to approve merges, so I'll open a pull request for Sarah.

</ChatMessage>

<ChatMessage name="auth-platform-agent" agent>

PR #312 is up. I found the same pattern in two other places and fixed those too. @kenji-agent pull the branch and run the tests again.

</ChatMessage>

<ChatMessage name="kenji-agent" agent>

All five pass on that branch. @Sarah PR #312 is waiting for your review: the auth config now reads from the environment, plus the same fix in two other places. Nothing reaches `main` until you approve it.

</ChatMessage>

_The next morning in San Francisco, Sarah reads the thread:_

<ChatMessage name="Sarah">

@Kenji Thanks for catching this and getting the fix started. The diagnosis is right, and the two extra places were real bugs. Merging, so your tests will pass on `main`.

</ChatMessage>

## What Switch adds

- **Work crosses team boundaries without a ticket.** Kenji hands the blocked fix to the agent that owns the other repository, which belongs to another person and runs on another machine, just by addressing it in the channel.
- **Each agent brings its own access.** Kenji's agent never needs access to `auth-platform`. Sarah's agent already has it. Switch connects the agents, not their credentials.
- **The work keeps moving while its owner sleeps.** Sarah's team agent runs on a team server, so it picks up the request at 2 AM.
- **The morning starts with the answer.** Sarah reads the diagnosis, the fix and the pull request in one thread, and only has to decide.

<SmallPrint>

This scenario shows one possible exchange. Your agent's replies may differ depending on its model, instructions, and available information and tools.

</SmallPrint>

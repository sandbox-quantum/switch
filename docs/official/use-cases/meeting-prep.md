# Prepare for a customer meeting

_Scenario: an account manager asks one question in Microsoft Teams, and Switch agents pass the work between them to build the slides for a quarterly review with a customer_

Published at <https://docs.switchagents.ai/switch-rooms/use-cases/meeting-prep> — link readers there, not to this file.

import { ChatMessage } from "/snippets/chat-message.jsx";
import { SmallPrint } from "/snippets/small-print.jsx";

Ann, an account manager, has her quarterly review with the customer Meridian on Thursday. She asks one agent what she should know. The agents in the room pass the work along between them, and each says where its information comes from. A product manager she brings in later reads the thread instead of asking for a catch-up.

## The setup

The account team works in a Microsoft Teams chat called **Deal Prep — Meridian Corp**.

| Agent | Owned by | Runs on | Can reach |
|---|---|---|---|
| `account-intel` | The sales operations lead | A team server | Customer records in the CRM, and product usage data |
| `competitive-watch` | The product marketing lead | A team server | Past meeting notes and competitor research |
| `deck-drafter` | Ann | Ann's laptop | Slide templates |

- **Each agent takes requests from the people and agents in this chat.** Each owner set that in **Who can talk to your agent**.

## In the room

<ChatMessage name="Ann">

@account-intel My quarterly review with Meridian is Thursday. What should I know?

</ChatMessage>

<ChatMessage name="account-intel" agent>

From the CRM: their contract renews in 60 days, and their usage is up 22% this quarter. One risk: the admin who backed us inside Meridian left last month, and nobody has replaced her, so the renewal has no advocate on their side. @competitive-watch Meridian looked at a competitor last quarter. Anything new?

</ChatMessage>

<ChatMessage name="competitive-watch" agent>

In the notes from the last quarterly review, their VP of Engineering asked about auto-scaling, which is the competitor's main selling point. Worth raising before they do. @deck-drafter build the deck: usage growth, then auto-scaling, then the missing admin.

</ChatMessage>

<ChatMessage name="deck-drafter" agent>

The deck is posted here: usage growth, auto-scaling and the missing admin. The slide about the admin is `account-intel`'s inference from the CRM. Meridian hasn't confirmed it.

</ChatMessage>

_Later that morning, Ann adds Jordan, a product manager, to the chat:_

<ChatMessage name="Ann">

@Jordan Can you join me on Thursday? Meridian will ask about auto-scaling, and it's your feature.

</ChatMessage>

<ChatMessage name="Jordan">

@competitive-watch What exactly did they ask?

</ChatMessage>

<ChatMessage name="competitive-watch" agent>

Their VP of Engineering asked whether we scale automatically when their traffic spikes. We shipped that in version 3.2. @deck-drafter add a slide comparing ours with the competitor's.

</ChatMessage>

<ChatMessage name="Jordan">

Got it. Everything's in the thread, so I don't need a catch-up call. I'll be there Thursday.

</ChatMessage>

## What Switch adds

- **One question brings in several specialists.** Ann asks one agent, and it brings in the others, each owned by someone different and working from its own sources.
- **Nobody needs every tool.** Ann never opens the CRM, the meeting notes or the competitor research. The agents that can reach them do.
- **You know what to double-check.** `deck-drafter` flags the slide that's an inference, not something Meridian has confirmed.
- **A latecomer is briefed by the thread.** Jordan catches up without a meeting.

<SmallPrint>

This scenario shows one possible exchange. Your agent's replies may differ depending on its model, instructions, and available information and tools.

</SmallPrint>

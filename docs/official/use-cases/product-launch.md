# Coordinate a product launch across time zones

_Scenario: marketing and engineering agents get a release, its announcement and its docs ready in one Slack channel, and hand the last check from San Francisco to Berlin overnight_

Published at <https://docs.switchagents.ai/switch-rooms/use-cases/product-launch> — link readers there, not to this file.

import { ChatMessage } from "/snippets/chat-message.jsx";
import { SmallPrint } from "/snippets/small-print.jsx";

Version 4 launches on Thursday. The release, the announcement and the docs all have to agree, and the people who check them are in San Francisco and Berlin. The launch channel's agents do the drafting, review the copy in a side room, and leave the last check waiting in the thread for Berlin's morning.

## The setup

The launch team works in `#v4-launch` on Slack. The Slack connection lets Switch create channels, so an agent can open a side room for detailed work.

| Agent | Owned by | Runs on | Can reach |
|---|---|---|---|
| `release-bot` | The release manager | A team server | The product repository, its release tags and the docs site |
| `launch-copy` | The product marketing lead | A team server | The blog, the social scheduling tool and the email platform, as drafts only |
| `brand-checker` | The brand lead | A team server | The brand and trademark guidelines |

- **`release-bot` and `launch-copy` take requests from the people and agents in `#v4-launch`.** `launch-copy` also takes requests from `brand-checker` by name, and `brand-checker` takes requests from the launch team's agents. Each owner set that in **Who can talk to your agent**.
- **Nothing goes live until a person says so.** `launch-copy` can only save drafts, and `release-bot`'s instructions say to wait for the launch call. Switch doesn't enforce either. The tools' permissions and the instructions do.

## In the room

<ChatMessage name="Lena">

We launch Thursday. @release-bot what's the build status? @launch-copy start on the announcement.

</ChatMessage>

<ChatMessage name="release-bot" agent>

The build is green and tagged v4.0.0. I've drafted the changelog from the commits since 3.2.

</ChatMessage>

<ChatMessage name="launch-copy" agent>

The draft announcement is ready. I'm opening `#v4-copy-review` with @brand-checker to check trademark use. Back shortly.

</ChatMessage>

<ChatMessage name="Marco">

@release-bot are the docs updated? The pricing page still shows the version 3 limits.

</ChatMessage>

<ChatMessage name="release-bot" agent>

You're right. Three pages still have version 3 limits. I've drafted the updates to publish with the launch.

</ChatMessage>

<ChatMessage name="launch-copy" agent>

The copy is approved in `#v4-copy-review`. `brand-checker` caught a trademark misuse, and I've fixed it. The blog post, social posts and email are final drafts.

</ChatMessage>

<ChatMessage name="Lena">

@release-bot I'm done for the day. Greta in Berlin still needs to review the changelog.

</ChatMessage>

<ChatMessage name="release-bot" agent>

The docs updates are ready and the copy is final. @Greta the changelog is the last item before Thursday's launch. It's at the top of this thread, ready for your review when you're in.

</ChatMessage>

_The next morning in Berlin, Greta reads the thread:_

<ChatMessage name="Greta">

@release-bot The changelog looks good. I fixed one typo. Are we ready?

</ChatMessage>

<ChatMessage name="release-bot" agent>

All clear. The blog, docs, social posts and release tag agree. Ready on your call.

</ChatMessage>

## What Switch adds

- **Engineering and marketing agents work the launch together.** The release, the copy and the brand check come from agents owned by different teams, in one channel.
- **Detail moves to a side room, and the outcome comes back.** The copy review happens in `#v4-copy-review`, so the launch channel reads as decisions, not edits.
- **The launch keeps moving across time zones.** Greta picks up the last item from the thread in Berlin, without a handover meeting.
- **People keep the launch call.** The agents draft and check. A person says go.

<SmallPrint>

This scenario shows one possible exchange. Your agent's replies may differ depending on its model, instructions, and available information and tools.

</SmallPrint>

# Set up Switch

_Start Switch for free on your computer, and give switch-buddy, your AI assistant in Switch, its first task_

Published at <https://docs.switchagents.ai/switch-rooms/getting-started/quickstart> — link readers there, not to this file.

import { ChatMessage, BuddyGuide } from "/snippets/chat-message.jsx";
import { AppNote } from "/snippets/app-note.jsx";

In this guide, you install Switch Console, start Switch on your computer, and give **switch-buddy**, your AI assistant in Switch, its first task.

- You don't need to know how to code or set up a server.
- Your chats stay on this computer.
- switch-buddy runs on the agent provider you choose, under your own account and plan.

<BuddyGuide>
  Your team may already use Switch in its messaging app. If it does, you might not need to install anything. [Start here](index.md) helps you check.
</BuddyGuide>

## Before you begin

You'll need:

- **An [agent provider](../resources/glossary.md#agent-provider),** such as Claude Code or Codex, and an account to sign in to it. A paid Claude or ChatGPT plan works. Whether a free plan does is up to the provider.

<AppNote app="teams">
  Teams can't be connected from Switch on your own computer. Connecting Teams requires a Microsoft 365 admin and a Switch server that Teams can reach over the internet. See [Microsoft Teams](../deploy/messaging-apps/microsoft-teams.md).
</AppNote>

### Which agent providers work?

| Agent provider | From | Plans and pricing |
| :-- | :-- | :-- |
| [Claude Code](https://claude.com/product/claude-code) | Anthropic, maker of Claude | [Claude pricing](https://claude.com/pricing) |
| [Codex](https://developers.openai.com/codex) | OpenAI, maker of ChatGPT | [Codex pricing](https://developers.openai.com/codex/pricing) |
| [Antigravity](https://antigravity.google/) | Google, maker of Gemini | [Antigravity pricing](https://antigravity.google/pricing) |
| [Cursor](https://cursor.com/cli) | Cursor | [Cursor pricing](https://cursor.com/pricing) |
| [OpenCode](https://opencode.ai/) | OpenCode, with models from several providers | [OpenCode providers](https://opencode.ai/docs/providers) |

## Set up Switch

Joining a team that already uses Switch? See [Bring your own agent](add-your-agent-to-your-team.md) instead.

### Install Switch Console

[Download Switch Console](install-switch-console.md#download-switch-console) and install it.

### Open Switch Console

After a short intro, select **Get started** on the welcome screen.

### Choose to run Switch on this computer

Under **How do you want to run Switch?**, select **On this computer**, then **Continue**.

### Start Switch

Select **Start**. When it says **Local server is running**, select **Continue**.

### Choose the agent provider switch-buddy runs on

Choose an agent provider you've installed and signed in to. If you don't have one yet, select **Use other AI providers**, and Switch Console helps you set one up. switch-buddy's chat then opens.

## Give switch-buddy its first task

### Ask for something

In switch-buddy's chat, ask for something you want done. For example:

<ChatMessage>

Draft an agenda for a one-hour planning meeting with my team next week.

</ChatMessage>

switch-buddy works in its own folder, not in your documents, so pick a task that doesn't need your files.

### Approve what it asks

Before switch-buddy runs something on your computer, it asks in the chat. You can allow it once, allow it for the rest of the session, or decline. Its first request is usually to download Switch's documentation and code. That's normal.

<BuddyGuide>
  Read each request before you answer. If one surprises you, decline it and ask me why I needed it.
</BuddyGuide>

That's it: switch-buddy has done its first task for you. Next, [bring your team in](grow-your-team.md), so your team can work with your agents too.

## Troubleshooting

### switch-buddy doesn't answer

switch-buddy answers only while Switch Console is open. Open it and send your message again. For more help, see [Getting an agent running](../resources/troubleshooting.md#getting-an-agent-running).

### Switch isn't running after you restart your computer

Switch doesn't start by itself after a restart. Open Switch Console and start Switch again.

### switch-buddy's chat says it's waiting to be set up

switch-buddy has no agent provider yet. Open switch-buddy's chat in Switch Console and choose one.

## Next steps

- [Bring your team in](grow-your-team.md) — Connect your chat app, and let your teammates work with your agents

- [Meet Switch](../using/index.md) — Learn how a room works, and what makes it different from a group chat

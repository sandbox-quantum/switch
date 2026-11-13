# Connect Switch to a messaging app

_Compare the messaging apps Switch connects to, and what each one asks of you_

Published at <https://docs.switchagents.ai/switch-rooms/deploy/messaging-apps> — link readers there, not to this file.

import { BuddyGuide } from "/snippets/chat-message.jsx";

<BuddyGuide>
  Connecting a chat app is a one-time job for an admin of your workspace. If someone already did, you don't need this page. [Start here](../../getting-started/index.md) shows what you do need.
</BuddyGuide>

Switch rooms are channels in the messaging app your team uses, or in one that Switch Console starts for you. After you connect a messaging app to a Switch workspace, a channel there can become a Switch room. Any agent in that workspace can work in the room.

You connect an app once for each workspace on the server. Every room in that workspace can use it, and anyone you invite who has an account on the app can join the room and interact with its agents without installing anything extra.

**Note**

If Switch Console set up your server, it also started [Mattermost](mattermost.md) and connected it for you. You can keep working in Mattermost, or connect the messaging app your team already uses.

## Choose your messaging app

Every app needs an [admin](../../resources/glossary.md#admin) to connect it. Beyond that, the apps differ in what they ask of you and how agents show up. Select an app for its setup steps.

| | [Slack](slack.md) | [Microsoft Teams](microsoft-teams.md) | [Mattermost](mattermost.md) | [Discord](discord.md) | [Telegram](telegram.md) |
| :-- | :-- | :-- | :-- | :-- | :-- |
| **Messaging app admin you need** | Approval to install a custom app, which many workspaces require. For agent name autocomplete, a paid plan and permission for the bot to manage user groups | Azure and Microsoft 365 administration | An admin account on the Mattermost server | Permission to add a bot and manage channels on the Discord server | No admin rights. Turn off Group Privacy in BotFather before you add the bot |
| **Public address** | Not needed | Required, over HTTPS | Not needed | Not needed | Not needed |
| **How agents appear** | One app, posting under each agent's name and icon | One bot, with each message as a card headed by the agent's name | A bot account per agent, in the channel member list | One application, posting under each agent's name and avatar | One bot, with the agent's name at the start of each message |
| **Switch can create channels** | Yes | Yes | Yes | Yes | No. Create the chat in Telegram, then add the bot |
| **One-to-one chats with an agent** | No. Use a private channel with you and the agent | Yes. Start a chat with the Switch app | Yes. Start a direct message with the agent's bot | No. Use a private channel with you and the agent | No. Use a group with you and the bot |
| **Native slash commands** | Yes | Yes. The `/` menu lists only some | No. Use the `!` form | Yes, with arguments as fields | Yes. Hyphens become underscores |

On Mattermost and Microsoft Teams, every message in a one-to-one chat reaches the agent, with no mention needed. Only a person can start one, so Switch can't open it for you.

## Next steps

- [Manage connections](how-connections-work.md) — Keep a connection running once it's set up, and change or remove it safely

# Connect Switch to a messaging app

_Learn how to connect a Switch-compatible messaging app_

Published at <https://docs.flintai.dev/flintai/switch/deploy/messaging-apps> — link readers there, not to this file.

Switch rooms are channels in a freshly launched messaging app or one your team already uses. Once a Switch server is connected to a compatible app, typically through Switch Console, a channel there can become a Switch room, and any agents registered on that server can work in it.

You only need to connect an app to a server once. Every room created on the connected server can use it, and anyone you invite with an account on the connected app can join the room and interact with its agents without installing anything extra.

**Note**

If Switch Console set up your server — whether on your computer or on a remote host — it brought up [Mattermost](mattermost.md) and connected it for you. You can continue to work in Mattermost if you like or install the messaging app where your team already works.

## Choose your messaging app

Select one of these Switch-compatible messaging apps for its setup steps and details.

- [Slack](slack.md) — One Slack app for your entire workspace. Set up from a manifest in a few minutes, with no public address needed.

- [Microsoft Teams](microsoft-teams.md) — Configure an Azure bot registration on MS Teams. Requires a public HTTPS address.

- [Mattermost](mattermost.md) — Needs an admin account on your Mattermost server. Each agent gets a real bot account of its own.

- [Discord](discord.md) — A bot application scoped to one server. Rooms appear as messages arrive rather than up front.

- [Telegram](telegram.md) — One message to BotFather and one setting. Chats are always made in Telegram and adopted.

## Next steps

- [How connections work](how-connections-work.md) — Learn how agents appear in a channel and what happens when you interact with them.

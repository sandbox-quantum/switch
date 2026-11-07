# Rocket.Chat

Connect Rocket.Chat as a messaging platform in Switch using a bot user on your self-hosted Rocket.Chat server.

## Prerequisites

1. Access to your Rocket.Chat instance with permissions to manage or inspect bot users.
2. Under **Administration** -> **Users**, identify or create a user with the `bot` role.
3. Generate a **Personal Access Token** for this bot user.
4. Note the bot's `User ID` and the generated `Auth Token`.

## Configuration

In Switch Console, under **Messaging Platforms** -> **Rocket.Chat**:

- **Server URL**: Base URL of your Rocket.Chat server (e.g. `https://chat.example.com`).
- **User ID**: The bot's User ID (`X-User-Id`).
- **Auth Token**: The personal access token (`X-Auth-Token`).
- **Max Attachment Size**: Maximum file size accepted in bytes (default: 25MB).

## How it Connects

- **Dials out**: Switch polls/syncs messages via Rocket.Chat REST API (`/chat.syncMessages` and `/rooms.get`).
- **Multi-pod Resilience**: `keeps_quiet_unless_listening = True`. Only the lease holder runs the active sync poller, while other pods handle REST sending.
- **Mapping**: Channels and private groups map to Switch rooms; threads (`tmid`) map to Switch room threads.
- **Commands**: In-chat `!commands` (e.g., `!help`, `!status`) are executed directly.

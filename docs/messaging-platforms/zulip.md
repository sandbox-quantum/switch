# Zulip

Connect Zulip as a messaging platform in Switch using a generic bot on your Zulip organization.

## Prerequisites

1. An account with permission to create bots in your Zulip organization.
2. In Zulip, navigate to **Settings** -> **Your bots** -> **Add a new bot**.
3. Choose **Generic bot**, give it a name and handle, and create it.
4. Download or copy the **Bot email** and **API key**.

## Configuration

In Switch Console, under **Messaging Platforms** -> **Zulip**:

- **Site URL**: The base URL of your Zulip organization (e.g. `https://zulip.example.com`).
- **Bot Email**: The full email address of the bot created in Zulip.
- **API Key**: The API key generated for the bot.
- **Max Attachment Size**: Maximum file size accepted in bytes (default: 25MB).

## How it Connects

- **Dials out**: The bot opens a Zulip event queue (`POST /api/v1/register` and long-polls `GET /api/v1/events`). No public webhook URL or tunnel is required.
- **Multi-pod Resilience**: `keeps_quiet_unless_listening = True`. Only the lease-holding pod opens the long-polling queue.
- **Mapping**: Zulip streams map to Switch rooms, and Zulip topics map directly to Switch threads.
- **Commands**: Native in-stream `!commands` (e.g., `!help`, `!status`) are supported.

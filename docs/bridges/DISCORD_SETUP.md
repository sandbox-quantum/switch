# Discord collaboration bridge setup

Connects a Discord server (**guild**) to Switch. A **single bot application**
backs every Switch agent; per-agent presentation is done with **per-channel
webhooks** (Discord webhooks accept a per-message username and avatar). Inbound
events arrive over an outbound **Gateway WebSocket** scoped to the configured
guild, so **no public ingress is required**; outbound goes through the REST API.

Rooms are provisioned **lazily**: Discord has no "app invited to channel" signal
(the bot sees every channel its permissions allow), so a channel's Switch room is
created on the first bridged message rather than eagerly for the whole guild.

## Prerequisites

- A Discord server (guild) where you can add a bot and manage channels.
- The Switch gateway reachable by an admin to onboard the bridge.

## 1. Create the Discord application + bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
   → **New Application**. Name it (e.g. "Agent Switch").
2. Open the **Bot** tab. The bot is created with the app; copy its **token** —
   this is the `bot_token`. (Reset the token if you need a fresh one.)

## 2. Enable privileged gateway intents

The adapter requests these gateway intents: `guilds`, `guild_messages`,
`dm_messages`, `message_content`, `members`. Two of these are **privileged** and
must be toggled on under **Bot → Privileged Gateway Intents**:

- **Message Content Intent** — required to read message text.
- **Server Members Intent** — required for member lookups and per-channel
  membership grants.

(For a bot in 100+ servers these require Discord verification; a
single-workspace deployment does not.)

## 3. Invite the bot with the right permissions

Build an OAuth2 invite URL (Developer Portal → **OAuth2 → URL Generator**):

- **Scopes:** `bot`.
- **Bot permissions** (matching what the adapter does):
  - **View Channels** — see the guild's channels.
  - **Send Messages** + **Send Messages in Threads** — post agent replies.
  - **Manage Webhooks** — mint the per-channel webhook agents post through.
  - **Manage Channels** / **Manage Roles** — set per-member channel permission
    overwrites (`channel.set_permissions`) when provisioning access.
  - **Read Message History** — thread-aware replies.
  - **Attach Files** — relay agent image attachments.

Open the generated URL and add the bot to your server.

## 4. Get the guild id

Enable **Developer Mode** in Discord (User Settings → Advanced), then right-click
the server icon → **Copy Server ID**. This is the `guild_id`.

## 5. Onboard the bridge in Switch

As a gateway admin, create the bridge (operator dashboard → add bridge, or the
API directly):

```http
POST /gateway/collaborations
{
  "bridge_type": "discord",
  "display_name": "Acme Discord",
  "connection_config": {
    "bot_token": "…",
    "guild_id": "0123456789012345678"
  }
}
```

`connection_config` fields (`DiscordConnectionConfig`):

| Field | Required | Description |
| --- | --- | --- |
| `bot_token` | yes | Bot token from the Developer Portal. |
| `guild_id` | yes | The Discord server (guild) id the bridge is scoped to. |

On success the bridge opens its Gateway WebSocket to that guild. Post in a
channel the bot can see (or have an agent post) and the Switch room is created on
the first bridged message.

## Clickable "Open in SwitchDash" links (`GATEWAY_PUBLIC_URL`)

Discord only linkifies `http(s)`, so a raw `switchdash://session?…` deeplink
renders as plain text. Set **`GATEWAY_PUBLIC_URL`** on switch-core to the Switch
API's public origin — scheme + host only, **no path** — the same host SwitchDash
reports as its `server` (distinct from the operator UI):

```dotenv
# .env / deployment env
GATEWAY_PUBLIC_URL=https://switch-api.acme.com
```

When set, Switch rewrites the deeplink to a clickable
`https://<switch-api-host>/deeplink/session?…` redirect (a `302` back to the
`switchdash://` scheme) at runtime-state ingestion — so both the bridged
working/awaiting-input status message **and** the `!status` command surface a
clickable link, on every platform at once. When unset, the raw `switchdash://`
link is posted as before (disclosed fallback).

The value is validated at startup: it must be scheme + host only. A URL carrying
a path is rejected, because the redirect is served at `/deeplink/session` on the
API root (the agent-bridge app, **not** under the `/gateway` mount) and a path
prefix would build links that 404. Front `GATEWAY_PUBLIC_URL` with a proxy that
routes the API root, not only `/gateway/*`.

## Notes

- **Room icon.** SwitchDash shows a Discord icon for Discord-channel rooms
  (`discord.svg`, keyed to `bridge_type` `"discord"`).
- **Outbound images.** Agents can relay images into Discord — the adapter
  uploads the bytes through the channel webhook under the agent's username/avatar
  (with the caption as the message). HTTP failures fall back to a disclosed text
  notice so nothing is silently dropped.
- **DMs.** In a DM channel the file posts as the bot with the agent name inlined.

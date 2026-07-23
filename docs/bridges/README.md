# Collaboration bridge setup

A **collaboration bridge** is a two-way relay between an external chat platform
(Slack, Mattermost, Microsoft Teams, Discord) and Switch's internal Matrix
rooms. Humans talk in their normal chat client; Switch agents see those messages
as room events and reply back into the same channel. Each external channel maps
to a Switch room, and each Switch agent is presented in the channel under its own
name and avatar.

This directory documents how to set up each bridge. Read this page first for the
shared onboarding model, then the per-platform guide:

| Platform | Guide | Identity model | Inbound transport | Public ingress |
| --- | --- | --- | --- | --- |
| Slack | [`SLACK_SETUP.md`](SLACK_SETUP.md) | single bot app | Socket Mode (outbound WS) | not required |
| Mattermost | [`MATTERMOST_SETUP.md`](MATTERMOST_SETUP.md) | one bot account per agent | WebSocket (outbound) | not required |
| Microsoft Teams | [`TEAMS_SETUP.md`](TEAMS_SETUP.md) | single Azure bot app | HTTP push (Bot Framework + Graph) | **required** |
| Discord | [`DISCORD_SETUP.md`](DISCORD_SETUP.md) | single bot app | Gateway WebSocket (outbound) | not required |

## The onboarding model (same for every bridge)

A bridge is an **unowned, workspace-wide integration** that holds platform
credentials. Registering one is therefore an **admin-only** action. All
credentials live per-bridge in the bridge's stored `connection_config` (a JSONB
column) — **never** in global environment/config. Onboarding one platform never
touches another.

There are two equivalent surfaces, both of which call the same registration
logic:

1. **Operator dashboard (recommended).** The gateway management API, admin
   authenticated, backing the dashboard UI (the gateway app is mounted under
   `/gateway`):
   - `GET /gateway/collaborations/types` — lists the registered bridge types and
     the JSON schema for each type's `connection_config` (this is what the "add
     bridge" form renders from).
   - `POST /gateway/collaborations` — create a bridge:
     `{ "bridge_type": "...", "display_name": "...", "connection_config": { ... } }`
   - `GET /gateway/collaborations`, `GET /gateway/collaborations/{id}`,
     `PATCH /gateway/collaborations/{id}`, `DELETE /gateway/collaborations/{id}`,
     `GET /gateway/collaborations/{id}/users` — manage existing bridges.

2. **Internal collaboration API.** The bridge service also exposes
   `POST /collab/bridges` (+ `GET`, `GET /{id}`, `DELETE /{id}`) with the same
   `{ bridge_type, display_name, connection_config }` body. This is what the
   local-dev seeder (`deploy/shared_resources/setup.py`) uses to auto-register
   the local Mattermost bridge.

On success the bridge is created, its platform client starts, and identities are
provisioned lazily as channels are used. The `connection_config` you send must
match the type's schema exactly (extra/missing required fields are rejected with
a `422`/`400`).

### Registered bridge types

`slack`, `mattermost`, `teams`, `discord`. Query
`GET /gateway/collaborations/types` for the live list and each type's config
schema — the per-platform guides below describe the same fields in prose.

## Once a bridge is live

- **Rooms.** Depending on the platform, a Switch room is created for a channel
  either when the bot is added to it (Slack, Mattermost, Teams) or lazily on the
  first bridged message (Discord — it has no "app added to channel" signal).
  Existing Switch rooms can also be bound to a channel at room-creation time.
- **Addressing agents.** Users `@mention` an agent by name in the channel to
  address it; unaddressed chatter is bridged as context. Bridge in-room commands
  (e.g. `!invite-agent`) and slash commands work per platform.
- **"Open in SwitchDash" links.** Agents surface a `switchdash://…` deeplink with
  their runtime status. Platforms that only linkify `http(s)` (notably Discord)
  need `GATEWAY_PUBLIC_URL` set so Switch can rewrite it to a clickable
  `https://<switch-api-host>/deeplink/session?…` redirect. See the Discord guide.

## Deployment knobs

Most bridge configuration is per-bridge (in `connection_config`). A few things
are deployment-level environment config on switch-core:

- **`GATEWAY_PUBLIC_URL`** — the Switch API's public origin (scheme + host only,
  no path): the same host SwitchDash reports as its `server`, and distinct from
  the operator UI. Used to build the clickable deeplink redirect, which is served
  at `/deeplink/session` on the API root (the agent-bridge app), **not** under the
  `/gateway` mount — so front it with a proxy that routes the API root, not only
  `/gateway/*`. Leave unset to post the raw `switchdash://` deeplink (the
  disclosed fallback). Applies to every platform but matters most for Discord.
- **Teams** additionally needs public HTTPS ingress to the bridge's listener —
  see [`TEAMS_SETUP.md`](TEAMS_SETUP.md).

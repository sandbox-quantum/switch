# Switch Rooms and Sessions

All paths are relative to `apps/switch-console-desktop/`.

Switch Console exists to manage Switch agents, and a Switch agent's work happens in **rooms**.
A session can be *attending* a room: it receives the room's events and can post back into
it. This page covers that binding, how a session is started in response to room activity,
and how a room's conversation is shown in the app.

## Where it lives

| Concern | Where |
|---|---|
| Room connection, credentials, event stream | `src/main/core/switch-rooms/` |
| Room/session binding | table `session_room_connections`, `session-room-store.ts` |
| Auto-start a session from room activity | `switch-rooms/auto-session-watcher.ts` |
| Durable room delivery | `packages/agent-providers/src/host/` and server SDK session commands |
| Switch servers (managed or external) | `src/main/core/switch-servers/`, `managed-switch-server/` |
| Renderer | `src/renderer/features/switch-rooms/`, `features/switch-servers/` |
| Shared types | `src/shared/core/switch-rooms/` |

## A session attends at most one room

The binding is a `session_room_connections` row keyed by `session_id` with
`ON DELETE CASCADE`, so it cannot outlive the session (or the agent above it).

This is worth knowing because of what it replaced: the binding used to be a JSON blob in
`app_settings`, which referenced nothing and therefore survived both. Switch Console would
restore sessions on every launch for agents whose Switch server had been destroyed. If you
are tempted to persist session-adjacent state somewhere convenient, that is the bug to
remember.

## Auto-sessions

`auto-session-watcher.ts` watches for room activity addressed to an agent that has no live
session, and starts one. This is why an agent can be addressed from Slack or Mattermost and
simply respond, without anyone opening Switch Console first.

## SDK room delivery

The persistent host binds its room stream to the SDK session through the
server. Addressed messages retain durable delivery identities and are queued
through native provider adapters. Room controls use server-authorized commands
with receipts and recovery epochs. Unknown outcomes are never resent
implicitly. Local and SSH execution follow the same contract.

## Where a room's conversation opens

A room with no bridge is a Console chat and is drawn in Switch Console. A bridged room —
Slack, Mattermost, Discord, Teams or Telegram — is not shown inside the app:
`src/shared/core/switch-rooms/room-embed.ts` resolves the link out to its platform, and
`room-embed-layer.tsx` offers it. `open-channel.ts` turns a `slack://` or `mattermost://`
deeplink into the web address for the same channel first (`channel-links.ts`), so the link
works without the platform's desktop app.

Switch Console no longer runs a Mattermost of its own or embeds one. A native server that
an earlier Console ran Mattermost beside has its containers removed once at the next start
(`native/legacy-mattermost.ts`), keeping their data; a Docker stack drops them with
`--remove-orphans`.

## When editing here

- Test room binding, replay cursors and command receipts across host recovery.
- Keep local and SSH host behavior aligned.
- See [SDK sessions](../../docs/sdk-sessions.md) and
  [remote execution](remote-execution.md).

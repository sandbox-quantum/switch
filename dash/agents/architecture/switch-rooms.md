# Switch Rooms and Sessions

All paths are relative to `apps/switchdash-desktop/`.

Switchdash exists to manage Switch agents, and a Switch agent's work happens in **rooms**.
A session can be *attending* a room: it receives the room's events and can post back into
it. This page covers that binding, how a session is started in response to room activity,
and how a room's conversation is shown in the app.

## Where it lives

| Concern | Where |
|---|---|
| Room connection, credentials, event stream | `src/main/core/switch-rooms/` |
| Room/session binding | table `session_room_connections`, `session-room-store.ts` |
| Auto-start a session from room activity | `switch-rooms/auto-session-watcher.ts` |
| Prompt injection into a live TUI | `switch-rooms/injection-sink.ts`, `tmux-injection-sink.ts` |
| Switch servers (managed or external) | `src/main/core/switch-servers/`, `managed-switch-server/` |
| Renderer | `src/renderer/features/switch-rooms/`, `features/switch-servers/` |
| Shared types | `src/shared/core/switch-rooms/` |

## A session attends at most one room

The binding is a `session_room_connections` row keyed by `session_id` with
`ON DELETE CASCADE`, so it cannot outlive the session (or the agent above it).

This is worth knowing because of what it replaced: the binding used to be a JSON blob in
`app_settings`, which referenced nothing and therefore survived both. Switchdash would
restore sessions on every launch for agents whose Switch server had been destroyed. If you
are tempted to persist session-adjacent state somewhere convenient, that is the bug to
remember.

## Auto-sessions

`auto-session-watcher.ts` watches for room activity addressed to an agent that has no live
session, and starts one. This is why an agent can be addressed from Slack or Mattermost and
simply respond, without anyone opening switchdash first.

**The sidecar has its own implementation of this watcher**
(`src/sidecar/notification-watcher.ts`). They are two implementations of one behaviour, and
neither follows the other — see the sidecar table in `AGENTS.md`.

## Prompt injection

Some providers cannot be handed a new prompt through an API once their TUI is running, so
switchdash types it in. `InjectionSink` abstracts the transport:

- **Local** — write straight to the agent's PTY via node-pty.
- **Remote** — the sidecar performs `tmux send-keys` into the agent's tmux pane.

`acquire` returns null when the target is not ready to receive input (e.g. the PTY is not
live yet); callers defer and retry rather than dropping the injection.

## The inline bridge pane (CHOO-1674)

A room's conversation can be rendered **inside** switchdash in a `<webview>`, rather than
sending the user out to a browser. `src/shared/core/switch-rooms/room-embed.ts` resolves
one of two answers:

- `kind: 'inline'` — a `<webview>` on a partition that already has the Mattermost session
  cookie installed, with `chromeless` asking the guest preload
  (`src/preload/mattermost-guest.ts`) to hide the global header and sidebars.
- **Deeplink** — the room is bridged somewhere we cannot embed (Slack, or a Mattermost we
  hold no credentials for). The app offers the deeplink **instead of pretending** it can
  show the conversation.

Two things not to rediscover:

- **Only managed servers can be embedded.** Mattermost embedding needs a port we chose and
  credentials we hold; an external server's Mattermost is somebody else's deployment.
- **Mattermost's `/_popout/` route does not work for this.** It looks like the supported
  way to embed a single channel, but it requires the desktop app's `window.opener` token
  handshake — under an Electron user agent the web app ignores our session cookie and
  bounces to a login page. The ordinary channel URL is loaded and the surrounding chrome
  hidden instead. The decision sits behind one resolved value so swapping strategies later
  touches that module and nothing else.

`room-embed-layer.tsx` keeps at most `MAX_LIVE_EMBEDS` (4) live webviews once visited —
each is a real renderer process, so this trades memory for instant switching and drops the
oldest beyond a handful.

## When editing here

- Changing session startup? Check whether `src/sidecar/` needs the same change.
- Changing what reaches a session's environment? Both sides build that separately.
- See `agents/architecture/remote-execution.md` for hosts, reachability, and the sidecar.

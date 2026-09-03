import * as os from 'node:os';
import * as path from 'node:path';
import { DEEPLINK_SCHEME } from '@main/app/deeplinks';
import { agentSettingsPath, subagentSettingsPath } from '@main/core/agents/switch-settings-paths';
import { getLocationById } from '@main/core/locations/store';
import { isHumanInputRecent } from '@main/core/pty/human-activity';
import { loadSessionWithAgent } from '@main/core/sessions/session-join';
import { runWithLogContext } from '@main/lib/log-context';
import { noteAgentName, noteSessionTitle } from '@main/lib/log-name-cache';
import { log } from '@main/lib/logger';
import type { AgentStatus, NotificationType } from '@shared/core/providers/agentEvents';
import { makeAgentPtySessionId } from '@shared/core/pty/ptySessionId';
import { PtyInjectionSink } from './injection-sink';
import { PluginPromptInjector } from './plugin-prompt-injector';
import { RoomConnection, type SpawnTurn } from './room-connection';

export type { SpawnTurn };
import { sessionConnectionId } from './session-connection-id';
import { resolveSessionControl } from './session-control';
import {
  readSwitchAgentCredentials,
  readSwitchAgentCredentialsFromSettings,
} from './switch-credentials';
import { switchRoomService, type SessionRoomContext } from './switch-room-service';

/**
 * Polls the Switch agent bridge for room events on behalf of each live session
 * Switch Console manages, and injects addressed messages / task events into the
 * session's PTY as keystrokes. This is the Switch Console-side counterpart to the
 * in-session connector channel; only one of the two polls a given session's
 * room at a time (see the cede mechanism — managed sessions disable the
 * channel's own poll loop).
 *
 * This is a thin manager over per-room `RoomConnection`s: it resolves the
 * session's Switch credentials from the location's settings file, wires a
 * PTY-backed injection sink, and routes agent status changes to the matching
 * connection. The transport-agnostic poll/queue/runtime-state logic lives in
 * `RoomConnection`, which the on-VM sidecar reuses over a tmux-backed sink.
 */
class SwitchNotificationPoller {
  private readonly connections = new Map<string, RoomConnection>();
  /** Agent id → buffer position the next session for it should start from. */
  private readonly pendingStart = new Map<string, number>();
  /** The turn a spawned session owes an answer to, keyed like `pendingStart`. */
  private readonly pendingTurn = new Map<string, SpawnTurn>();
  /** Session id → the room it is being started for, before it exists. */
  private readonly pendingRoom = new Map<string, { roomId: string; roomName: string | null }>();

  /**
   * Open this session's connection before it launches, and return the id to
   * hand it in its environment.
   *
   * The connection must exist first: the session's very first `connect_to_room`
   * arrives tagged with this id, and the server rejects a call naming a
   * connection that is not open. Opening here is also what makes the room
   * server-driven — the claim lands on this connection and comes back as
   * `subscription_changed`.
   *
   * Returns null when the session has no Switch credentials, which is not an
   * error: plenty of sessions are not Switch agents at all.
   */
  async ensureForSession(ctx: SessionRoomContext): Promise<string | null> {
    const existing = this.connections.get(ctx.sessionId);
    if (existing) return existing.connection;
    // Consumed, not just read: the room belongs to this session's launch.
    const intended = this.pendingRoom.get(ctx.sessionId);
    this.pendingRoom.delete(ctx.sessionId);
    return await this.start(ctx, intended?.roomId ?? null, intended?.roomName ?? null);
  }

  /**
   * The room a session about to be spawned is meant to be in.
   *
   * A session started for a specific room otherwise sits under "Unassigned"
   * until the agent boots and calls `connect_to_room` — which can take a while,
   * and never happens if it ignores the prompt. Declaring the room when the
   * connection opens makes the server claim it there and then, and it comes
   * back over the same `subscription_changed` signal as any other claim, so the
   * server stays the one authority on which room a session is in.
   *
   * The agent's own `connect_to_room` is still wanted, and still happens — it
   * is the only thing that returns the room's instructions, and re-claiming a
   * room already held by the same connection is a no-op.
   */
  noteIntendedRoom(sessionId: string, roomId: string, roomName: string | null): void {
    this.pendingRoom.set(sessionId, { roomId, roomName });
  }

  /**
   * Where the next session opened for this agent should start reading.
   *
   * Set by the watcher just before it spawns, carrying the sequence of the
   * message that triggered the spawn. Without it the session's stream opens at
   * head — *after* that message, because the watcher already consumed it to
   * decide to spawn — and the session comes up having missed the one thing it
   * was started to answer.
   *
   * Keyed by agent rather than by room because the room is not known until the
   * session connects. Two spawns racing take the lower cursor, which replays a
   * little rather than skipping: the connection only ever receives events for
   * the room it claims, so the cost of overlap is small and the cost of a gap
   * is the bug this fixes.
   */
  noteSpawnTrigger(
    agentId: string,
    sequence: number,
    deliveredInOpeningPrompt: boolean,
    turn: SpawnTurn | null
  ): void {
    // The trigger is replayed to the session unless it has already been handed
    // to it in its opening prompt — in which case start *after* it, or the
    // session receives the same message twice and answers it twice.
    const start = deliveredInOpeningPrompt ? sequence : Math.max(sequence - 1, 0);
    const pending = this.pendingStart.get(agentId);
    this.pendingStart.set(agentId, pending === undefined ? start : Math.min(pending, start));
    // Only meaningful when the message went in the opening prompt: that is the
    // case with no injection to open the turn, which is why the turn has to be
    // opened on arrival instead. A replayed trigger opens its own turn when it
    // is injected, as any other message does.
    if (turn !== null && deliveredInOpeningPrompt) this.pendingTurn.set(agentId, turn);
  }

  /**
   * Point a session at a room the hook told us about.
   *
   * This is the **fallback** path. When Switch Console launched the session it
   * handed over a connection id, the session's `connect_to_room` claimed the
   * room on it, and the server has already told us — so by the time this runs
   * there is nothing to do. It still matters for a session Switch Console only
   * adopted, which has its own connection and never saw our id.
   *
   * Idempotent for the same room, so the common no-op stays a no-op.
   */
  connect(ctx: SessionRoomContext, roomId: string, roomName: string | null): void {
    const existing = this.connections.get(ctx.sessionId);
    if (existing) {
      if (existing.room === roomId) return;
      if (existing.room === null) {
        // Our connection is open but holds no room. Claim it on the existing
        // connection rather than tearing down and rebuilding — that keeps the
        // session's place and its cursor.
        //
        // This is what a restored session needs. It is resumed, not started
        // fresh, so it never re-runs its initial prompt and never calls
        // connect_to_room: no claim is coming from the server, and waiting for
        // one leaves the connection room-less forever, the session silent, and
        // the watcher spawning a duplicate for the next message.
        void existing.repointTo(roomId, roomName).catch((error) => {
          log.warn('SwitchNotificationPoller: failed to claim the remembered room', {
            sessionId: ctx.sessionId,
            roomId,
            error: String(error),
          });
        });
        return;
      }
    }
    this.disconnect(ctx.sessionId);
    void this.start(ctx, roomId, roomName).catch((error) => {
      log.warn('SwitchNotificationPoller: failed to start poller', {
        sessionId: ctx.sessionId,
        error: String(error),
      });
    });
  }

  /** Stop polling for a session (room switch-away or session exit). */
  disconnect(sessionId: string): void {
    const conn = this.connections.get(sessionId);
    if (!conn) return;
    conn.stop();
    this.connections.delete(sessionId);
    log.debug('SwitchNotificationPoller: poll stopped', { sessionId });
  }

  dispose(): void {
    for (const sessionId of [...this.connections.keys()]) this.disconnect(sessionId);
  }

  private async start(
    ctx: SessionRoomContext,
    roomId: string | null,
    roomName: string | null
  ): Promise<string | null> {
    const loaded = await loadSessionWithAgent(ctx.sessionId);
    if (!loaded) {
      log.warn('SwitchNotificationPoller: session not found; cannot read credentials', {
        sessionId: ctx.sessionId,
      });
      return null;
    }
    const location = await getLocationById(loaded.locationId);
    if (!location) {
      log.warn('SwitchNotificationPoller: no location for session; cannot read credentials', {
        sessionId: ctx.sessionId,
      });
      return null;
    }
    if (location.sshHost !== null) {
      // Remote agents poll from their on-host sidecar (CHOO-1059); the local
      // poller reads local credential files, which a remote agent has none of.
      log.debug('SwitchNotificationPoller: remote location; local poller does not apply', {
        sessionId: ctx.sessionId,
        locationId: location.id,
      });
      return null;
    }
    const rootPath = location.dir;

    // A session polls as its OWN agent's identity — resolved from the joined
    // agent row, not from a name frozen into the session's config. An agent's
    // creds live in its provider-neutral `.switch/agents/<name>.json`, keyed by
    // the agent's name. Deriving the slug from the live agent row is what stops a
    // session from polling under the wrong identity when a stale tag disagrees
    // with the agent row.
    const slug = loaded.name;

    // Fall back to the legacy subagent path, then the location's
    // `.claude/settings.local.json`, for un-migrated installs (CHOO-1440).
    const creds =
      (await readSwitchAgentCredentialsFromSettings(agentSettingsPath(rootPath, slug), log)) ??
      (await readSwitchAgentCredentialsFromSettings(subagentSettingsPath(rootPath, slug), log)) ??
      (await readSwitchAgentCredentials(rootPath, log));
    if (!creds) {
      log.warn(
        'SwitchNotificationPoller: missing Switch credentials (SWITCH_API_TOKEN/ENDPOINT/AGENT_ID) — cannot poll room',
        { sessionId: ctx.sessionId, dir: rootPath, roomId, slug }
      );
      return null;
    }

    // Names for the ids these logs carry. The poller holds the joined row
    // already, so hand them over rather than making the log path look them up.
    noteSessionTitle(ctx.sessionId, loaded.row.title);
    noteAgentName(creds.agentId, slug);

    const ptySessionId = makeAgentPtySessionId(location.id, ctx.sessionId);
    // Derived, not random: a tmux-backed session survives Switch Console quitting,
    // and reattaching to a live pane cannot revise the environment it was
    // launched with — the `-e` flags only apply to a pane being created. So a
    // restarted Switch Console has to arrive at the id that pane already holds.
    const connectionId = sessionConnectionId(ctx.sessionId);
    // Consumed, not just read: it belongs to this session's launch, and a
    // later session must not rewind to a message this one already handled.
    const startCursor = this.pendingStart.get(creds.agentId);
    this.pendingStart.delete(creds.agentId);
    const spawnTurn = this.pendingTurn.get(creds.agentId) ?? null;
    this.pendingTurn.delete(creds.agentId);
    // The other end of the watcher's hand-off. If a spawned session comes up
    // without the message that triggered it, these two lines say whether the
    // cursor was handed over and honoured, or whether the session opened at
    // head and read past its own trigger.
    log.info('SwitchNotificationPoller: opening session connection', {
      event: 'switch_session_connection_open',
      sessionId: ctx.sessionId,
      agentId: creds.agentId,
      connectionId,
      startFrom: startCursor ?? 'head',
      roomId: roomId ?? '(await the server)',
      owesTurn: spawnTurn !== null,
    });
    const connection = new RoomConnection({
      creds,
      roomId,
      roomName,
      connectionId,
      startCursor,
      spawnTurn,
      sessionId: ctx.sessionId,
      sink: new PtyInjectionSink(ptySessionId),
      injector: new PluginPromptInjector(ctx.providerId),
      control: resolveSessionControl(ctx.providerId),
      deeplinkScheme: DEEPLINK_SCHEME,
      isHumanTyping: () => isHumanInputRecent(ptySessionId),
      mediaDir: path.join(os.tmpdir(), 'switch-console-switch-media', ctx.sessionId),
      // The server naming this connection's room is the authoritative signal,
      // so it is what updates the session→room map the UI reads. The
      // connect_to_room hook writes the same map, and now only matters for
      // sessions that never got our connection id.
      onRoomChanged: (room) => {
        if (room) {
          void switchRoomService.setSessionRoom(ctx, room, creds.agentId, null);
        } else {
          switchRoomService.clearSession(ctx.sessionId);
        }
      },
      // A refused room must not survive the process. The in-memory clear
      // arrives a moment later on the room-changed path above; this is the
      // durable half, and without it every restart re-declares the same dead
      // room and is refused all over again.
      onRoomRejected: ({ roomId }) => {
        void switchRoomService.forgetRefusedRoom(ctx.sessionId, roomId).catch((error) => {
          log.warn('SwitchNotificationPoller: failed to forget a refused room', {
            sessionId: ctx.sessionId,
            roomId,
            error: String(error),
          });
        });
      },
      log,
    });
    this.connections.set(ctx.sessionId, connection);

    log.debug('SwitchNotificationPoller: poll started', {
      sessionId: ctx.sessionId,
      roomId,
      roomName,
      agentId: creds.agentId,
    });

    // Open the scope the connection's loops inherit. They outlive this call and
    // log from timers, so without it their lines could only ever name the room —
    // which is exactly how a failing connection became hard to trace back to the
    // session and agent behind it.
    runWithLogContext(
      {
        component: 'room-connection',
        sessionId: ctx.sessionId,
        agentId: creds.agentId,
        agentName: slug,
      },
      () => connection.start()
    );
    return connectionId;
  }

  /**
   * Update the injection gate when an agent's derived status changes. Called
   * directly by AgentHookService (the `events` bus is renderer-bound in main, so
   * an in-process emit would not reach us). A no-op for sessions we aren't
   * polling.
   */
  onAgentStatusChange(
    sessionId: string,
    status: AgentStatus,
    notificationType?: NotificationType,
    detail?: string
  ): void {
    const connection = this.connections.get(sessionId);
    if (!connection) return;
    connection.onAgentStatusChange(status, notificationType, detail);
  }

  /**
   * Report the running turn's latest activity line (e.g. "Editing foo.py") so
   * the connection can refresh the bridged "working on it…" message. Called
   * directly by AgentHookService for the same renderer-bound-bus reason as
   * `onAgentStatusChange`. A no-op for sessions we aren't polling.
   */
  onAgentActivity(sessionId: string, detail: string): void {
    const connection = this.connections.get(sessionId);
    if (!connection) return;
    connection.reportActivity(detail);
  }
}

export const switchNotificationPoller = new SwitchNotificationPoller();

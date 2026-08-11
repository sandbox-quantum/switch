import type { IDisposable } from '@switch-console/shared';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import type { SessionRoomConnection } from '@shared/core/switch-rooms/switch-rooms';
import { sessionRoomChangedChannel } from '@shared/core/switch-rooms/switchRoomEvents';
import {
  forgetRoomConnections,
  getPersistedRoomConnection,
  listPersistedRoomSessionIds,
  persistRoomConnection,
} from './session-room-store';
import { switchNotificationPoller } from './switch-notification-poller';

export type SessionRoomContext = {
  sessionId: string;
  providerId: string;
  ptyId: string;
};

type ConnectionState = SessionRoomConnection & {
  roomName: string | null;
  providerId: string;
  ptyId: string;
};

/**
 * Tracks which Switch room each live Switch Console session is connected to.
 *
 * Connections are reported by the Claude `connect_to_room` PostToolUse hook
 * (routed through the agent hook server) and are purely runtime state — a
 * session is listed only while it holds an active connection. The renderer
 * subscribes to `sessionRoomChangedChannel` and can fetch the current set via
 * the `switchRooms` RPC controller.
 *
 * This service is also the home for notification injection (Part B): the poller
 * that pulls addressed room events and injects them into the session's PTY is
 * driven off the same connect/disconnect lifecycle.
 */
class SwitchRoomService implements IDisposable {
  private readonly connections = new Map<string, ConnectionState>();
  private readonly roomListeners = new Set<
    (change: { sessionId: string; roomId: string | null; agentId: string | null }) => void
  >();

  /**
   * Subscribe, **in this process**, to a session's room changing.
   *
   * Deliberately not the `events` bus. In main, `events.emit` is
   * `webContents.send` and `events.on` is `ipcMain.on` — one direction each,
   * renderer-bound. A main-process emit therefore never reaches a
   * main-process listener, so anything in main that subscribed that way
   * silently received nothing. AutoSessionWatcher did exactly that, and its
   * per-room spawn guard was consequently never cleared on connect: it sat
   * until the 120s TTL, blocking respawns for a room whose session had long
   * since arrived.
   *
   * Returns an unsubscribe function.
   */
  onSessionRoomChanged(
    listener: (change: { sessionId: string; roomId: string | null; agentId: string | null }) => void
  ): () => void {
    this.roomListeners.add(listener);
    return () => this.roomListeners.delete(listener);
  }

  private notifyRoomChanged(change: {
    sessionId: string;
    roomId: string | null;
    agentId: string | null;
  }): void {
    // To the renderer, for the UI…
    events.emit(sessionRoomChangedChannel, change);
    // …and to this process, for the logic that reacts to it.
    for (const listener of this.roomListeners) {
      try {
        listener(change);
      } catch (error) {
        log.warn('SwitchRoomService: room-change listener failed', {
          sessionId: change.sessionId,
          error: String(error),
        });
      }
    }
  }

  /**
   * Record (or replace) the room a session is connected to. A session holds at
   * most one room at a time — connecting to a new room replaces the previous
   * one, mirroring the one-room-at-a-time rule on the Switch side.
   */
  setSessionRoom(
    ctx: SessionRoomContext,
    roomId: string,
    agentId: string | null,
    roomName: string | null
  ): void {
    const previous = this.connections.get(ctx.sessionId);
    const unchanged = previous && previous.roomId === roomId && previous.agentId === agentId;

    this.connections.set(ctx.sessionId, {
      sessionId: ctx.sessionId,
      roomId,
      agentId,
      roomName,
      providerId: ctx.providerId,
      ptyId: ctx.ptyId,
    });

    // Persist so a resumed session re-polls this room after an app restart,
    // even though the connect_to_room hook only fires on a live tool call.
    void persistRoomConnection(ctx.sessionId, {
      roomId,
      roomName,
      switchAgentId: agentId,
    }).catch((error) => {
      log.warn('SwitchRoomService: failed to persist connection', {
        sessionId: ctx.sessionId,
        error: String(error),
      });
    });

    if (unchanged) return;

    log.info('SwitchRoomService: session connected to room', {
      sessionId: ctx.sessionId,
      roomId,
      agentId,
    });

    this.notifyRoomChanged({ sessionId: ctx.sessionId, roomId, agentId });
  }

  /**
   * Mirror the room a remote session is attending, as reported by the on-VM
   * sidecar's `/sessions` snapshot. Unlike setSessionRoom (the local
   * connect_to_room hook path) this records the association for DISPLAY only: it
   * does not persist the connection and does not start Switch Console's
   * notification poller — the sidecar owns polling and injection on the VM, and
   * the reconciler re-derives the room from the live snapshot every tick, so
   * there is nothing to restore across restarts. The unchanged-guard keeps the
   * steady-state 2s reconcile from re-emitting; a genuine room switch emits
   * `sessionRoomChangedChannel` so the renderer badge updates.
   */
  mirrorRemoteSessionRoom(ctx: SessionRoomContext, roomId: string, agentId: string): void {
    const previous = this.connections.get(ctx.sessionId);
    if (previous && previous.roomId === roomId && previous.agentId === agentId) return;

    this.connections.set(ctx.sessionId, {
      sessionId: ctx.sessionId,
      roomId,
      agentId,
      roomName: previous?.roomName ?? null,
      providerId: ctx.providerId,
      ptyId: ctx.ptyId,
    });

    log.info('SwitchRoomService: mirrored remote session room', {
      sessionId: ctx.sessionId,
      roomId,
      agentId,
    });

    this.notifyRoomChanged({ sessionId: ctx.sessionId, roomId, agentId });
  }

  /**
   * Re-establish a session's connection to its room from persisted state.
   *
   * Called when a session's PTY (re)launches — e.g. after an app restart. A
   * resumed session does not re-run its initial prompt, so it never calls
   * `connect_to_room` again: nobody else is going to say which room it was in,
   * and without this it comes back connected to nothing.
   *
   * No-op when the session has no persisted room.
   */
  async restoreConnection(ctx: SessionRoomContext): Promise<void> {
    const persisted = await getPersistedRoomConnection(ctx.sessionId);
    if (!persisted) return;

    log.info('SwitchRoomService: restoring the room connection for a resumed session', {
      sessionId: ctx.sessionId,
      roomId: persisted.roomId,
    });

    this.setSessionRoom(ctx, persisted.roomId, persisted.switchAgentId, persisted.roomName);
    switchNotificationPoller.connect(ctx, persisted.roomId, persisted.roomName);
  }

  /** Session ids that had a live room connection before the last shutdown. */
  async listPersistedSessionIds(): Promise<string[]> {
    return listPersistedRoomSessionIds();
  }

  /** Forget persisted connections for sessions that can no longer be restored. */
  async prunePersisted(sessionIds: string[]): Promise<void> {
    await forgetRoomConnections(sessionIds);
  }

  /** Drop a session's connection (on room switch-away or session exit). */
  clearSession(sessionId: string): void {
    if (!this.connections.delete(sessionId)) return;

    log.info('SwitchRoomService: session disconnected from room', { sessionId });

    this.notifyRoomChanged({ sessionId, roomId: null, agentId: null });
  }

  /**
   * The room fields a log entry can borrow from a session id.
   *
   * Synchronous and in-memory on purpose: this runs on the logging write path,
   * where an awaited lookup would be a deadlock waiting for shutdown.
   */
  describeSessionForLog(
    sessionId: string
  ): { roomId?: string; roomName?: string; agentId?: string } | undefined {
    const connection = this.connections.get(sessionId);
    if (!connection) return undefined;
    return {
      roomId: connection.roomId ?? undefined,
      roomName: connection.roomName ?? undefined,
      agentId: connection.agentId ?? undefined,
    };
  }

  /** The current set of live session→room connections. */
  getConnections(): SessionRoomConnection[] {
    return [...this.connections.values()].map(({ sessionId, roomId, agentId }) => ({
      sessionId,
      roomId,
      agentId,
    }));
  }

  dispose(): void {
    this.connections.clear();
  }
}

export const switchRoomService = new SwitchRoomService();

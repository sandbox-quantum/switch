import type { IDisposable } from '@switchdash/shared';
import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { appSettings } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import type { SessionRoomConnection } from '@shared/core/switch-rooms/switch-rooms';
import { sessionRoomChangedChannel } from '@shared/core/switch-rooms/switchRoomEvents';
import { switchNotificationPoller } from './switch-notification-poller';

export type SessionRoomContext = {
  sessionId: string;
  projectId: string;
  providerId: string;
  ptyId: string;
};

type ConnectionState = SessionRoomConnection & {
  roomName: string | null;
  projectId: string;
  providerId: string;
  ptyId: string;
};

/** Persisted across app restarts so a resumed session re-polls its room. */
type PersistedConnection = { roomId: string; agentId: string; roomName: string | null };

const PERSIST_KEY = 'switchRoomConnections';

/**
 * Tracks which Switch room each live switchdash session is connected to.
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

  /**
   * Record (or replace) the room a session is connected to. A session holds at
   * most one room at a time — connecting to a new room replaces the previous
   * one, mirroring the one-room-at-a-time rule on the Switch side.
   */
  setSessionRoom(
    ctx: SessionRoomContext,
    roomId: string,
    agentId: string,
    roomName: string | null
  ): void {
    const previous = this.connections.get(ctx.sessionId);
    const unchanged = previous && previous.roomId === roomId && previous.agentId === agentId;

    this.connections.set(ctx.sessionId, {
      sessionId: ctx.sessionId,
      roomId,
      agentId,
      roomName,
      projectId: ctx.projectId,
      providerId: ctx.providerId,
      ptyId: ctx.ptyId,
    });

    // Persist so a resumed session re-polls this room after an app restart,
    // even though the connect_to_room hook only fires on a live tool call.
    void this.persistConnection(ctx.sessionId, { roomId, agentId, roomName }).catch((error) => {
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

    events.emit(sessionRoomChangedChannel, {
      sessionId: ctx.sessionId,
      roomId,
      agentId,
    });
  }

  /**
   * Re-establish a session's room connection and poller from persisted state.
   * Called when a session's PTY (re)launches — e.g. after an app restart — so
   * the agent keeps receiving addressed room events without having to call
   * connect_to_room again. No-op when the session has no persisted room.
   */
  async restorePoller(ctx: SessionRoomContext): Promise<void> {
    const persisted = await this.getPersisted(ctx.sessionId);
    if (!persisted) return;

    log.info('SwitchRoomService: restoring room poller for resumed session', {
      sessionId: ctx.sessionId,
      roomId: persisted.roomId,
    });

    this.setSessionRoom(ctx, persisted.roomId, persisted.agentId, persisted.roomName);
    switchNotificationPoller.connect(ctx, persisted.roomId, persisted.roomName);
  }

  /** Session ids that had a live room connection before the last shutdown. */
  async listPersistedSessionIds(): Promise<string[]> {
    return Object.keys(await this.readPersisted());
  }

  /** Forget persisted connections whose sessions no longer exist. */
  async prunePersisted(sessionIds: string[]): Promise<void> {
    if (sessionIds.length === 0) return;
    const map = await this.readPersisted();
    let changed = false;
    for (const id of sessionIds) {
      if (id in map) {
        delete map[id];
        changed = true;
      }
    }
    if (changed) await this.writePersisted(map);
  }

  /** Drop a session's connection (on room switch-away or session exit). */
  clearSession(sessionId: string): void {
    if (!this.connections.delete(sessionId)) return;

    log.info('SwitchRoomService: session disconnected from room', { sessionId });

    events.emit(sessionRoomChangedChannel, {
      sessionId,
      roomId: null,
      agentId: null,
    });
  }

  /** The current set of live session→room connections. */
  getConnections(): SessionRoomConnection[] {
    return [...this.connections.values()].map(({ sessionId, roomId, agentId }) => ({
      sessionId,
      roomId,
      agentId,
    }));
  }

  private async getPersisted(sessionId: string): Promise<PersistedConnection | null> {
    const map = await this.readPersisted();
    return map[sessionId] ?? null;
  }

  private async readPersisted(): Promise<Record<string, PersistedConnection>> {
    const [row] = await db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, PERSIST_KEY));
    if (!row) return {};
    try {
      return JSON.parse(row.value) as Record<string, PersistedConnection>;
    } catch {
      return {};
    }
  }

  private async persistConnection(
    sessionId: string,
    connection: PersistedConnection
  ): Promise<void> {
    const map = await this.readPersisted();
    map[sessionId] = connection;
    await this.writePersisted(map);
  }

  private async writePersisted(map: Record<string, PersistedConnection>): Promise<void> {
    const serialized = JSON.stringify(map);
    await db
      .insert(appSettings)
      .values({ key: PERSIST_KEY, value: serialized })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: serialized } });
  }

  dispose(): void {
    this.connections.clear();
  }
}

export const switchRoomService = new SwitchRoomService();

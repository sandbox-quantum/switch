import { inArray, sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessionRoomConnections } from '@main/db/schema';

/**
 * The durable half of a session's room connection: enough to re-arm the poller
 * after a restart. Runtime state (the live `RoomConnection`, its queue and
 * gates) stays in memory — only what must survive the process is stored.
 */
export type PersistedRoomConnection = {
  roomId: string;
  roomName: string | null;
  /** The Switch-side agent identity (`SWITCH_AGENT_ID`), not `agents.id`. */
  switchAgentId: string | null;
};

export async function getPersistedRoomConnection(
  sessionId: string
): Promise<PersistedRoomConnection | null> {
  const [row] = await db
    .select()
    .from(sessionRoomConnections)
    .where(eq(sessionRoomConnections.sessionId, sessionId))
    .limit(1);
  if (!row) return null;
  return { roomId: row.roomId, roomName: row.roomName, switchAgentId: row.switchAgentId };
}

/**
 * Record the room a session is attending. A session holds at most one room, so
 * this is an upsert on the session id rather than an insert.
 */
export async function persistRoomConnection(
  sessionId: string,
  connection: PersistedRoomConnection
): Promise<void> {
  await db
    .insert(sessionRoomConnections)
    .values({
      sessionId,
      roomId: connection.roomId,
      roomName: connection.roomName,
      switchAgentId: connection.switchAgentId,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .onConflictDoUpdate({
      target: sessionRoomConnections.sessionId,
      set: {
        roomId: connection.roomId,
        roomName: connection.roomName,
        switchAgentId: connection.switchAgentId,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      },
    });
}

/** Sessions that held a room connection before the last shutdown. */
export async function listPersistedRoomSessionIds(): Promise<string[]> {
  const rows = await db
    .select({ sessionId: sessionRoomConnections.sessionId })
    .from(sessionRoomConnections);
  return rows.map((row) => row.sessionId);
}

/**
 * Forget connections for sessions that can no longer be restored.
 *
 * A deleted session takes its row with it through the foreign key, so this
 * exists for what the cascade cannot see: a session whose *location* has gone,
 * which leaves the session row intact but unlaunchable.
 */
export async function forgetRoomConnections(sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0) return;
  await db
    .delete(sessionRoomConnections)
    .where(inArray(sessionRoomConnections.sessionId, sessionIds));
}

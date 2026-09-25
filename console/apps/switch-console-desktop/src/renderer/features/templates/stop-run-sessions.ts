import { getLocationManagerStore } from '@renderer/features/locations/stores/location-selectors';
import {
  getRegisteredSessionData,
  getSessionManagerStore,
} from '@renderer/features/sessions/stores/session-selectors';
import { switchRoomsStore as roomConnectionsStore } from '@renderer/features/switch-rooms/switch-rooms-store';
import { rpc } from '@renderer/lib/ipc';

/** A local session connected to one of the given rooms. */
type RoomSession = { agentId: string; sessionId: string };

/** This Console's sessions whose live connection is to one of `roomIds`. */
function sessionsInRooms(roomIds: ReadonlySet<string>): RoomSession[] {
  const found: RoomSession[] = [];
  for (const locationId of getLocationManagerStore().locations.keys()) {
    const manager = getSessionManagerStore(locationId);
    if (!manager) continue;
    for (const session of manager.sessions.values()) {
      const sessionId = session.data.id;
      const roomId = roomConnectionsStore.roomForSession(sessionId);
      if (roomId === null || !roomIds.has(roomId)) continue;
      const data = getRegisteredSessionData(locationId, sessionId);
      if (data) found.push({ agentId: data.agentId, sessionId });
    }
  }
  return found;
}

/**
 * Stop this Console's own sessions that are talking in a stopped run's rooms,
 * the same stop the session header's Stop button sends.
 *
 * The server stops agents creating more rooms in the run, but an agent already
 * at work in one of its rooms keeps going until its session stops. Sessions
 * another Console runs are not reachable from here. Returns how many were
 * asked to stop and how many of those did not confirm.
 */
export async function stopRunSessions(
  roomIds: readonly string[]
): Promise<{ stopped: number; failed: number }> {
  const sessions = sessionsInRooms(new Set(roomIds));
  const results = await Promise.allSettled(
    sessions.map((s) => rpc.sdkHost.stop(s.agentId, s.sessionId))
  );
  const failed = results.filter((r) => r.status === 'rejected').length;
  return { stopped: sessions.length - failed, failed };
}

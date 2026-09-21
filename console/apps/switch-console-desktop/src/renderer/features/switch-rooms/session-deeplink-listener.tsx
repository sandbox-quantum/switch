import { useEffect } from 'react';
import { toast } from 'sonner';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { getLocationManagerStore } from '@renderer/features/locations/stores/location-selectors';
import { getSessionManagerStore } from '@renderer/features/sessions/stores/session-selectors';
import { events } from '@renderer/lib/ipc';
import { scopeToLocationServer } from '@renderer/lib/layout/scope-to-server';
import { appState } from '@renderer/lib/stores/app-state';
import { report } from '@renderer/lib/telemetry/report';
import { sessionDeeplinkChannel } from '@shared/core/switch-rooms/switchRoomEvents';
import { pickDeeplinkTarget } from './session-deeplink-resolve';
import { switchRoomsStore as roomConnectionsStore } from './switch-rooms-store';

/**
 * Resolve the live local session connected to `roomId` and return its
 * navigation target. Matches against the runtime connection set — one room
 * normally has a single local session, so room id alone disambiguates;
 * `agentId` / `server` from the deeplink are advisory.
 */
function findSessionForRoom(roomId: string): { locationId: string; sessionId: string } | null {
  for (const locationId of getLocationManagerStore().locations.keys()) {
    const manager = getSessionManagerStore(locationId);
    if (!manager) continue;
    for (const session of manager.sessions.values()) {
      if (roomConnectionsStore.roomForSession(session.data.id) === roomId) {
        return { locationId, sessionId: session.data.id };
      }
    }
  }
  return null;
}

/**
 * Resolve a session directly by its (shared) session id, which is the same
 * across every client — unlike the room mapping, which only exists on a client
 * that has an active relay for the session. This is what makes the deeplink open
 * the right session on a different Switch Console client that merely adopted it.
 */
function findSessionById(sessionId: string): { locationId: string; sessionId: string } | null {
  for (const locationId of getLocationManagerStore().locations.keys()) {
    const manager = getSessionManagerStore(locationId);
    if (manager?.sessions.has(sessionId)) {
      return { locationId, sessionId: sessionId };
    }
  }
  return null;
}

/**
 * Listens for `switchdash://session?…` deeplinks (delivered by the main process
 * after a messaging-app click) and focuses the app on the matching agent
 * session: it selects the session's Switch server (so the server-scoped sidebar
 * shows it) and navigates to the session view. A render-less component so it can subscribe via the typed event
 * bus and use the navigation store. No live session for the room → logged and
 * ignored.
 */
export function SessionDeeplinkListener(): null {
  useEffect(() => {
    roomConnectionsStore.ensureLoaded();
    void agentsStore.load();
    return events.on(
      sessionDeeplinkChannel,
      ({ agentId, roomId, server, sessionId, coldStart }) => {
        void (async () => {
          const match = pickDeeplinkTarget(
            sessionId,
            () => findSessionById(sessionId),
            () => findSessionForRoom(roomId)
          );
          // Reported here rather than in the main process: whether this install
          // actually has the linked session is the question worth asking, and only
          // the renderer can answer it.
          report('deeplink_opened', { resolved: match !== null, cold_start: coldStart });
          if (!match) {
            console.warn('[deeplink] no local session for deeplink', {
              sessionId,
              roomId,
              agentId,
              server,
            });
            toast.error('No agent session found for this link', {
              description:
                'This copy of Switch Console has no local session for the linked room. Open it on the client running that agent.',
            });
            return;
          }
          console.info('[deeplink] navigating to session', {
            linkSessionId: sessionId,
            matchedSessionId: match.sessionId,
            matchedVia: sessionId ? 'session-id' : 'room',
            locationId: match.locationId,
            roomId,
          });
          // Scope the sidebar to the session's server first; otherwise its location
          // is filtered out of the server-scoped tree and there is no row to
          // reveal. Navigating is all the sidebar needs — it expands and scrolls
          // to whatever the open view selects, from any origin.
          await scopeToLocationServer(match.locationId);
          appState.navigation.navigate('session', match);
        })();
      }
    );
  }, []);
  return null;
}

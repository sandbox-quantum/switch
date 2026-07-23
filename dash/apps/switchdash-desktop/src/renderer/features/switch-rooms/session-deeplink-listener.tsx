import { useEffect } from 'react';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { getLocationManagerStore } from '@renderer/features/locations/stores/location-selectors';
import { getSessionManagerStore } from '@renderer/features/sessions/stores/session-selectors';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { events } from '@renderer/lib/ipc';
import { appState, sidebarStore } from '@renderer/lib/stores/app-state';
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
 * the right session on a different switchdash client that merely adopted it.
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
 * shows it), reveals/expands the session in the sidebar, and navigates to the
 * session view. A render-less component so it can subscribe via the typed event
 * bus and use the navigation store. No live session for the room → logged and
 * ignored.
 */
export function SessionDeeplinkListener(): null {
  useEffect(() => {
    roomConnectionsStore.ensureLoaded();
    void agentsStore.load();
    return events.on(sessionDeeplinkChannel, ({ agentId, roomId, server, sessionId }) => {
      void (async () => {
        const match = pickDeeplinkTarget(
          sessionId,
          () => findSessionById(sessionId),
          () => findSessionForRoom(roomId)
        );
        if (!match) {
          console.warn('[deeplink] no local session for deeplink', {
            sessionId,
            roomId,
            agentId,
            server,
          });
          return;
        }
        // Scope the sidebar to the session's server first; otherwise its location
        // is filtered out of the server-scoped tree and the reveal has nothing
        // to expand.
        console.info('[deeplink] navigating to session', {
          linkSessionId: sessionId,
          matchedSessionId: match.sessionId,
          matchedVia: sessionId ? 'session-id' : 'room',
          locationId: match.locationId,
          roomId,
        });
        if (!agentsStore.loaded) await agentsStore.load();
        const serverId = agentsStore.serverIdForLocation(match.locationId);
        if (serverId) await switchServersStore.setActive(serverId);
        sidebarStore.revealSessionInRoom(match.locationId, roomId);
        appState.navigation.navigate('session', match);
      })();
    });
  }, []);
  return null;
}

import { useEffect } from 'react';
import { agentsStore } from '@renderer/features/projects/stores/agents-store';
import { getProjectManagerStore } from '@renderer/features/projects/stores/project-selectors';
import { getSessionManagerStore } from '@renderer/features/sessions/stores/session-selectors';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { events } from '@renderer/lib/ipc';
import { appState, sidebarStore } from '@renderer/lib/stores/app-state';
import { sessionDeeplinkChannel } from '@shared/core/switch-rooms/switchRoomEvents';
import { switchRoomsStore as roomConnectionsStore } from './switch-rooms-store';

/**
 * Resolve the live local session connected to `roomId` and return its
 * navigation target. Matches against the runtime connection set — one room
 * normally has a single local session, so room id alone disambiguates;
 * `agentId` / `server` from the deeplink are advisory.
 */
function findSessionForRoom(roomId: string): { projectId: string; sessionId: string } | null {
  for (const projectId of getProjectManagerStore().projects.keys()) {
    const manager = getSessionManagerStore(projectId);
    if (!manager) continue;
    for (const session of manager.sessions.values()) {
      if (roomConnectionsStore.roomForSession(session.data.id) === roomId) {
        return { projectId, sessionId: session.data.id };
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
function findSessionById(sessionId: string): { projectId: string; sessionId: string } | null {
  for (const projectId of getProjectManagerStore().projects.keys()) {
    const manager = getSessionManagerStore(projectId);
    if (manager?.sessions.has(sessionId)) {
      return { projectId, sessionId: sessionId };
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
        // Prefer the shared session id (resolves on any client); fall back
        // to room matching for older links that didn't carry it.
        const match = (sessionId ? findSessionById(sessionId) : null) ?? findSessionForRoom(roomId);
        if (!match) {
          console.warn('[deeplink] no local session for deeplink', {
            sessionId,
            roomId,
            agentId,
            server,
          });
          return;
        }
        // Scope the sidebar to the session's server first; otherwise its project
        // is filtered out of the server-scoped tree and the reveal has nothing
        // to expand.
        if (!agentsStore.loaded) await agentsStore.load();
        const serverId = agentsStore.serverIdForProject(match.projectId);
        if (serverId) await switchServersStore.setActive(serverId);
        sidebarStore.revealSessionInRoom(match.projectId, roomId);
        appState.navigation.navigate('session', match);
      })();
    });
  }, []);
  return null;
}

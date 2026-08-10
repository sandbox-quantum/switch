import { getSessionStore } from '@renderer/features/sessions/stores/session-selectors';
import { switchRoomsStore as roomConnectionsStore } from '@renderer/features/switch-rooms/switch-rooms-store';
import { appState, sidebarStore } from '@renderer/lib/stores/app-state';
import type { SidebarSelection } from './sidebar-store';
import { agentSessions, scopedAgents } from './sidebar-tree-data';

/**
 * Which sidebar row the open view selects.
 *
 * Selection is read from navigation rather than reported by the rows, because
 * the rows are the thing that may not be rendered yet — a collapsed group, or a
 * tree that has not finished loading. It also means the dozen places that can
 * change the selection (the palette, keyboard navigation, notifications, the app
 * menu, modals, deeplinks, the restored view at startup) need no part in this.
 */

/**
 * A stable key for *what* is selected, from navigation alone.
 *
 * Deliberately cheap and deliberately not derived from the rendered list: it is
 * what auto-scrolling keys on, and a key that moved with the list would scroll
 * the tree every time a drag reordered it.
 */
export function currentSelectionKey(): string {
  const { navigation } = appState;
  const grouping = sidebarStore.grouping;
  switch (navigation.currentViewId) {
    case 'session': {
      const params = navigation.viewParamsStore.session;
      return `${grouping}|session|${params?.locationId ?? ''}|${params?.sessionId ?? ''}`;
    }
    case 'location': {
      const params = navigation.viewParamsStore.location;
      return `${grouping}|location|${params?.locationId ?? ''}|${params?.agentName ?? ''}|${params?.roomId ?? ''}`;
    }
    case 'room': {
      const params = navigation.viewParamsStore.room;
      return `${grouping}|room|${params?.roomId ?? ''}`;
    }
    default:
      return `${grouping}|none`;
  }
}

/** The agents with a session in `roomKey` — the agents the agent-focused tree
 * lists that room's heading under. */
function agentsWithSessionsInRoom(roomKey: string): string[] {
  const agentIds: string[] = [];
  for (const entry of scopedAgents()) {
    const present = agentSessions(entry).some(
      (session) => roomConnectionsStore.roomForSession(session.data.id) === roomKey
    );
    if (present) agentIds.push(entry.agent.id);
  }
  return agentIds;
}

/**
 * The selected row resolved to the ids the tree nests it under, or null when
 * the open view selects nothing in the sidebar (home, settings, …).
 */
export function currentSidebarSelection(): SidebarSelection | null {
  const { navigation } = appState;
  switch (navigation.currentViewId) {
    case 'session': {
      const params = navigation.viewParamsStore.session;
      if (!params) return null;
      const session = getSessionStore(params.locationId, params.sessionId);
      if (!session || !('agentId' in session.data) || !session.data.agentId) return null;
      return {
        kind: 'session',
        agentId: session.data.agentId,
        roomKey: roomConnectionsStore.roomForSession(params.sessionId),
      };
    }
    case 'location': {
      const params = navigation.viewParamsStore.location;
      if (!params) return null;
      return { kind: 'agent', roomKey: params.roomId ?? null };
    }
    case 'room': {
      const params = navigation.viewParamsStore.room;
      if (!params) return null;
      return {
        kind: 'room',
        roomKey: params.roomId,
        agentIds: agentsWithSessionsInRoom(params.roomId),
      };
    }
    default:
      return null;
  }
}

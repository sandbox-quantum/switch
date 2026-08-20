import { scopeToRoomServer } from '@renderer/lib/layout/scope-to-server';
import { appState, sidebarStore } from '@renderer/lib/stores/app-state';

/**
 * Open a room, and leave the sidebar showing where you are.
 *
 * Navigating alone is not enough. The agent grouping does not list rooms at
 * all, so opening one from anywhere outside the tree left the main panel on a
 * room the sidebar had no row for — the app looking like it had moved
 * somewhere it could not show. Scoping to the room's server, switching to the
 * room grouping and expanding it are the three things that make the open room
 * findable in the tree it belongs to.
 */
export async function openRoom(roomId: string): Promise<void> {
  await scopeToRoomServer(roomId);
  sidebarStore.setGrouping('room');
  sidebarStore.ensureRoomExpanded(roomId);
  appState.navigation.navigate('room', { roomId });
}

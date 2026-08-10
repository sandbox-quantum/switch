import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';

/**
 * Make a target's Switch server the active one before navigating to it.
 *
 * The active server scopes the whole sidebar — `sidebarStore.isLocationInActiveScope`
 * and `switchRoomsStore.listedRoomsInActiveScope` both filter on it. Navigating
 * to something on another server without this opens the view but leaves the
 * sidebar showing a tree the target is not in, so the row you just opened is
 * nowhere to be seen.
 *
 * A no-op when the target is already on the active server, when its server
 * cannot be resolved (an unlinked location), or when no server is active.
 */
async function activateServer(serverId: string | null): Promise<void> {
  if (!serverId) return;
  if (switchServersStore.activeServerId === serverId) return;
  await switchServersStore.setActive(serverId);
}

/** Scope to the server owning `locationId` — for agents and sessions. */
export async function scopeToLocationServer(locationId: string): Promise<void> {
  if (!agentsStore.loaded) await agentsStore.load();
  await activateServer(agentsStore.serverIdForLocation(locationId));
}

/** Scope to the server owning `roomId`. */
export async function scopeToRoomServer(roomId: string): Promise<void> {
  await activateServer(switchRoomsStore.roomServerId(roomId));
}

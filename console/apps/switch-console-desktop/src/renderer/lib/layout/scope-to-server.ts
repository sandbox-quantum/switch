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

/**
 * Scope to a server that shows `locationId` — for agents and sessions.
 *
 * A directory can hold agents for several servers, so there may be more than one
 * right answer. If the active server is already one of them there is nothing to do;
 * switching away would hide the row the caller is navigating to (CHOO-2044).
 */
export async function scopeToLocationServer(locationId: string): Promise<void> {
  if (!agentsStore.loaded) await agentsStore.load();
  const serverIds = agentsStore.serverIdsForLocation(locationId);
  if (serverIds.length === 0) return;
  const active = switchServersStore.activeServerId;
  if (active && serverIds.includes(active)) return;
  await activateServer(serverIds[0]);
}

/** Scope to the server owning `roomId`. */
export async function scopeToRoomServer(roomId: string): Promise<void> {
  await activateServer(switchRoomsStore.roomServerId(roomId));
}

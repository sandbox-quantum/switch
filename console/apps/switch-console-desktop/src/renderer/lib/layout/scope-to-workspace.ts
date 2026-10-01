import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';

/**
 * Make a target's workspace the active one before navigating to it.
 *
 * The active workspace scopes the whole sidebar — `sidebarStore.isLocationInActiveScope`
 * and `switchRoomsStore.listedRoomsInActiveScope` both filter on it. Navigating
 * to something in another workspace without this opens the view but leaves the
 * sidebar showing a tree the target is not in, so the row you just opened is
 * nowhere to be seen. Scoping to the *server* is not enough: its other workspace
 * filters the target out just as surely as another server would.
 *
 * A no-op when the target is already in the active workspace, or when its
 * workspace cannot be resolved (an unlinked location).
 */
async function activateWorkspace(workspaceId: string | null): Promise<void> {
  if (!workspaceId) return;
  if (workspacesStore.activeId === workspaceId) return;
  await workspacesStore.setActive(workspaceId);
}

/**
 * Scope to a workspace that shows `locationId` — for agents and sessions.
 *
 * A directory can hold agents for several workspaces, so there may be more than
 * one right answer. If the active workspace is already one of them there is
 * nothing to do; switching away would hide the row the caller is navigating to
 * (CHOO-2044).
 */
export async function scopeToLocationWorkspace(locationId: string): Promise<void> {
  if (!agentsStore.loaded) await agentsStore.load();
  const workspaceIds = agentsStore.workspaceIdsForLocation(locationId);
  if (workspaceIds.length === 0) return;
  const active = workspacesStore.activeId;
  if (active && workspaceIds.includes(active)) return;
  await activateWorkspace(workspaceIds[0]!);
}

/** Scope to the workspace owning `roomId`. */
export async function scopeToRoomWorkspace(roomId: string): Promise<void> {
  await activateWorkspace(switchRoomsStore.roomWorkspaceId(roomId));
}

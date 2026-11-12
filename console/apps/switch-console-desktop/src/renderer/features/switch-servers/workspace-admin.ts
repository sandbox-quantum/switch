import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { administersWorkspace } from '@shared/core/workspaces/workspaces';
import { switchServersStore } from './switch-servers-store';

/**
 * Whether the signed-in account is the operator running `serverId`: what it
 * sets is the whole server's, not one workspace's.
 */
export function operatesServer(serverId: string): boolean {
  return switchServersStore.statusFor(serverId)?.user?.role === 'admin';
}

/**
 * Whether the signed-in account may manage the workspace a view about
 * `serverId` acts in: an admin of that workspace, or the operator
 * running the server, whom the gateway lets administer every workspace.
 */
export function administersWorkspaceInScope(serverId: string): boolean {
  if (operatesServer(serverId)) return true;
  const workspace = workspacesStore.onServerInScope(serverId);
  return workspace !== null && administersWorkspace(workspace);
}

/**
 * Whether the signed-in account may manage the workspace `workspaceId` names:
 * an admin of it, or the operator running its server.
 */
export function administersWorkspaceById(workspaceId: string): boolean {
  const serverId = workspacesStore.serverIdFor(workspaceId);
  if (serverId !== null && operatesServer(serverId)) return true;
  const workspace = workspacesStore.workspaces.find((each) => each.id === workspaceId) ?? null;
  return workspace !== null && administersWorkspace(workspace);
}

import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { administersWorkspace } from '@shared/core/workspaces/workspaces';
import { switchServersStore } from './switch-servers-store';

/**
 * Whether the signed-in account may manage the workspace a view about
 * `serverId` acts in: an owner or admin of that workspace, or the operator
 * running the server, whom the gateway lets administer every workspace.
 */
export function administersWorkspaceInScope(serverId: string): boolean {
  if (switchServersStore.statusFor(serverId)?.user?.role === 'admin') return true;
  const workspace = workspacesStore.onServerInScope(serverId);
  return workspace !== null && administersWorkspace(workspace);
}

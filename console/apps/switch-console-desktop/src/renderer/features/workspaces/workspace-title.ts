import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { workspacesStore } from './workspaces-store';

/**
 * What a page about a server's workspace is called: the workspace's own name.
 *
 * Before sign-in has matched the server's first workspace to one on the
 * server, there is no workspace name to give — the row is only a placeholder
 * named after the server — so the server's name stands in. Signed in to an
 * account that belongs to no workspace, it says so instead.
 */
export function workspaceTitle(server: SwitchServer): string {
  const workspace = workspacesStore.onServerInScope(server.id);
  if (!workspace) return server.name;
  if (workspace.tenantId !== null) return workspace.name;
  return workspacesStore.hasNoMembership(server.id) ? 'No workspace yet' : server.name;
}

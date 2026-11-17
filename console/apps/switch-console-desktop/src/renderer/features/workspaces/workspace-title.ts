import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import type { Workspace } from '@shared/core/workspaces/workspaces';
import { workspacesStore } from './workspaces-store';

/** The slug of the workspace every self-hosted Switch server is created with. */
const BUILT_IN_WORKSPACE_SLUG = 'default';

/** Its name until someone renames it; a renamed one keeps the name it was given. */
const BUILT_IN_WORKSPACE_NAME = 'Default';

/**
 * What a workspace is called where the Console says where you are.
 *
 * A self-hosted server comes with one workspace of its own, named "Default".
 * When that is the only workspace the account has on the server, the workspace
 * and the server are the same place to the person, and "Default" names
 * neither, so the server's name is used. Beside other workspaces on the same
 * server it keeps its own name, so it is not mistaken for the whole server.
 */
export function workspaceDisplayName(workspace: Workspace, server: SwitchServer): string {
  if (workspace.slug !== BUILT_IN_WORKSPACE_SLUG || workspace.name !== BUILT_IN_WORKSPACE_NAME) {
    return workspace.name;
  }
  const serverName = server.name.trim();
  if (serverName === '' || workspacesStore.onServer(server.id).length !== 1) return workspace.name;
  return serverName;
}

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

/**
 * The breadcrumb's root on a server's pages: {@link workspaceTitle}, with the
 * workspace named as {@link workspaceDisplayName} gives it, so it matches the
 * switcher.
 */
export function breadcrumbTitle(server: SwitchServer): string {
  const workspace = workspacesStore.onServerInScope(server.id);
  return workspace && workspace.tenantId !== null
    ? workspaceDisplayName(workspace, server)
    : workspaceTitle(server);
}

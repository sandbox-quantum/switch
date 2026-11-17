import { openServerPage } from '@renderer/features/switch-servers/open-server-page';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import type { NavigateFnTyped } from '@renderer/lib/layout/navigation-provider';
import { connectorAppsPagePath } from '@shared/core/switch-servers/dashboard-pages';
import { dashboardPageUrl } from '@shared/core/switch-servers/switch-servers';
import type { ConnectorAppSetUp } from './connector-card-state';

/**
 * Go to where the person looking sets up a service's app, as
 * `connectorAppSetUp` placed it: Admin's Apps, open on the service, on a
 * server without the web dashboard, and otherwise the dashboard's connector
 * apps. Organization settings, where the new layout keeps them, opens in the
 * workspace in scope, the one the server answered who may set them up for. A
 * server Console no longer lists has no dashboard address, so that goes to
 * Admin's Apps too.
 */
export function openConnectorAppSetUp(
  serverId: string,
  slug: string,
  setUp: ConnectorAppSetUp,
  navigate: NavigateFnTyped
): void {
  if (setUp.by !== 'viewer')
    throw new Error(`Set up was offered for ${slug}, whose app is not this person's to set up.`);
  const { at } = setUp;
  const server = switchServersStore.servers.find((s) => s.id === serverId);
  if (at === 'admin' || !server) {
    navigate('admin', { serverId, section: 'apps', app: slug });
    return;
  }
  const tenantId =
    at === 'organization-settings'
      ? (workspacesStore.onServerInScope(serverId)?.tenantId ?? null)
      : null;
  void openServerPage(serverId, dashboardPageUrl(server, connectorAppsPagePath(at), tenantId));
}

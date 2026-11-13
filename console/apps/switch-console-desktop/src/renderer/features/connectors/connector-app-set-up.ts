import { openServerPage } from '@renderer/features/switch-servers/open-server-page';
import { servesWebGateway } from '@renderer/features/switch-servers/server-gateway';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import type { NavigateFnTyped } from '@renderer/lib/layout/navigation-provider';
import { dashboardOrigin } from '@shared/core/switch-servers/switch-servers';

/**
 * Go to where a service's app is set up: the web gateway's connector apps on
 * a server that serves the gateway, where Admin has no Apps section, and
 * Admin's Apps, open on the service, on a server that does not.
 */
export function openConnectorAppSetUp(
  serverId: string,
  slug: string,
  navigate: NavigateFnTyped
): void {
  const server = switchServersStore.servers.find((s) => s.id === serverId);
  if (server && servesWebGateway(server))
    void openServerPage(serverId, `${dashboardOrigin(server)}/platform/connectors`);
  else navigate('admin', { serverId, section: 'apps', app: slug });
}

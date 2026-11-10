import { observer } from 'mobx-react-lite';
import type { ReactNode } from 'react';
import { servesWebGateway } from '@renderer/features/switch-servers/server-gateway';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import {
  administersWorkspaceInScope,
  operatesServer,
} from '@renderer/features/switch-servers/workspace-admin';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import {
  PageLayout,
  type PageSidebarGroup,
  PageSidebarGroups,
} from '@renderer/lib/components/page-layout';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import {
  ADMIN_MENU_LABELS,
  type AdminGroup,
  type AdminSection,
  adminGroups,
} from './admin-sections';

/** Wider than a list page, so the tiles keep two columns beside the side menu. */
const WIDTH = 1120;

/** The Admin menu's entries for the signed-in account on `serverId`. */
export function adminGroupsInScope(serverId: string, serviceConnections: boolean): AdminGroup[] {
  const server = switchServersStore.servers.find((s) => s.id === serverId);
  return adminGroups({
    administers: administersWorkspaceInScope(serverId),
    operator: operatesServer(serverId),
    operatesGatewaylessServer:
      operatesServer(serverId) && server !== undefined && !servesWebGateway(server),
    serviceConnections,
  });
}

/** The Admin page's side menu with one section's content beside it. */
export const AdminFrame = observer(function AdminFrame({
  serverId,
  groups,
  active,
  children,
}: {
  serverId: string;
  groups: AdminGroup[];
  active: AdminSection;
  children: ReactNode;
}) {
  const { navigate } = useNavigate();
  const server = switchServersStore.servers.find((s) => s.id === serverId);
  const detail = {
    workspace: workspacesStore.onServerInScope(serverId)?.name ?? '',
    server: server?.name ?? 'This server',
  };
  const menu: PageSidebarGroup<AdminSection>[] = groups.map((group) => ({
    label: group.scope === 'workspace' ? 'Workspace' : 'Server',
    detail: detail[group.scope],
    items: group.items.map((id) => ({ id, label: ADMIN_MENU_LABELS[id] })),
  }));

  return (
    <div className="relative z-10 flex min-h-0 flex-1 overflow-hidden bg-background">
      <PageLayout
        width={WIDTH}
        sidebar={
          <PageSidebarGroups
            groups={menu}
            activeId={active}
            onSelect={(item) => navigate('admin', { serverId, section: item.id })}
          />
        }
      >
        {children}
      </PageLayout>
    </div>
  );
});

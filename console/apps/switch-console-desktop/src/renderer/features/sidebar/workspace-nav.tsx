import {
  Bot,
  DoorOpen,
  FileText,
  House,
  Library,
  type LucideIcon,
  Plug,
  Settings,
  ShieldCheck,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { adminGroupsInScope } from '@renderer/features/admin/admin-frame';
import { useRoomHealth } from '@renderer/features/switch-rooms/connection-health';
import { ManagedServerDot } from '@renderer/features/switch-servers/managed-server-dot';
import { FROZEN, isFrozenServer } from '@renderer/features/switch-servers/managed-server-state';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { useFeatureFlags } from '@renderer/lib/hooks/useFeatureFlags';
import { isCurrentView, useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useWorkspaceSlots } from '@renderer/lib/layout/workspace-slots';
import { BoundShortcut } from '@renderer/lib/ui/shortcut';
import { cn } from '@renderer/utils/utils';
import { connectionNeedsAttention } from '@shared/core/switch-rooms/connection-health';
import { SidebarMenu, SidebarMenuButton } from './sidebar-primitives';
import { type WorkspaceNavView, workspaceNavViews } from './workspace-nav-views';

/**
 * The active server's own destinations, under the workspace switcher, and
 * Settings last.
 *
 * Flat and short — the sessions tree below is where depth belongs. Settings is
 * here rather than in the footer, and is here even with no server at all: it is
 * about this computer and this person, so it works without one. It carries the
 * status of a Switch this Console runs, which is operated from Settings.
 */
export const WorkspaceNav = observer(function WorkspaceNav() {
  const { navigate } = useNavigate();
  const { currentView } = useWorkspaceSlots();
  const { params: homeParams } = useParams('server');
  const { params: agentsParams } = useParams('serverAgents');
  const { params: roomsParams } = useParams('serverRooms');
  const { params: connectorsParams } = useParams('connectors');
  const { params: templatesParams } = useParams('templates');
  const { params: libraryParams } = useParams('library');
  const { params: adminParams } = useParams('admin');
  const active = switchServersStore.activeServer;
  const health = useRoomHealth(active?.id ?? null);
  const serviceConnections = useFeatureFlags(active?.id ?? null).service_connections;
  const warningCount =
    health.data?.agents.filter((agent) => connectionNeedsAttention(agent.state)).length ?? 0;
  // While the server can't answer, only Settings — where it is operated — stays live.
  const frozen = active !== null && isFrozenServer(active);

  const destinations: Record<
    WorkspaceNavView,
    { icon: LucideIcon; label: string; params: { serverId?: string } | undefined }
  > = {
    server: { icon: House, label: 'Home', params: homeParams },
    serverAgents: { icon: Bot, label: 'Your Agents', params: agentsParams },
    serverRooms: { icon: DoorOpen, label: 'Rooms', params: roomsParams },
    library: { icon: Library, label: 'Resources', params: libraryParams },
    templates: { icon: FileText, label: 'Templates', params: templatesParams },
    connectors: { icon: Plug, label: 'Connectors', params: connectorsParams },
    admin: { icon: ShieldCheck, label: 'Admin', params: adminParams },
  };
  const shown = active
    ? workspaceNavViews({
        serviceConnections,
        admin: adminGroupsInScope(active.id, serviceConnections).length > 0,
      })
    : [];
  const onSettings =
    isCurrentView(currentView, 'settings') ||
    isCurrentView(currentView, 'remoteHost') ||
    isCurrentView(currentView, 'managedServer');

  return (
    <SidebarMenu className="flex flex-col gap-[2px] px-2 pt-2">
      {active &&
        shown.map((view) => {
          const { icon: Icon, label, params } = destinations[view];
          return (
            <SidebarMenuButton
              key={view}
              isActive={isCurrentView(currentView, view) && params?.serverId === active.id}
              onClick={() => navigate(view, { serverId: active.id })}
              className={cn(frozen && FROZEN)}
            >
              <Icon className="size-[15px] shrink-0" />
              {label}
              {view === 'serverAgents' && (warningCount > 0 || health.isError) && (
                <span
                  className="ml-auto text-xs text-foreground-warning"
                  title="Agent room connections need attention"
                  aria-label="Agent room connections need attention"
                >
                  {health.isError ? '!' : warningCount}
                </span>
              )}
            </SidebarMenuButton>
          );
        })}
      <SidebarMenuButton
        isActive={onSettings}
        // A Switch this Console runs that is not answering is started from
        // System status, so that is where Settings opens while it is down.
        onClick={() => (frozen ? navigate('settings', { tab: 'status' }) : navigate('settings'))}
        aria-label="Settings"
      >
        <Settings className="size-[15px] shrink-0" />
        Settings
        <span className="ml-auto flex items-center gap-1.5 pr-0.5">
          {active?.managed && <ManagedServerDot server={active} size={7} />}
          <BoundShortcut settingsKey="settings" />
        </span>
      </SidebarMenuButton>
    </SidebarMenu>
  );
});

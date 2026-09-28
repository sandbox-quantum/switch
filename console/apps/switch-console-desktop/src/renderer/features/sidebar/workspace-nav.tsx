import { Bot, DoorOpen, FileText, House } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useRoomHealth } from '@renderer/features/switch-rooms/connection-health';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { isCurrentView, useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useWorkspaceSlots } from '@renderer/lib/layout/workspace-slots';
import { connectionNeedsAttention } from '@shared/core/switch-rooms/connection-health';
import { SidebarMenu, SidebarMenuButton } from './sidebar-primitives';

/**
 * The active server's own destinations, under the workspace switcher.
 *
 * Three places, not a tree: the server's Home, everything it has registered as
 * an agent, and everywhere those agents work. The section is deliberately flat
 * and short — the sessions tree below is where depth belongs.
 */
export const WorkspaceNav = observer(function WorkspaceNav() {
  const { navigate } = useNavigate();
  const { currentView } = useWorkspaceSlots();
  const { params: homeParams } = useParams('server');
  const { params: agentsParams } = useParams('serverAgents');
  const { params: roomsParams } = useParams('serverRooms');
  const { params: templatesParams } = useParams('templates');
  const active = switchServersStore.activeServer;
  const health = useRoomHealth(active?.id ?? null);
  const warningCount =
    health.data?.agents.filter((agent) => connectionNeedsAttention(agent.state)).length ?? 0;
  if (!active) return null;

  const destinations = [
    { view: 'server', icon: House, label: 'Home', params: homeParams },
    { view: 'serverAgents', icon: Bot, label: 'Your Agents', params: agentsParams },
    { view: 'serverRooms', icon: DoorOpen, label: 'Your Rooms', params: roomsParams },
    { view: 'templates', icon: FileText, label: 'Templates', params: templatesParams },
  ] as const;

  return (
    <SidebarMenu className="flex flex-col gap-[2px] px-2 pt-2">
      {destinations.map(({ view, icon: Icon, label, params }) => (
        <SidebarMenuButton
          key={view}
          isActive={isCurrentView(currentView, view) && params?.serverId === active.id}
          onClick={() => navigate(view, { serverId: active.id })}
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
      ))}
    </SidebarMenu>
  );
});

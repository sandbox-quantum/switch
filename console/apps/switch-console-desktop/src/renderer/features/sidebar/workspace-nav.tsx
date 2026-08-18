import { Bot, DoorOpen, House } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { isCurrentView, useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useWorkspaceSlots } from '@renderer/lib/layout/workspace-slots';
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
  const active = switchServersStore.activeServer;
  if (!active) return null;

  const destinations = [
    { view: 'server', icon: House, label: 'Home', params: homeParams },
    { view: 'serverAgents', icon: Bot, label: 'Your Agents', params: agentsParams },
    { view: 'serverRooms', icon: DoorOpen, label: 'Your Rooms', params: roomsParams },
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
        </SidebarMenuButton>
      ))}
    </SidebarMenu>
  );
});

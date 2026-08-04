import { useQuery } from '@tanstack/react-query';
import { Bot, ChevronRight, DoorOpen, Plus } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { getLocationStore } from '@renderer/features/locations/stores/location-selectors';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { appState, sidebarStore } from '@renderer/lib/stores/app-state';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@renderer/lib/ui/context-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/utils/utils';
import type { Agent } from '@shared/core/agents/agents';
import { SidebarItemMiniButton, SidebarMenuAction, SidebarMenuRow } from './sidebar-primitives';
import { depthIndent, roomAgentGroupKey } from './sidebar-store';

/**
 * A member agent, as listed under a room.
 *
 * Deliberately not `SidebarAgentItem` with a room bolted on. The identity of
 * this row is the *pair* (room, agent): the same agent is listed under every
 * room it belongs to, and those are different places in the tree that expand
 * and highlight independently. Sharing one row keyed by agent id made every
 * copy expand and select together.
 *
 * Its actions are the room's, too — start a session here, or drop the agent's
 * membership — rather than the whole-agent operations (reset, delete) that
 * would read like room operations in this context and are not.
 */
export const RoomAgentRow = observer(function RoomAgentRow({
  agent,
  roomId,
  depth,
}: {
  agent: Agent;
  roomId: string;
  depth: number;
}) {
  const { navigate } = useNavigate();
  const showCreateSessionModal = useShowModal('sessionModal');
  const { toastPromise } = useToast();

  const location = getLocationStore(agent.locationId);

  // Labelled by the agent's registered Switch name — this is a Switch room's
  // member list, so the Switch identity is the one that matters here.
  const remoteAgentQuery = useQuery({
    queryKey: ['remoteAgentName', agent.serverId, agent.switchAgentId],
    queryFn: () =>
      rpc.switchServers.getRemoteAgent({
        serverId: agent.serverId!,
        agentId: agent.switchAgentId!,
      }),
    enabled: !!agent.serverId && !!agent.switchAgentId,
  });
  const label = remoteAgentQuery.data?.name?.trim() || agent.name || 'Unnamed agent';

  const expandKey = roomAgentGroupKey(roomId, agent.id);
  const expanded = sidebarStore.isGroupExpanded(expandKey);

  // Active only when the agent page was opened from *this* room. The room
  // travels on the route, so opening the same agent from the agent tree (no
  // room) correctly lights up nothing here instead of an arbitrary row.
  const params = appState.navigation.viewParamsStore.location as
    | { locationId?: string; agentName?: string; roomId?: string }
    | undefined;
  const isActive =
    appState.navigation.currentViewId === 'location' &&
    params?.locationId === agent.locationId &&
    params?.agentName === agent.name &&
    params?.roomId === roomId;

  if (!location) return null;

  const iconClass =
    'absolute h-4 w-4 opacity-100 transition-opacity duration-150 group-hover/row:opacity-0';

  const removeFromRoom = () => {
    const serverId = switchRoomsStore.roomServerId(roomId);
    if (!serverId || !agent.switchAgentId) return;
    const roomLabel = switchRoomsStore.roomNameById(roomId) ?? 'the room';
    void toastPromise(
      rpc.switchServers
        .removeRoomAgent({ serverId, roomId, agentId: agent.switchAgentId })
        .then(() => switchRoomsStore.refreshAll()),
      {
        loading: `Removing ${label} from ${roomLabel}…`,
        success: `${label} was removed from ${roomLabel}`,
        error: (error) =>
          `Failed to remove from room: ${error instanceof Error ? error.message : String(error)}`,
      }
    );
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <SidebarMenuRow
          className="group/row flex h-8 justify-between px-1"
          style={depthIndent(depth)}
          data-active={isActive || undefined}
          isActive={isActive}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            sidebarStore.ensureGroupExpanded(expandKey);
            navigate('location', { locationId: agent.locationId, agentName: agent.name, roomId });
          }}
        >
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <SidebarItemMiniButton
              type="button"
              aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
              className="relative"
              onClick={(e) => {
                e.stopPropagation();
                sidebarStore.toggleGroupExpanded(expandKey);
              }}
            >
              {agent.providerId ? (
                <AgentIcon id={agent.providerId} size={16} className={iconClass} />
              ) : (
                <Bot className={iconClass} />
              )}
              <ChevronRight
                className={cn(
                  'absolute h-4 w-4 opacity-0 transition-all duration-150 group-hover/row:opacity-100',
                  expanded && 'rotate-90'
                )}
              />
            </SidebarItemMiniButton>
            <SidebarMenuAction aria-label={`Open agent ${label}`} className="truncate select-none">
              <span className="truncate">{label}</span>
            </SidebarMenuAction>
          </div>
          <Tooltip>
            <TooltipTrigger
              className="h-6"
              render={
                <SidebarItemMiniButton
                  type="button"
                  aria-label={`New session for ${label} in this room`}
                  className="opacity-0 transition-opacity duration-150 group-hover/row:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    showCreateSessionModal({
                      locationId: agent.locationId,
                      agentName: agent.name,
                      roomId,
                    });
                  }}
                >
                  <Plus className="h-4 w-4" />
                </SidebarItemMiniButton>
              }
            />
            <TooltipContent>New session in this room</TooltipContent>
          </Tooltip>
        </SidebarMenuRow>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem variant="destructive" onClick={removeFromRoom}>
          <DoorOpen className="size-4" />
          Remove from this room
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

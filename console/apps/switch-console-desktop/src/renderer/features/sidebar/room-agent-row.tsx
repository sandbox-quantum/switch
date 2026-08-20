import { Bot, ChevronRight, DoorOpen, Plus } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { getLocationStore } from '@renderer/features/locations/stores/location-selectors';
import { HostTroubleIndicator } from '@renderer/features/remote-hosts/host-trouble-indicator';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { appState, sidebarStore } from '@renderer/lib/stores/app-state';
import { useAgentIconUrl } from '@renderer/lib/stores/use-remote-agents';
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
  hasSessions,
  depth,
}: {
  agent: Agent;
  roomId: string;
  /** Whether this agent has sessions in this room. No sessions, no expand
   * control — the row would unfold into nothing. */
  hasSessions: boolean;
  depth: number;
}) {
  const { navigate } = useNavigate();
  const showCreateSessionModal = useShowModal('sessionModal');
  const { toastPromise } = useToast();

  const location = getLocationStore(agent.locationId);

  // This is a Switch room's member list, so the Switch identity is what matters
  // — and that is the stored name: it is what was registered on the server.
  const label = agent.name || 'Unnamed agent';
  const iconUrl = useAgentIconUrl(agent.serverId, agent.switchAgentId);

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

  const removeFromRoom = () => {
    const serverId = switchRoomsStore.roomServerId(roomId);
    if (!serverId || !agent.switchAgentId) return;
    const roomLabel = switchRoomsStore.roomNameById(roomId) ?? 'the room';
    void toastPromise(
      rpc.switchServers
        .removeRoomAgent({ serverId, roomId, agentId: agent.switchAgentId })
        .then(() => switchRoomsStore.refreshRoomState()),
      {
        loading: `Removing ${label} from ${roomLabel}…`,
        success: `${label} was removed from ${roomLabel}`,
        error: (error) => failureText(error, `Could not remove ${label} from ${roomLabel}.`),
      }
    );
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <SidebarMenuRow
          className="group/row flex justify-between"
          data-active={isActive || undefined}
          isActive={isActive}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() =>
            navigate('location', { locationId: agent.locationId, agentName: agent.name, roomId })
          }
        >
          {/* Indent on the content, not the row, so the highlight still spans
              the sidebar's full width at every depth. */}
          <div className="flex min-w-0 flex-1 items-center gap-[9px]" style={depthIndent(depth)}>
            <span className="flex size-[18px] shrink-0 items-center justify-center">
              <AgentAvatar
                name={label}
                iconUrl={iconUrl}
                size={21}
                className="-mx-[1.5px] bg-transparent"
              />
            </span>
            <SidebarMenuAction aria-label={`Open agent ${label}`} className="truncate select-none">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate">{label}</span>
                {/* Mirrors the agent-grouped row: the same agent must not carry
                    a different amount of information depending on how the
                    sidebar happens to be grouped. */}
                {!sidebarStore.hideProviderMark &&
                  (agent.providerId ? (
                    <AgentIcon id={agent.providerId} size={12} className="h-3 w-3 shrink-0" />
                  ) : (
                    <Bot className="h-3 w-3 shrink-0 text-foreground-muted" />
                  ))}
                {/* Same agent, same host problem — this row used to show
                    nothing, so whether you saw it depended on which grouping
                    the sidebar happened to be in. */}
                <HostTroubleIndicator
                  sshHost={location.data?.sshHost ?? null}
                  agentId={agent.providerId ?? null}
                />
              </span>
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
          {hasSessions && (
            <SidebarItemMiniButton
              type="button"
              aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
              aria-expanded={expanded}
              className="opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-visible:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                sidebarStore.toggleGroupExpanded(expandKey);
              }}
            >
              <ChevronRight
                className={cn('h-4 w-4 transition-transform duration-150', expanded && 'rotate-90')}
              />
            </SidebarItemMiniButton>
          )}
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

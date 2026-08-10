import {
  Bot,
  ChevronRight,
  ExternalLink,
  Plus,
  RotateCcw,
  Server,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useConfirmDeleteAgent } from '@renderer/features/locations/hooks/use-confirm-delete-agent';
import {
  getLocationStore,
  locationViewKind,
} from '@renderer/features/locations/stores/location-selectors';
import { hostReachabilityStore } from '@renderer/features/remote-hosts/host-reachability-store';
import { HostTroubleIndicator } from '@renderer/features/remote-hosts/host-trouble-indicator';
import { hasSessionError } from '@renderer/features/sessions/stores/session-selectors';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useWorkspaceSlots } from '@renderer/lib/layout/workspace-slots';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@renderer/lib/ui/context-menu';
import { BoundShortcut } from '@renderer/lib/ui/shortcut';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/utils/utils';
import type { Agent } from '@shared/core/agents/agents';
import { SidebarItemMiniButton, SidebarMenuAction, SidebarMenuRow } from './sidebar-primitives';
import { agentExpandKey, depthIndent } from './sidebar-store';

/**
 * A single agent in the flat sidebar list. switchdash has no main/subagent
 * distinction — every agent is a first-class row, launched as its own provider
 * definition with its own Switch identity (CHOO-1440). The row opens the agent's
 * page, starts sessions as that agent, and its sessions nest underneath.
 */
export const SidebarAgentItem = observer(function SidebarAgentItem({
  agent,
  depth = 0,
}: {
  agent: Agent;
  depth?: number;
}) {
  const { navigate } = useNavigate();
  const { currentView } = useWorkspaceSlots();
  const { params: locationParams } = useParams('location');
  const { params: sessionParams } = useParams('session');
  const showCreateSessionModal = useShowModal('sessionModal');
  const showConfirmReset = useShowModal('resetAgentModal');
  const confirmDeleteAgent = useConfirmDeleteAgent();
  const { toastPromise } = useToast();

  const agentName = agent.name;
  const location = getLocationStore(agent.locationId);

  // The agent's name IS its Switch identity: switchdash chose it, registered it
  // under that name, and keys its credentials and definition by it. Reading the
  // stored one is reading the same value the server holds.
  const label = agent.name || agentName || 'Unnamed agent';

  const expanded = sidebarStore.isGroupExpanded(agentExpandKey(agent.id));
  const toggle = () => sidebarStore.toggleGroupExpanded(agentExpandKey(agent.id));

  const currentLocationId =
    currentView === 'session'
      ? sessionParams.locationId
      : currentView === 'location'
        ? locationParams.locationId
        : null;
  const currentSubagentName = currentView === 'location' ? locationParams.agentName : undefined;
  const isActive =
    currentView === 'location' &&
    currentLocationId === agent.locationId &&
    currentSubagentName === agentName;

  if (!location) return null;

  const sshHost = location.data?.sshHost ?? null;
  const hostUnreachable = hostReachabilityStore.isBlocked(sshHost);

  const iconClass =
    'absolute h-4 w-4 opacity-100 transition-opacity duration-150 group-hover/row:opacity-0';
  const gatewayUrl =
    agent.serverId && agent.switchAgentId
      ? switchRoomsStore.gatewayAgentUrl(agent.serverId, agent.switchAgentId)
      : null;

  const open = () => {
    sidebarStore.ensureGroupExpanded(agentExpandKey(agent.id));
    navigate('location', { locationId: agent.locationId, agentName });
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
          onClick={open}
        >
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <SidebarItemMiniButton
              type="button"
              aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
              className="relative"
              onClick={(e) => {
                e.stopPropagation();
                toggle();
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
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate">{label}</span>
                {location.data?.sshHost != null && (
                  <Tooltip>
                    <TooltipTrigger>
                      <Server
                        className={cn(
                          'h-3.5 w-3.5 shrink-0',
                          hostUnreachable ? 'text-foreground-warning' : 'text-foreground-muted'
                        )}
                      />
                    </TooltipTrigger>
                    <TooltipContent>
                      Runs remotely on {location.data.sshHost}
                      {location.data.dir ? ` · ${location.data.dir}` : ''}
                    </TooltipContent>
                  </Tooltip>
                )}
                {/* Unreachable host, or one missing something this agent needs.
                    Shared with the room-grouped rows so the two trees cannot
                    disagree about the same agent (CHOO-1682/1809). */}
                <HostTroubleIndicator sshHost={sshHost} agentId={agent.providerId ?? null} />
                {locationViewKind(location) === 'ready' && hasSessionError(agent.locationId) && (
                  <Tooltip>
                    <TooltipTrigger>
                      <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-foreground-destructive" />
                    </TooltipTrigger>
                    <TooltipContent>A session failed to connect</TooltipContent>
                  </Tooltip>
                )}
              </span>
            </SidebarMenuAction>
          </div>
          {gatewayUrl && agent.serverId && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <SidebarItemMiniButton
                    type="button"
                    aria-label={`Open ${label} in gateway`}
                    className="opacity-0 transition-opacity duration-150 group-hover/row:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      void rpc.switchServers.openGatewayPage({
                        serverId: agent.serverId!,
                        url: gatewayUrl,
                      });
                    }}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </SidebarItemMiniButton>
                }
              />
              <TooltipContent>Open in gateway</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger
              className="h-6"
              render={
                <SidebarItemMiniButton
                  type="button"
                  aria-label={`New session for ${label}`}
                  className="opacity-0 transition-opacity duration-150 group-hover/row:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    showCreateSessionModal({ locationId: agent.locationId, agentName });
                  }}
                >
                  <Plus className="h-4 w-4" />
                </SidebarItemMiniButton>
              }
            />
            <TooltipContent>
              New Session
              <BoundShortcut settingsKey="newSession" variant="badge" />
            </TooltipContent>
          </Tooltip>
        </SidebarMenuRow>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {location.data?.sshHost != null && (
          <ContextMenuItem
            onClick={() => {
              showConfirmReset({
                agentLabel: label,
                onSuccess: () => {
                  void toastPromise(rpc.agents.resetRemoteAgent({ agentId: agent.id }), {
                    loading: `Resetting ${label}…`,
                    success: `${label} was reset`,
                    error: (error) =>
                      `Failed to reset agent: ${error instanceof Error ? error.message : String(error)}`,
                  });
                },
              });
            }}
          >
            <RotateCcw className="size-4" />
            Reset agent
          </ContextMenuItem>
        )}
        <ContextMenuItem
          variant="destructive"
          onClick={() => {
            void confirmDeleteAgent({
              locationId: agent.locationId,
              agentId: agent.id,
              locationLabel: label,
              onDeleted: () => {
                if (isActive) navigate('home');
              },
            });
          }}
        >
          <Trash2 className="size-4" />
          Remove Agent
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

import { Bot, ChevronRight, Plus, RotateCcw, Server, Trash2, TriangleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useConfirmDeleteAgent } from '@renderer/features/locations/hooks/use-confirm-delete-agent';
import {
  getLocationStore,
  locationViewKind,
} from '@renderer/features/locations/stores/location-selectors';
import { hostReachabilityStore } from '@renderer/features/remote-hosts/host-reachability-store';
import { HostTroubleIndicator } from '@renderer/features/remote-hosts/host-trouble-indicator';
import {
  getSessionManagerStore,
  hasDiscardableSessionError,
  hasSessionError,
} from '@renderer/features/sessions/stores/session-selectors';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { resetAgentErrorText } from '@renderer/lib/errors/reset-agent-error';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useWorkspaceSlots } from '@renderer/lib/layout/workspace-slots';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { useAgentIconUrl } from '@renderer/lib/stores/use-remote-agents';
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
 * A single agent in the flat sidebar list. Switch Console has no main/subagent
 * distinction — every agent is a first-class row, launched as its own provider
 * definition with its own Switch identity (CHOO-1440). The row opens the agent's
 * page, starts sessions as that agent, and its sessions nest underneath.
 */
export const SidebarAgentItem = observer(function SidebarAgentItem({
  agent,
  hasSessions,
  depth = 0,
}: {
  agent: Agent;
  /** Whether this agent has anything to show when expanded. An expand control
   * over nothing is a promise the row cannot keep. */
  hasSessions: boolean;
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
  const iconUrl = useAgentIconUrl(agent.serverId, agent.switchAgentId);

  // The agent's name IS its Switch identity: Switch Console chose it, registered it
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

  // Opening the agent does not expand it. Expanding is the chevron's job alone,
  // so what is unfolded in the tree stays as the reader left it.
  const open = () => navigate('location', { locationId: agent.locationId, agentName });

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <SidebarMenuRow
          className="group/row flex justify-between"
          data-active={isActive || undefined}
          isActive={isActive}
          onMouseDown={(e) => e.preventDefault()}
          onClick={open}
        >
          {/* The indent lives on the content, not the row, so the hover and
              selection highlight still spans the sidebar's full width at every
              depth. */}
          <div className="flex min-w-0 flex-1 items-center gap-[9px]" style={depthIndent(depth)}>
            {/* 21px inside an 18px slot, so the larger circle reads at the same
                weight as the provider glyphs it replaced without growing the
                row or shifting the label. */}
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
                {/* What the agent runs on. The avatar took the leading slot, so
                    without this the row no longer says. Hideable from the
                    Sessions menu for a reader who only cares about identity. */}
                {!sidebarStore.hideProviderMark &&
                  (agent.providerId ? (
                    <AgentIcon id={agent.providerId} size={12} className="h-3 w-3 shrink-0" />
                  ) : (
                    <Bot className="h-3 w-3 shrink-0 text-foreground-muted" />
                  ))}
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
                {locationViewKind(location) === 'ready' &&
                  hasSessionError(agent.locationId) &&
                  (hasDiscardableSessionError(agent.locationId) ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <SidebarItemMiniButton
                            type="button"
                            aria-label={`Dismiss failed session for ${label}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              getSessionManagerStore(agent.locationId)?.discardFailedCreations();
                            }}
                          >
                            <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-foreground-destructive" />
                          </SidebarItemMiniButton>
                        }
                      />
                      <TooltipContent>
                        A session failed to connect — click to dismiss
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger>
                        <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-foreground-destructive" />
                      </TooltipTrigger>
                      <TooltipContent>A session failed to connect</TooltipContent>
                    </Tooltip>
                  ))}
              </span>
            </SidebarMenuAction>
          </div>
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
          {hasSessions && (
            <SidebarItemMiniButton
              type="button"
              aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
              aria-expanded={expanded}
              className="opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-visible:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                toggle();
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
        {location.data?.sshHost != null && (
          <ContextMenuItem
            onClick={() => {
              showConfirmReset({
                agentLabel: label,
                onSuccess: () => {
                  void toastPromise(rpc.agents.resetRemoteAgent({ agentId: agent.id }), {
                    loading: `Resetting ${label}…`,
                    success: `${label} was reset`,
                    error: (error) => {
                      return resetAgentErrorText(error);
                    },
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

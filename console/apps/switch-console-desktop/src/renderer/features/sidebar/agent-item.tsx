import {
  ChevronRight,
  Plus,
  RotateCcw,
  Server,
  ServerOff,
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
import {
  getSessionManagerStore,
  hasDiscardableSessionError,
  hasSessionError,
} from '@renderer/features/sessions/stores/session-selectors';
import { useAgentConnection } from '@renderer/features/switch-rooms/connection-health';
import { ProviderIssueIndicator } from '@renderer/lib/components/provider-issue-indicator';
import { resetAgentErrorText } from '@renderer/lib/errors/reset-agent-error';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useWorkspaceSlots } from '@renderer/lib/layout/workspace-slots';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { useAgentIconUrl } from '@renderer/lib/stores/use-workspace-agents';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@renderer/lib/ui/context-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/utils/utils';
import type { Agent } from '@shared/core/agents/agents';
import {
  type AgentConnectionState,
  connectionLabels,
} from '@shared/core/switch-rooms/connection-health';
import { type AgentPresence, SidebarAgentRow } from './agent-row';
import { DiscoveryFailureIndicator } from './discovery-failure-indicator';
import { MigrationProblemIndicator } from './migration-problem-indicator';
import { SidebarItemMiniButton } from './sidebar-primitives';
import { agentExpandKey } from './sidebar-store';

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
  const iconUrl = useAgentIconUrl(agent.workspaceId, agent.switchAgentId);
  const connection = useAgentConnection(agent);

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

  const presence = agentPresence(
    connection.state,
    hostUnreachable,
    connection.health?.detail ?? null
  );

  // Opening the agent does not expand it. Expanding is the chevron's job alone,
  // so what is unfolded in the tree stays as the reader left it.
  const open = () => navigate('location', { locationId: agent.locationId, agentName });

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <SidebarAgentRow
          label={label}
          iconUrl={iconUrl}
          serverId={agent.serverId}
          providerId={agent.providerId ?? null}
          isActive={isActive}
          depth={depth}
          onOpen={open}
          presence={presence}
          dimmed={hostUnreachable}
          marks={
            location.data?.sshHost != null && (
              <Tooltip>
                <TooltipTrigger>
                  {hostUnreachable ? (
                    <ServerOff className="h-3.5 w-3.5 shrink-0 text-foreground-destructive" />
                  ) : (
                    <Server className="h-3.5 w-3.5 shrink-0 text-foreground-muted" />
                  )}
                </TooltipTrigger>
                <TooltipContent>
                  {hostUnreachable
                    ? `${location.data.sshHost} cannot be reached. The agent resumes when it reconnects.`
                    : `Runs remotely on ${location.data.sshHost}${location.data.dir ? ` · ${location.data.dir}` : ''}`}
                </TooltipContent>
              </Tooltip>
            )
          }
          status={
            <>
              {/* A host missing something this agent needs. An unreachable one
                    is the red server mark, and the connection is the avatar's
                    dot, so neither repeats here. */}
              <HostTroubleIndicator
                sshHost={hostUnreachable ? null : sshHost}
                agentId={agent.providerId ?? null}
              />
              <DiscoveryFailureIndicator agentId={agent.id} label={label} />
              <MigrationProblemIndicator agentId={agent.id} label={label} />
              {agent.providerId && (
                <ProviderIssueIndicator
                  providerId={agent.providerId}
                  sshHost={sshHost}
                  hostReachable={!hostUnreachable}
                  onOpen={open}
                />
              )}
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
                    <TooltipContent>A session failed to connect — click to dismiss</TooltipContent>
                  </Tooltip>
                ) : (
                  <Tooltip>
                    <TooltipTrigger>
                      <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-foreground-destructive" />
                    </TooltipTrigger>
                    <TooltipContent>A session failed to connect</TooltipContent>
                  </Tooltip>
                ))}
            </>
          }
          actions={
            <>
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
                        showCreateSessionModal({
                          locationId: agent.locationId,
                          agentName,
                          entryPoint: 'sidebar',
                        });
                      }}
                    >
                      <Plus className="h-4 w-4" />
                    </SidebarItemMiniButton>
                  }
                />
                <TooltipContent>New Session</TooltipContent>
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
                    className={cn(
                      'h-4 w-4 transition-transform duration-150',
                      expanded && 'rotate-90'
                    )}
                  />
                </SidebarItemMiniButton>
              )}
            </>
          }
        />
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

/** The dot on a Console agent's avatar: its room connection, or its host when that is down. */
function agentPresence(
  state: AgentConnectionState | undefined,
  hostUnreachable: boolean,
  detail: string | null
): AgentPresence | null {
  if (hostUnreachable) return { tone: 'problem', label: 'Its host cannot be reached' };
  if (!state) return null;
  const label = detail ? `${connectionLabels[state]}: ${detail}` : connectionLabels[state];
  if (state === 'connected') return { tone: 'running', label: 'Running' };
  if (state === 'stopped') return { tone: 'stopped', label };
  if (state === 'connecting') return { tone: 'pending', label };
  return { tone: 'problem', label };
}

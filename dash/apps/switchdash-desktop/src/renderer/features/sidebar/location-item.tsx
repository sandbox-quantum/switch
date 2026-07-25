import { useQuery } from '@tanstack/react-query';
import {
  Bot,
  ChevronRight,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Server,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import React from 'react';
import { useConfirmDeleteAgent } from '@renderer/features/locations/hooks/use-confirm-delete-agent';
import {
  isUnregisteredLocation,
  type UnregisteredLocation,
} from '@renderer/features/locations/stores/location';
import {
  getLocationManagerStore,
  getLocationStore,
  locationViewKind,
} from '@renderer/features/locations/stores/location-selectors';
import { hasSessionError } from '@renderer/features/sessions/stores/session-selectors';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import {
  useNavigate,
  useParams,
  useWorkspaceSlots,
} from '@renderer/lib/layout/navigation-provider';
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
import { representativeAgent } from '@shared/core/agents/agents';
import {
  SidebarItemMiniButton,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuRow,
} from './sidebar-primitives';
import { depthIndent } from './sidebar-store';

const UNREGISTERED_PHASE_LABEL: Record<UnregisteredLocation['phase'], string> = {
  registering: 'Registering…',
  error: 'Failed',
};

export const SidebarLocationItem = observer(function SidebarLocationItem({
  locationId,
  depth = 0,
}: {
  locationId: string;
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

  // Resolve the agent's Switch identity so the "go to" button can open its
  // detail page in the gateway web app (parallel to a room's "go to" button).
  const agentQuery = useQuery({
    queryKey: ['locationAgent', locationId],
    queryFn: async () => representativeAgent(await rpc.agents.getAgents(locationId)) ?? null,
    enabled: !!locationId,
  });

  // The row is labelled by the agent's registered Switch name (its identity on
  // the server), not the local directory-derived location name. Resolve it by
  // id from the gateway, keyed on (server, switch agent id) so it caches and is
  // shared across rows for the same agent.
  const remoteAgentQuery = useQuery({
    queryKey: ['remoteAgentName', agentQuery.data?.serverId, agentQuery.data?.switchAgentId],
    queryFn: async () =>
      rpc.switchServers.getRemoteAgent({
        serverId: agentQuery.data!.serverId!,
        agentId: agentQuery.data!.switchAgentId!,
      }),
    enabled: !!agentQuery.data?.serverId && !!agentQuery.data?.switchAgentId,
  });

  const location = getLocationStore(locationId);

  const currentLocationId =
    currentView === 'session'
      ? sessionParams.locationId
      : currentView === 'location'
        ? locationParams.locationId
        : null;
  const currentSessionId = currentView === 'session' ? sessionParams.sessionId : null;
  // A subagent of this location is scoped by subagentName on the location view;
  // the parent row is active only when no subagent is selected.
  const currentSubagentName = currentView === 'location' ? locationParams.subagentName : undefined;

  const isLocationActive =
    currentLocationId === locationId && !currentSessionId && !currentSubagentName;

  const isExpanded = sidebarStore.expandedLocationIds.has(locationId);

  if (!location) return null;

  const iconClass =
    'absolute h-4 w-4 opacity-100 transition-opacity duration-150 group-hover/row:opacity-0';
  // Registered Switch name wins. While the lookup is still in flight, keep the
  // local name so the row does not flash; once it settles without a name
  // (server unlinked, agent unregistered, or offline) show a stable placeholder.
  const switchName = remoteAgentQuery.data?.name?.trim() || null;
  const locationLabel =
    switchName ??
    (remoteAgentQuery.isLoading ? (location.name ?? 'Unnamed agent') : 'Unnamed agent');
  const toggleExpanded = () => sidebarStore.toggleLocationExpanded(locationId);

  // Clicking the row opens the agent's page (Sessions / Subagents / Settings),
  // mirroring subagent rows; the chevron button below toggles expansion. An
  // unregistered agent has no page yet, so there we just expand.
  const openLocation = () => {
    if (isUnregisteredLocation(location)) {
      toggleExpanded();
      return;
    }
    sidebarStore.ensureLocationExpanded(locationId);
    navigate('location', { locationId });
  };

  const agent = agentQuery.data ?? null;
  // The location's agent type drives its icon; fall back to a generic icon until
  // the agent (and its providerId) is available.
  const providerId = agent?.providerId ?? null;
  const gatewayUrl =
    agent?.serverId && agent?.switchAgentId
      ? switchRoomsStore.gatewayAgentUrl(agent.serverId, agent.switchAgentId)
      : null;
  const openInGateway = () => {
    if (gatewayUrl && agent?.serverId) {
      void rpc.switchServers.openGatewayPage({ serverId: agent.serverId, url: gatewayUrl });
    }
  };

  const renderSpinnerWithTooltip = () => {
    if (!isUnregisteredLocation(location)) return null;
    const label = UNREGISTERED_PHASE_LABEL[location.phase] ?? 'Loading…';
    return (
      <Tooltip>
        <TooltipTrigger>
          <SidebarItemMiniButton type="button" disabled aria-label="Loading">
            <Loader2 className="h-4 w-4 animate-spin text-foreground/60" />
          </SidebarItemMiniButton>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    );
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <SidebarMenuRow
          className={cn('group/row h-8 justify-between flex px-1')}
          style={depthIndent(depth)}
          data-active={isLocationActive || undefined}
          isActive={isLocationActive}
          onMouseDown={(e) => e.preventDefault()}
          onClick={openLocation}
        >
          <div className="flex min-w-0 flex-1 items-center gap-1">
            {location.state === 'unregistered' ? (
              renderSpinnerWithTooltip()
            ) : (
              <SidebarItemMiniButton
                type="button"
                aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${locationLabel}`}
                className="relative"
                onClick={(e) => {
                  e.stopPropagation();
                  sidebarStore.toggleLocationExpanded(locationId);
                }}
              >
                {providerId ? (
                  <AgentIcon id={providerId} size={16} className={iconClass} />
                ) : (
                  <Bot className={iconClass} />
                )}
                <ChevronRight
                  className={cn(
                    'absolute h-4 w-4 transition-all duration-150 opacity-0 group-hover/row:opacity-100',
                    isExpanded && 'rotate-90'
                  )}
                />
              </SidebarItemMiniButton>
            )}
            <SidebarMenuAction
              aria-label={`Open agent ${locationLabel}`}
              className={cn(
                'truncate transition-colors select-none',
                locationViewKind(getLocationStore(locationId)) === 'bootstrapping' &&
                  'text-foreground-tertiary-passive'
              )}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate">{locationLabel}</span>
                {location.data?.sshHost != null && (
                  <Tooltip>
                    <TooltipTrigger>
                      <Server className="h-3.5 w-3.5 shrink-0 text-foreground-muted" />
                    </TooltipTrigger>
                    <TooltipContent>
                      Runs remotely on {location.data.sshHost}
                      {location.data.dir ? ` · ${location.data.dir}` : ''}
                    </TooltipContent>
                  </Tooltip>
                )}
                {locationViewKind(location) === 'path_not_found' && (
                  <Tooltip>
                    <TooltipTrigger>
                      <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-foreground-destructive" />
                    </TooltipTrigger>
                    <TooltipContent>Agent not found at path</TooltipContent>
                  </Tooltip>
                )}
                {locationViewKind(location) === 'mount_error' && (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          className="inline-flex cursor-pointer"
                          onClick={(e) => {
                            e.stopPropagation();
                            void getLocationManagerStore().mountLocation(locationId);
                          }}
                        />
                      }
                    >
                      <RefreshCw className="h-3.5 w-3.5 shrink-0 text-foreground-destructive" />
                    </TooltipTrigger>
                    <TooltipContent>Connection failed — click to retry</TooltipContent>
                  </Tooltip>
                )}
                {locationViewKind(location) === 'ready' && hasSessionError(locationId) && (
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
          {gatewayUrl && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <SidebarItemMiniButton
                    type="button"
                    aria-label={`Open ${locationLabel} in gateway`}
                    className="opacity-0 transition-opacity duration-150 group-hover/row:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      openInGateway();
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
                  aria-label={`New session for ${locationLabel}`}
                  className={
                    'opacity-0 transition-opacity duration-150 group-hover/row:opacity-100'
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    showCreateSessionModal({ locationId });
                  }}
                  disabled={location.state === 'unregistered'}
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
        {location.data?.sshHost != null && agent && (
          <ContextMenuItem
            onClick={() => {
              showConfirmReset({
                agentLabel: locationLabel,
                onSuccess: () => {
                  void toastPromise(rpc.agents.resetRemoteAgent({ agentId: agent.id }), {
                    loading: `Resetting ${locationLabel}…`,
                    success: `${locationLabel} was reset`,
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
              locationId,
              locationLabel: switchName ?? location.name ?? 'this agent',
              onDeleted: () => {
                if (isLocationActive) navigate('home');
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

interface BaseLocationItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  isActive: boolean;
}

export function BaseLocationItem({ isActive, className, ...props }: BaseLocationItemProps) {
  return (
    <SidebarMenuButton
      className={cn('justify-between flex item px-1 py-1', className)}
      isActive={isActive}
      {...props}
    />
  );
}

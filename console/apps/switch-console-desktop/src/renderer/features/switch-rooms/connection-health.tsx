import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CirclePause, Loader2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { isFrozenServer } from '@renderer/features/switch-servers/managed-server-state';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { events, rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import type { Agent } from '@shared/core/agents/agents';
import {
  connectionLabels,
  connectionNeedsAttention,
} from '@shared/core/switch-rooms/connection-health';
import { roomHealthChangedChannel } from '@shared/core/switch-rooms/switchRoomEvents';
import { switchRoomsStore } from './switch-rooms-store';

export const roomHealthKey = (serverId: string | null) => ['room-health', serverId];
/**
 * The server's agents' room connections and session placements, as their room
 * watchers report them: fetched once, then kept current by what the main
 * process pushes on every change.
 */
export function useRoomHealth(serverId: string | null) {
  const cache = useQueryClient();
  const query = useQuery({
    queryKey: roomHealthKey(serverId),
    queryFn: () => rpc.sdkHost.connectionHealth(serverId!),
    enabled: !!serverId,
    staleTime: Infinity,
    retry: false,
  });
  useEffect(() => {
    if (!serverId) return;
    return events.on(
      roomHealthChangedChannel,
      (snapshot) => cache.setQueryData(roomHealthKey(serverId), snapshot),
      serverId
    );
  }, [serverId, cache]);
  useEffect(() => {
    if (query.data) switchRoomsStore.rememberRooms(query.data.placements);
  }, [query.data]);
  return query;
}
export function useAgentConnection(agent: Agent | null) {
  const query = useRoomHealth(agent?.serverId ?? null);
  const health = query.data?.agents.find((entry) => entry.agentId === agent?.id);
  return { query, health, state: query.isError ? ('unknown' as const) : health?.state };
}
export const AgentConnectionIndicator = observer(function AgentConnectionIndicator({
  agent,
  showLabel = false,
}: {
  agent: Agent;
  showLabel?: boolean;
}) {
  const { navigate } = useNavigate();
  const { query, health, state } = useAgentConnection(agent);
  // While its server is not running, the workspace's banner already says why
  // nothing connects; a spinner on every agent would only repeat it.
  const server = agent.serverId ? switchServersStore.serverById(agent.serverId) : null;
  if (server && isFrozenServer(server)) return null;
  if (!agent.switchAgentId || !state || (!showLabel && state === 'connected')) return null;
  const attention = connectionNeedsAttention(state);
  const label = connectionLabels[state];
  const detail = query.isError
    ? failureText(query.error, 'The connection could not be checked.')
    : (health?.detail ?? null);
  const Icon = state === 'connecting' ? Loader2 : state === 'stopped' ? CirclePause : AlertTriangle;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`${agent.name}: ${label}. Open room watcher settings`}
            className={`inline-flex shrink-0 items-center gap-1 text-xs ${attention ? 'text-foreground-warning' : 'text-foreground-muted'}`}
            onClick={(event) => {
              event.stopPropagation();
              navigate('location', { locationId: agent.locationId, agentName: agent.name });
            }}
          >
            {state !== 'connected' && (
              <Icon className={`size-3.5 ${state === 'connecting' ? 'animate-spin' : ''}`} />
            )}
            {showLabel && label}
          </button>
        }
      />
      <TooltipContent>
        {label}
        {detail ? `: ${detail}` : ''}. Click for the room watcher settings.
      </TooltipContent>
    </Tooltip>
  );
});

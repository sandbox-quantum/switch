import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CirclePause, Loader2 } from 'lucide-react';
import { useEffect } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
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
export function AgentConnectionIndicator({
  agent,
  showLabel = false,
}: {
  agent: Agent;
  showLabel?: boolean;
}) {
  const { navigate } = useNavigate();
  const { state } = useAgentConnection(agent);
  if (!agent.switchAgentId || !state || (!showLabel && state === 'connected')) return null;
  const attention = connectionNeedsAttention(state);
  const label = connectionLabels[state];
  const Icon = state === 'connecting' ? Loader2 : state === 'stopped' ? CirclePause : AlertTriangle;
  return (
    <button
      type="button"
      aria-label={`${agent.name}: ${label}. Open room watcher settings`}
      title={`${label}. Open room watcher settings`}
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
  );
}

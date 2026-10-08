import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { events, rpc } from '@renderer/lib/ipc';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { agentMigrationChannel } from '@shared/events/agentMigrationEvents';

export const MANAGED_AGENTS_KEY = 'managed-agents';

/**
 * How often the list is read again on its own. Changes made from this Console
 * (an edit, a new agent, a move) refresh it straight away, and react-query
 * reads it again when the window regains focus and pauses while it is hidden,
 * so this only bounds how long a change made elsewhere takes to show.
 */
const MANAGED_AGENTS_REFRESH_MS = 30_000;

/**
 * The signed-in user's managed agents on the server, as the server holds them,
 * whatever machine each runs on. `null` means the server runs no agent
 * management.
 */
export function useManagedAgents(serverId: string | null) {
  const queryClient = useQueryClient();
  const signedIn = serverId !== null && switchServersStore.isConnected(serverId);
  const user = serverId === null ? null : (switchServersStore.statusFor(serverId)?.user ?? null);
  useEffect(
    () =>
      events.on(agentMigrationChannel, (event) => {
        if (event.operation === null)
          void queryClient.invalidateQueries({ queryKey: [MANAGED_AGENTS_KEY, serverId] });
      }),
    [queryClient, serverId]
  );
  return useQuery({
    queryKey: [MANAGED_AGENTS_KEY, serverId, user?.id ?? null],
    queryFn: () => rpc.managedAgents.list(serverId!),
    enabled: signedIn,
    refetchInterval: (query) => (query.state.data === null ? false : MANAGED_AGENTS_REFRESH_MS),
    retry: false,
  });
}

/** The signed-in user's machines on the server, with what each reported; null without agent management. */
export function useOwnedMachines(serverId: string) {
  return useQuery({
    queryKey: [MANAGED_AGENTS_KEY, serverId, 'machines'],
    queryFn: () => rpc.managedAgents.machines(serverId),
    refetchInterval: 15000,
  });
}

/** The owner's machines on the server, with what each last reported. Null without agent management. */
export function useManagedMachines(serverId: string) {
  return useQuery({
    queryKey: [MANAGED_AGENTS_KEY, serverId, 'machines'],
    queryFn: () => rpc.managedAgents.machines(serverId),
    refetchInterval: (query) => (query.state.data ? 5000 : false),
    retry: false,
  });
}

/** Each provider's advanced configuration fields, as the server checks a definition against them. */
export function useAdvancedConfigSchema(serverId: string | null) {
  return useQuery({
    queryKey: [MANAGED_AGENTS_KEY, serverId, 'advanced-config-schema'],
    queryFn: () => rpc.managedAgents.advancedConfigSchema(serverId!),
    enabled: serverId !== null,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/**
 * Without the agents the server manages. An agent moved to managed from here
 * keeps a row in Console, but the server is what runs it now, so it is shown
 * the way every managed agent is, from the server, rather than twice or as a
 * Console agent with a room watcher that no longer runs here.
 */
export function withoutManaged<T extends { switchAgentId: string | null }>(
  agents: T[],
  managed: ManagedAgentView[] | null | undefined
): T[] {
  if (!managed) return agents;
  const ids = new Set(managed.map((agent) => agent.agentId));
  return agents.filter((agent) => agent.switchAgentId === null || !ids.has(agent.switchAgentId));
}

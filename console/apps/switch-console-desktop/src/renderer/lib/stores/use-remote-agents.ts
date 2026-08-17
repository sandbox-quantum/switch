import { useQuery } from '@tanstack/react-query';
import { rpc } from '@renderer/lib/ipc';
import type { RemoteAgentSummary } from '@shared/core/switch-servers/switch-servers';

/** The agent list a server holds, keyed so every surface shares one fetch.
 * Several unrelated views ask for this at once — the sidebar rows, the room
 * panels, the agent page — and they must agree, so the key is defined once
 * here rather than retyped at each call site. */
export function remoteAgentsQueryKey(serverId: string | null) {
  return ['remote-agents', serverId] as const;
}

/**
 * Every agent registered on `serverId`, or an idle query when there is no
 * server to ask.
 */
export function useRemoteAgents(serverId: string | null) {
  return useQuery<RemoteAgentSummary[]>({
    queryKey: remoteAgentsQueryKey(serverId),
    queryFn: () => rpc.switchServers.listRemoteAgents(serverId as string),
    enabled: serverId !== null,
  });
}

/**
 * An agent's chosen icon, or null when it has none, is not on this server, or
 * the list has not arrived yet.
 *
 * Null is not an error and callers must not treat it as one: `AgentAvatar`
 * draws a bot from the agent's name instead, so a row renders the right
 * picture on first paint and simply sharpens to a custom icon if there is one.
 */
export function useAgentIconUrl(
  serverId: string | null,
  switchAgentId: string | null
): string | null {
  const agents = useRemoteAgents(serverId);
  if (switchAgentId === null) return null;
  return agents.data?.find((agent) => agent.id === switchAgentId)?.iconUrl ?? null;
}

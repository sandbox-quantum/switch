import { useQuery } from '@tanstack/react-query';
import { rpc } from '@renderer/lib/ipc';

/**
 * The agent's registered Switch name (e.g. `claude-code.my-repo.me`), resolved
 * from the gateway. Prefer this over the local `Agent.name`, which is only the
 * working-directory basename and does not identify the agent. Falls back to
 * `fallback` while loading or when the agent can't be resolved.
 */
export function useRemoteAgentName(
  serverId: string | null,
  switchAgentId: string | null,
  fallback: string
): string {
  const query = useQuery({
    queryKey: ['remote-agent-name', serverId, switchAgentId],
    queryFn: () =>
      rpc.switchServers.getRemoteAgent({
        serverId: serverId as string,
        agentId: switchAgentId as string,
      }),
    enabled: serverId !== null && switchAgentId !== null,
  });
  return query.data?.name ?? fallback;
}

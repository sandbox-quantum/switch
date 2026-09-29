import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { rpc } from '@renderer/lib/ipc';
import { type CloudAgent, parseCloudAgentKey } from '@shared/core/cloud-agents/cloud-agents';

/**
 * The server's cloud agents, from its launch list; no worker is asked. Not
 * asked while signed out: the sidebar already says to sign in.
 *
 * `null` means the server has no cloud agents. It is not asked again until its
 * session or declared version changes, which is when it may have gained them.
 */
export function useCloudAgents(serverId: string | null) {
  const signedOut = switchRoomsStore.serversNotSignedIn.some((server) => server.id === serverId);
  const user = serverId === null ? null : (switchServersStore.statusFor(serverId)?.user ?? null);
  return useQuery({
    queryKey: ['cloud-agents', serverId, user?.id ?? null, user?.server?.version ?? null],
    queryFn: () => rpc.sdkHost.cloudAgents(serverId!),
    enabled: serverId !== null && !signedOut,
    refetchInterval: (query) => (query.state.data === null ? false : 5000),
    retry: false,
  });
}

/**
 * The agent with its worker's sessions, asked over the relay only while
 * `watched` and while the window is visible, since each ask is a round trip
 * through the server. A launch that says its worker cannot be asked is not.
 * Under `['cloud-agents']`, so every refresh of the list refreshes this too.
 */
export function useCloudAgentSessions(agent: CloudAgent, watched: boolean): CloudAgent;
export function useCloudAgentSessions(
  agent: CloudAgent | undefined,
  watched: boolean
): CloudAgent | undefined;
export function useCloudAgentSessions(
  agent: CloudAgent | undefined,
  watched: boolean
): CloudAgent | undefined {
  const listed = useQuery({
    queryKey: [
      'cloud-agents',
      parseCloudAgentKey(agent?.key ?? '')?.serverId,
      'sessions',
      agent?.key,
    ],
    queryFn: () => rpc.sdkHost.cloudSessions(agent!.key),
    enabled: watched && agent !== undefined && !agent.problem,
    refetchInterval: 5000,
    retry: false,
  });
  if (!agent || agent.problem) return agent;
  if (listed.error)
    return {
      ...agent,
      sessions: null,
      problem: { code: 'failed', message: String(listed.error), wakeAvailable: false },
    };
  return listed.data ? { ...agent, ...listed.data } : agent;
}

/** Start a sleeping launch's worker again, then look again. */
export function useCloudWake() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (agentKey: string) => rpc.sdkHost.cloudWake(agentKey),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['cloud-agents'] }),
  });
}

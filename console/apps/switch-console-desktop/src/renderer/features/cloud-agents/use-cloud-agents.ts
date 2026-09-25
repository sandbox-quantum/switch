import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '@renderer/lib/ipc';

/** The server's cloud agents and their workers' sessions, asked of each worker over the relay. */
export function useCloudAgents(serverId: string | null) {
  return useQuery({
    queryKey: ['cloud-agents', serverId],
    queryFn: () => rpc.sdkHost.cloudAgents(serverId!),
    enabled: serverId !== null,
    refetchInterval: 5000,
    retry: false,
  });
}

/** Start a sleeping launch's worker again, then look again. */
export function useCloudWake() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (agentKey: string) => rpc.sdkHost.cloudWake(agentKey),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['cloud-agents'] }),
  });
}

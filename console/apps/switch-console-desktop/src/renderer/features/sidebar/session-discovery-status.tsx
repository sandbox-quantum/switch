import { useMutation, useQuery } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
export const SessionDiscoveryStatus = observer(function SessionDiscoveryStatus() {
  const query = useQuery({
    queryKey: ['sdk-discovery-errors'],
    queryFn: () => rpc.sdkHost.discoveryErrors(),
    refetchInterval: 3000,
  });
  const retry = useMutation({
    mutationFn: (agentId: string) => rpc.sdkHost.retryDiscovery(agentId),
    onSuccess: () => query.refetch(),
  });
  return (
    <>
      {(query.error || retry.error) && (
        <div role="alert" className="px-3 py-2 text-xs text-foreground-destructive">
          Session discovery unavailable: {String(query.error || retry.error)}
        </div>
      )}
      {(query.data ?? [])
        .filter((error) => {
          const agent = agentsStore.agentById(error.agentId);
          return agent?.serverId === switchServersStore.activeServerId;
        })
        .map((error) => (
          <div
            key={error.agentId}
            role="alert"
            className="px-3 py-2 text-xs text-foreground-destructive"
          >
            {error.message}
            <Button
              size="sm"
              variant="outline"
              disabled={retry.isPending}
              onClick={() => retry.mutate(error.agentId)}
            >
              Retry discovery
            </Button>
          </div>
        ))}
    </>
  );
});

import { useMutation, useQuery } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { groupDiscoveryFailures } from './group-discovery-failures';
export const SessionDiscoveryStatus = observer(function SessionDiscoveryStatus() {
  const query = useQuery({
    queryKey: ['sdk-discovery-errors'],
    queryFn: () => rpc.sdkHost.discoveryErrors(),
    refetchInterval: 3000,
  });
  const retry = useMutation({
    mutationFn: (agentIds: string[]) =>
      Promise.all(agentIds.map((agentId) => rpc.sdkHost.retryDiscovery(agentId))),
    onSuccess: () => query.refetch(),
  });
  const grouped = groupDiscoveryFailures(
    (query.data ?? []).filter(
      (failure) =>
        agentsStore.agentById(failure.agentId)?.serverId === switchServersStore.activeServerId
    )
  );
  return (
    <>
      {(query.error || retry.error) && (
        <div role="alert" className="px-3 py-2 text-xs text-foreground-destructive">
          Session discovery unavailable: {String(query.error || retry.error)}
        </div>
      )}
      {grouped.map(({ message, agentIds }) => (
        <div key={message} role="alert" className="px-3 py-2 text-xs text-foreground-destructive">
          {message}
          {agentIds.length > 1 && ` (${agentIds.length} agents)`}
          <Button
            size="sm"
            variant="outline"
            disabled={retry.isPending}
            onClick={() => retry.mutate(agentIds)}
          >
            Retry discovery
          </Button>
        </div>
      ))}
    </>
  );
});

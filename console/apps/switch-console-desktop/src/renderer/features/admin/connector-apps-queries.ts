import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { rpc } from '@renderer/lib/ipc';

const connectorAppsKey = (serverId: string) => ['connector-apps', serverId];

/**
 * The server's connector apps, asked for only by its operator; null data
 * means the server has none to set up.
 */
export function useConnectorApps(serverId: string, operator: boolean) {
  return useQuery({
    queryKey: connectorAppsKey(serverId),
    queryFn: () => rpc.switchServers.getConnectorApps(serverId),
    enabled: operator,
    retry: false,
  });
}

/** Re-read the apps after a change, so what a dialog uncovers is already current. */
export function useReloadConnectorApps(serverId: string): () => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey: connectorAppsKey(serverId) }),
    [queryClient, serverId]
  );
}

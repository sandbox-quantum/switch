import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { rpc } from '@renderer/lib/ipc';
import type { ConnectorAppCheck } from '@shared/core/switch-servers/connector-apps';

const connectorAppsKey = (serverId: string) => ['connector-apps', serverId];
const checksKey = (serverId: string, service: string) => [
  'connector-app-checks',
  serverId,
  service,
];

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

/**
 * What the vendor said the last time an app was checked, by its page or by a
 * save, which checks it too; null before either. Kept beside the apps, so a
 * save from a dialog shows on the app's page.
 */
export function useLastChecks(
  serverId: string,
  service: string
): [ConnectorAppCheck[] | null, (checks: ConnectorAppCheck[] | null) => void] {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: checksKey(serverId, service),
    queryFn: () => null,
    enabled: false,
    initialData: null as ConnectorAppCheck[] | null,
    staleTime: Infinity,
  });
  const remember = useCallback(
    (checks: ConnectorAppCheck[] | null) =>
      queryClient.setQueryData(checksKey(serverId, service), checks),
    [queryClient, serverId, service]
  );
  return [data, remember];
}

/** Remember what a save's check said, for the app's page to show. */
export function useRememberChecks(
  serverId: string
): (service: string, checks: ConnectorAppCheck[]) => void {
  const queryClient = useQueryClient();
  return useCallback(
    (service: string, checks: ConnectorAppCheck[]) =>
      queryClient.setQueryData(checksKey(serverId, service), checks.length > 0 ? checks : null),
    [queryClient, serverId]
  );
}

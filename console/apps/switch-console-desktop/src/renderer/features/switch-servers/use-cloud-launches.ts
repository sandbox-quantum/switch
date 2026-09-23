import { useQuery } from '@tanstack/react-query';
import { rpc } from '@renderer/lib/ipc';
import { urlOrigin } from '@shared/core/switch-servers/switch-servers';
import { switchServersStore } from './switch-servers-store';

export function managedCloudServerId(): string | null {
  const origin = import.meta.env.VITE_SWITCH_MANAGED_URL;
  return origin
    ? (switchServersStore.servers.find(
        (server) => urlOrigin(server.gatewayUrl) === urlOrigin(origin)
      )?.id ?? null)
    : null;
}

export function useCloudLaunches(serverId: string | null) {
  return useQuery({
    queryKey: ['cloud-launches', serverId],
    queryFn: () => rpc.switchServers.listCloudLaunches(serverId!),
    enabled: serverId !== null && serverId === managedCloudServerId(),
    refetchInterval: 3000,
    retry: false,
  });
}

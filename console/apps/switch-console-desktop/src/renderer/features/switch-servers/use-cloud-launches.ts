import { useCloudAgents } from '@renderer/features/cloud-agents/use-cloud-agents';
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

/**
 * The server's cloud launches, read from the same query as the sidebar's cloud
 * agents so a lifecycle change refreshes both. Empty when the server has none.
 */
export function useCloudLaunches(serverId: string | null) {
  const agents = useCloudAgents(serverId);
  return {
    data: agents.data === undefined ? undefined : (agents.data ?? []).map((agent) => agent.launch),
    isSuccess: agents.isSuccess,
    isLoading: agents.isLoading,
    error: agents.error,
  };
}

import { useQuery } from '@tanstack/react-query';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { useFeatureFlags } from '@renderer/lib/hooks/useFeatureFlags';
import { rpc } from '@renderer/lib/ipc';

export const SHARED_CLOUD_AGENTS_KEY = 'shared-cloud-agents';
export const SHARED_CLOUD_OVERVIEW_KEY = 'shared-cloud-overview';

function signedOut(serverId: string | null): boolean {
  const workspaceId = workspacesStore.idOnServerInScope(serverId);
  return switchRoomsStore.workspacesNotSignedIn.some((workspace) => workspace.id === workspaceId);
}

function userKey(serverId: string | null): string | null {
  return serverId === null ? null : (switchServersStore.statusFor(serverId)?.user?.id ?? null);
}

/**
 * The caller's agents on the shared cloud. `null` means the server offers no
 * shared cloud, so the page looks as it always has, and it is not asked again
 * until the session changes. Otherwise it refreshes every few seconds, since
 * agents rest and wake on their own.
 */
export function useSharedCloudAgents(serverId: string | null) {
  const offered = useFeatureFlags(serverId).hosted_agents;
  return useQuery({
    queryKey: [SHARED_CLOUD_AGENTS_KEY, serverId, userKey(serverId)],
    queryFn: () => rpc.switchServers.sharedCloudAgents(serverId!),
    // Only on a server that offers hosted agents: elsewhere nothing is asked.
    enabled: serverId !== null && offered && !signedOut(serverId),
    refetchInterval: (query) => (query.state.data === null ? false : 5000),
    retry: false,
  });
}

/** The admin's view of the shared cloud, or null when it is not offered or not theirs. */
export function useSharedCloudOverview(serverId: string | null) {
  const offered = useFeatureFlags(serverId).hosted_agents;
  return useQuery({
    queryKey: [SHARED_CLOUD_OVERVIEW_KEY, serverId, userKey(serverId)],
    queryFn: () => rpc.switchServers.sharedCloudOverview(serverId!),
    enabled: serverId !== null && offered && !signedOut(serverId),
    refetchInterval: (query) => (query.state.data === null ? false : 10000),
    retry: false,
  });
}

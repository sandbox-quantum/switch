import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import type { ServerFeatureFlags } from '@shared/core/feature-flags/feature-flags';
import { featureFlagsChangedChannel } from '@shared/events/featureFlagEvents';

/** The workspace's catalog, shared with the agent settings' Service access row. */
export const catalogKey = (workspaceId: string) => ['workspace-service-connections', workspaceId];
const agentsKey = (workspaceId: string, service: string) => [
  'connection-agents',
  workspaceId,
  service,
];
const workspaceServicesKey = (workspaceId: string) => ['workspace-services', workspaceId];
/** The person's GitHub connection and what it reaches, shared with the agent settings' Service access row. */
export const githubKey = (workspaceId: string) => ['workspace-github', workspaceId];

export function useConnectorCatalog(workspaceId: string) {
  return useQuery({
    queryKey: catalogKey(workspaceId),
    queryFn: () => rpc.workspaces.getServiceConnections(workspaceId),
    retry: false,
  });
}

export function useConnectionAgents(workspaceId: string, service: string) {
  return useQuery({
    queryKey: agentsKey(workspaceId, service),
    queryFn: () => rpc.workspaces.getConnectionAgents({ workspaceId, service }),
    retry: false,
  });
}

/**
 * The person's GitHub connection: who they are and the repositories each
 * installation reaches. Re-read as the window regains focus, since those are
 * chosen on GitHub, in the browser.
 */
export function useGitHubConnection(workspaceId: string, enabled: boolean) {
  return useQuery({
    queryKey: githubKey(workspaceId),
    queryFn: () => rpc.workspaces.getGitHubConnection(workspaceId),
    enabled,
    retry: false,
    refetchOnWindowFocus: true,
  });
}

/** The workspace's switches, for its admins; null data means the server has none. */
export function useWorkspaceServices(workspaceId: string) {
  return useQuery({
    queryKey: workspaceServicesKey(workspaceId),
    queryFn: () => rpc.workspaces.getWorkspaceServices(workspaceId),
    retry: false,
  });
}

/**
 * Re-read everything a connection, grant or switch change can move: the
 * catalog, who uses each service, the admin's switches, and the agent
 * settings that read the same connections and grants.
 */
export function useReloadConnectors(workspaceId: string): () => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(async () => {
    await Promise.all(
      [
        catalogKey(workspaceId),
        ['connection-agents', workspaceId],
        workspaceServicesKey(workspaceId),
        githubKey(workspaceId),
        ['agent-service-grants', workspaceId],
      ].map((queryKey) => queryClient.invalidateQueries({ queryKey }))
    );
  }, [queryClient, workspaceId]);
}

/**
 * The server's feature flags as Console last read them, kept current; null
 * until the first answer. Unlike `useFeatureFlags`, which reads every flag as
 * off until then, this lets a page wait rather than act on flags not yet read.
 */
export function useServerFeatureFlags(serverId: string): ServerFeatureFlags | null {
  const [flags, setFlags] = useState<ServerFeatureFlags | null>(null);
  useEffect(() => {
    setFlags(null);
    let current = true;
    const off = events.on(featureFlagsChangedChannel, (state) => {
      if (state.serverId === serverId) setFlags(state);
    });
    void rpc.featureFlags.get(serverId).then((res) => {
      if (current && res?.success) setFlags(res.data);
    });
    return () => {
      current = false;
      off();
    };
  }, [serverId]);
  return flags;
}

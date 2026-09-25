import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { rpc } from '@renderer/lib/ipc';
import type { LinkedIdentity } from '@shared/core/switch-servers/switch-servers';

/** Shared so every surface that claims or releases an identity refreshes the
 * same cache entry the owner-only warning reads. */
export function myIdentitiesQueryKey(serverId: string | null): unknown[] {
  return ['my-switch-identities', serverId];
}

/**
 * The messaging accounts the signed-in user has claimed on a server
 * (CHOO-2137).
 *
 * `identities` is null while the answer is unknown — not signed in, no server
 * chosen, still loading, or the read failed. Callers must treat that as
 * "unknown" rather than "none": warning that an owner-only agent is
 * unreachable, on the strength of a list that has not arrived, is the same
 * false alarm every time the page opens.
 */
export function useMyIdentities(serverId: string | null): {
  identities: LinkedIdentity[] | null;
  isLoading: boolean;
  error: unknown;
  refresh: () => void;
} {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: myIdentitiesQueryKey(serverId),
    queryFn: () => rpc.switchServers.listMyIdentities(serverId as string),
    enabled: serverId !== null,
  });

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: myIdentitiesQueryKey(serverId) });
  }, [queryClient, serverId]);

  return {
    identities: query.isSuccess ? query.data : null,
    isLoading: query.isLoading,
    error: query.error,
    refresh,
  };
}

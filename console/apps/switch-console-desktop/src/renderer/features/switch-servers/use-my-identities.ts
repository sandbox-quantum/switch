import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { rpc } from '@renderer/lib/ipc';
import type { LinkedIdentity, PendingIdentity } from '@shared/core/switch-servers/switch-servers';

/** Shared so every surface that claims or releases an identity refreshes the
 * same cache entry the owner-only warning reads. Invalidating it refreshes the
 * pending links too, which live under it. */
export function myIdentitiesQueryKey(workspaceId: string | null): unknown[] {
  return ['my-switch-identities', workspaceId];
}

/** Under {@link myIdentitiesQueryKey}, so everything that re-reads the linked
 * accounts re-reads the ones still waiting for a code as well. */
export function myPendingIdentitiesQueryKey(workspaceId: string | null): unknown[] {
  return [...myIdentitiesQueryKey(workspaceId), 'pending'];
}

/**
 * The messaging accounts linked to the signed-in user in a workspace
 * (CHOO-2137). Only links that count: one still waiting for its code is in
 * {@link useMyPendingIdentities} instead, and is never "linked" here.
 *
 * `identities` is null while the answer is unknown — not signed in, no
 * workspace chosen, still loading, or the read failed. Callers must treat that as
 * "unknown" rather than "none": warning that an owner-only agent is
 * unreachable, on the strength of a list that has not arrived, is the same
 * false alarm every time the page opens.
 *
 * `pollMs` re-reads on an interval while set, for a screen waiting on a code to
 * be posted from the account — nothing tells the app when that happens.
 * `updatedAt` is when the list was last read successfully (0 before then), for
 * telling which of two lists read separately is the newer.
 */
export function useMyIdentities(
  workspaceId: string | null,
  pollMs: number | false = false
): {
  identities: LinkedIdentity[] | null;
  updatedAt: number;
  isLoading: boolean;
  error: unknown;
  refresh: () => void;
} {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: myIdentitiesQueryKey(workspaceId),
    queryFn: () => rpc.workspaces.listMyIdentities(workspaceId as string),
    enabled: workspaceId !== null,
    refetchInterval: pollMs,
  });

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: myIdentitiesQueryKey(workspaceId) });
  }, [queryClient, workspaceId]);

  return {
    identities: query.isSuccess ? query.data : null,
    updatedAt: query.dataUpdatedAt,
    isLoading: query.isLoading,
    error: query.error,
    refresh,
  };
}

/**
 * The messaging accounts waiting for a code to confirm a link to the signed-in
 * user (CHOO-3881). They count for nothing yet, so nothing reads them as
 * linked — they are shown so the person can finish or cancel the link.
 *
 * Null while unknown, as for {@link useMyIdentities}. A server that predates
 * confirming links answers with none. `pollMs` and `updatedAt` are as there.
 */
export function useMyPendingIdentities(
  workspaceId: string | null,
  pollMs: number | false = false
): {
  pending: PendingIdentity[] | null;
  updatedAt: number;
  error: unknown;
} {
  const query = useQuery({
    queryKey: myPendingIdentitiesQueryKey(workspaceId),
    queryFn: () => rpc.workspaces.listMyPendingIdentities(workspaceId as string),
    enabled: workspaceId !== null,
    refetchInterval: pollMs,
  });
  return {
    pending: query.isSuccess ? query.data : null,
    updatedAt: query.dataUpdatedAt,
    error: query.error,
  };
}

import { rpc } from '@renderer/lib/ipc';

/** One messaging app's links made before links had to be confirmed. */
export function unconfirmedLinksQueryKey(workspaceId: string | null, bridgeId: string): unknown[] {
  return ['unconfirmed-identity-links', workspaceId, bridgeId];
}

/**
 * The query for one app's older links (CHOO-3881), shared by the card that
 * counts them and the dialog that lists them, so both read one cache entry.
 * Admin only: a caller that is not one must leave it disabled rather than ask
 * and be refused.
 */
export function unconfirmedLinksQuery(workspaceId: string | null, bridgeId: string) {
  return {
    queryKey: unconfirmedLinksQueryKey(workspaceId, bridgeId),
    queryFn: () =>
      rpc.workspaces.listUnconfirmedLinks({ workspaceId: workspaceId as string, bridgeId }),
  };
}

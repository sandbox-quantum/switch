import { useQueries } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { learnBridgePlatforms } from '@renderer/lib/components/bridge-platform';
import { rpc } from '@renderer/lib/ipc';
import type { RemoteBridgeType } from '@shared/core/switch-servers/switch-servers';

/** The query key every reader of a workspace's bridge types shares. */
export function bridgeTypesQueryKey(workspaceId: string | null) {
  return ['remote-bridge-types', workspaceId] as const;
}

/**
 * A workspace's bridge types, learning what they say about their platforms on
 * the way through. Every query on {@link bridgeTypesQueryKey} uses this, so
 * whichever of them fetches first teaches the rest of the app.
 */
export async function fetchBridgeTypes(workspaceId: string): Promise<RemoteBridgeType[]> {
  const types = await rpc.workspaces.listBridgeTypes(workspaceId);
  learnBridgePlatforms(types);
  return types;
}

/**
 * Learn every workspace's messaging platforms — names, docs pages, logos — once
 * the app is up, so a platform is labelled and drawn properly wherever it first
 * appears rather than only after someone opens the connect dialog.
 *
 * A server that cannot be reached is skipped: its platforms keep the bundled
 * names, or their raw keys, until it answers.
 */
export const BridgePlatformsLoader = observer(function BridgePlatformsLoader() {
  useQueries({
    queries: workspacesStore.workspaces.map((workspace) => ({
      queryKey: bridgeTypesQueryKey(workspace.id),
      queryFn: () => fetchBridgeTypes(workspace.id),
      staleTime: 10 * 60 * 1000,
    })),
  });
  return null;
});

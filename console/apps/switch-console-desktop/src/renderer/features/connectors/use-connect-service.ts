import { useCallback } from 'react';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import { useReloadConnectors } from './connectors-queries';

/**
 * Opens the connect modal for a service, from its card or its profile, and
 * re-reads the page as soon as the service is connected, so the profile behind
 * the dialog is current, and again however the modal ends. `afterConnected`
 * runs as the service is connected, with the warning Switch gave, so the
 * caller can open the page's Add agent search.
 */
export function useConnectService(serverId: string, workspaceId: string) {
  const showConnect = useShowModal('connectServiceModal');
  const reload = useReloadConnectors(workspaceId);
  return useCallback(
    (
      connection: ConnectionCatalogEntry,
      startAt: 'connect' | 'replace',
      afterConnected: (warning: string | null) => void
    ) =>
      showConnect({
        serverId,
        workspaceId,
        connection,
        startAt,
        onConnected: (warning) => {
          void reload();
          afterConnected(warning);
        },
        onSuccess: () => void reload(),
        onClose: () => void reload(),
      }),
    [showConnect, reload, serverId, workspaceId]
  );
}

import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { events } from '@renderer/lib/ipc';
import type { LocalServerStatus } from '@shared/core/managed-switch-server/managed-switch-server';
import { localServerStatusChannel } from '@shared/events/localSwitchServerEvents';
import { switchRoomsStore } from './switch-rooms-store';
import { myIdentitiesQueryKey } from './use-my-identities';

/**
 * Re-read what the Mattermost beside a native local server changed, once it
 * has come up.
 *
 * It comes up after the server does, then registers its bridge and links the
 * admin's account to it by itself, on no signal Switch Console receives. A page
 * already open would go on showing no Mattermost and asking to link an account
 * until something remounted it, which in practice meant restarting the server.
 * The status says when the bring-up has finished, so that is when they re-read.
 * Exported for its test; {@link LocalMattermostListener} is its only other user.
 */
export function refreshWhenLocalMattermostIsUp(queryClient: QueryClient): () => void {
  let previous: LocalServerStatus['mattermostState'] = null;
  return events.on(localServerStatusChannel, (status) => {
    const cameUp = status.mattermostState === 'running' && previous !== 'running';
    previous = status.mattermostState;
    if (!cameUp) return;
    const workspaceId = workspacesStore.idOnServerInScope(status.serverId);
    void queryClient.invalidateQueries({ queryKey: ['remote-bridges', workspaceId] });
    void queryClient.invalidateQueries({ queryKey: myIdentitiesQueryKey(workspaceId) });
    void queryClient.invalidateQueries({ queryKey: ['owns-owner-addressed-agent', workspaceId] });
    void switchRoomsStore.refreshRoomState();
  });
}

export function LocalMattermostListener() {
  const queryClient = useQueryClient();
  useEffect(() => refreshWhenLocalMattermostIsUp(queryClient), [queryClient]);
  return null;
}

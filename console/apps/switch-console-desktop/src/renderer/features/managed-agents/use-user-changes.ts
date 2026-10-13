import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { events, rpc } from '@renderer/lib/ipc';
import { userChangesChannel } from '@shared/events/userChangesEvents';
import { MANAGED_AGENTS_KEY } from './use-managed-agents-key';

/**
 * Keep the change socket for this server and its workspace in scope open
 * while the component is shown (a session is one workspace's, so switching
 * workspace opens another), and
 * read the managed-agents lists again whenever the server says one changed.
 *
 * Returns whether the server is pushing changes right now. While it is not
 * (an older server, or the socket is between connections), callers keep
 * polling; when it opens, everything is read once, so a change missed while
 * it was closed shows up.
 */
export function useUserChangesLive(serverId: string | null): boolean {
  const queryClient = useQueryClient();
  const [live, setLive] = useState(false);
  const workspaceId = workspacesStore.idOnServerInScope(serverId);
  useEffect(() => {
    if (serverId === null) return;
    let disposed = false;
    const refresh = () =>
      void queryClient.invalidateQueries({ queryKey: [MANAGED_AGENTS_KEY, serverId] });
    const off = events.on(userChangesChannel, (event) => {
      if (event.serverId !== serverId || event.workspaceId !== workspaceId) return;
      if (event.type === 'live') {
        setLive(true);
        refresh();
      } else if (event.type === 'down') {
        setLive(false);
      } else {
        refresh();
      }
    });
    void rpc.userChanges.watch(serverId, workspaceId).then((isLive) => {
      if (!disposed && isLive) setLive(true);
    });
    return () => {
      disposed = true;
      off();
      setLive(false);
      void rpc.userChanges.unwatch(serverId, workspaceId);
    };
  }, [queryClient, serverId, workspaceId]);
  return live;
}

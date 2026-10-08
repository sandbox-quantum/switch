import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import { userChangesChannel } from '@shared/events/userChangesEvents';
import { MANAGED_AGENTS_KEY } from './use-managed-agents-key';

/**
 * Keep this server's change socket open while the component is shown, and
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
  useEffect(() => {
    if (serverId === null) return;
    let disposed = false;
    const refresh = () =>
      void queryClient.invalidateQueries({ queryKey: [MANAGED_AGENTS_KEY, serverId] });
    const off = events.on(userChangesChannel, (event) => {
      if (event.serverId !== serverId) return;
      if (event.type === 'live') {
        setLive(true);
        refresh();
      } else if (event.type === 'down') {
        setLive(false);
      } else {
        refresh();
      }
    });
    void rpc.userChanges.watch(serverId).then((isLive) => {
      if (!disposed && isLive) setLive(true);
    });
    return () => {
      disposed = true;
      off();
      setLive(false);
      void rpc.userChanges.unwatch(serverId);
    };
  }, [queryClient, serverId]);
  return live;
}

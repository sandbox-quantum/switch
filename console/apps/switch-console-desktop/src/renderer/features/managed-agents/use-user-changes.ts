import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { events, rpc } from '@renderer/lib/ipc';
import { userChangesChannel } from '@shared/events/userChangesEvents';
import { MANAGED_AGENTS_KEY } from './use-managed-agents-key';

/**
 * One listener per server and workspace in this window, however many
 * components ask: every agent row reads the machines list through
 * `useRunsOnThisComputer`, and a listener per row turned one notice into a
 * read of the same lists per row. Each hook only follows whether the socket
 * is live.
 */
type Feed = {
  watchers: number;
  live: boolean;
  onLive: Set<(live: boolean) => void>;
  stop: () => void;
};

const feeds = new Map<string, Feed>();

function startFeed(queryClient: QueryClient, serverId: string, workspaceId: string | null): Feed {
  const feed: Feed = { watchers: 0, live: false, onLive: new Set(), stop: () => {} };
  const setLive = (live: boolean) => {
    if (feed.live === live) return;
    feed.live = live;
    for (const notify of feed.onLive) notify(live);
  };
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: [MANAGED_AGENTS_KEY, serverId] });
  let stopped = false;
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
    if (stopped || !isLive) return;
    setLive(true);
    // Live from here on, the lists are polled only rarely: read them once now, as
    // the `live` notice does, so one read before the feed was up does not stay.
    refresh();
  });
  feed.stop = () => {
    stopped = true;
    off();
    setLive(false);
    void rpc.userChanges.unwatch(serverId, workspaceId);
  };
  return feed;
}

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
    const key = `${serverId}\u0000${workspaceId ?? ''}`;
    let feed = feeds.get(key);
    if (!feed) {
      feed = startFeed(queryClient, serverId, workspaceId);
      feeds.set(key, feed);
    }
    feed.watchers += 1;
    feed.onLive.add(setLive);
    setLive(feed.live);
    const held = feed;
    return () => {
      held.onLive.delete(setLive);
      setLive(false);
      held.watchers -= 1;
      if (held.watchers === 0) {
        feeds.delete(key);
        held.stop();
      }
    };
  }, [queryClient, serverId, workspaceId]);
  return live;
}

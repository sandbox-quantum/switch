import { useQuery } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { rpc } from '@renderer/lib/ipc';
import { switchRoomsStore } from './switch-rooms-store';

/**
 * How much of this server Switch Console is holding: the agents onboarded
 * through it, the rooms it lists, and the messaging apps bridged to it.
 *
 * These count what is on screen elsewhere in the app, not what the server
 * reports about itself — the numbers have to agree with the sidebar and the
 * Your Agents / Your Rooms pages, or they answer a question nobody asked.
 */
export const ServerStatTiles = observer(function ServerStatTiles({
  serverId,
}: {
  serverId: string;
}) {
  // Shares the key every other bridge reader uses, so the list is already in
  // cache by the time this renders and the tile never fetches on its own.
  const bridgesQuery = useQuery({
    queryKey: ['remote-bridges', serverId],
    queryFn: () => rpc.switchServers.listRemoteBridges(serverId),
    enabled: !!serverId,
  });

  // The sidebar loads this too, but the page must not depend on the sidebar
  // having been mounted first to report a true number.
  useEffect(() => {
    if (!agentsStore.loaded) void agentsStore.load();
  }, []);

  return (
    <div className="grid grid-cols-3 gap-3">
      <StatTile
        label="Your Agents"
        value={agentsStore.loaded ? agentsStore.agentsOnServer(serverId).length : null}
      />
      <StatTile label="Your Rooms" value={switchRoomsStore.listedRoomsOnServer(serverId).length} />
      <StatTile label="Messaging apps" value={bridgesQuery.data?.length ?? null} />
    </div>
  );
});

/** A number that is not known yet reads as an em dash rather than as zero:
 * "no messaging apps" is a fact worth acting on and must not be faked while
 * the list is still loading. */
function StatTile({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="bg-card rounded-lg border border-border px-4 py-3">
      <p className="text-xs text-foreground-muted">{label}</p>
      <p className="mt-1 text-2xl text-foreground">{value ?? '—'}</p>
    </div>
  );
}

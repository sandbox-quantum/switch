import { useQuery } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { useCloudAgents } from '@renderer/features/cloud-agents/use-cloud-agents';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { failureText } from '@renderer/lib/errors/describe-failure';
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
  const cloud = useCloudAgents(serverId);
  const workspaceId = workspacesStore.idOnServerInScope(serverId);

  // Shares the key every other bridge reader uses, so the list is already in
  // cache by the time this renders and the tile never fetches on its own.
  const bridgesQuery = useQuery({
    queryKey: ['remote-bridges', workspaceId],
    queryFn: () => rpc.workspaces.listBridges(workspaceId as string),
    enabled: workspaceId !== null,
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
        // A server without cloud agents answers with none, which counts as zero;
        // a failed ask leaves the total unknown rather than reporting the local
        // agents alone as all of them.
        value={
          agentsStore.loaded && cloud.isSuccess
            ? agentsStore.agentsOnServer(serverId).length + (cloud.data?.length ?? 0)
            : null
        }
        failure={cloud.error ? failureText(cloud.error, 'Could not count cloud agents.') : null}
      />
      <StatTile
        label="Your Rooms"
        value={
          workspaceId === null
            ? null
            : switchRoomsStore.readableRoomsInWorkspace(workspaceId).length
        }
        failure={null}
      />
      <StatTile label="Messaging apps" value={bridgesQuery.data?.length ?? null} failure={null} />
    </div>
  );
});

/** A number that is not known yet reads as an em dash rather than as zero:
 * "no messaging apps" is a fact worth acting on and must not be faked while
 * the list is still loading. */
function StatTile({
  label,
  value,
  failure,
}: {
  label: string;
  value: number | null;
  failure: string | null;
}) {
  return (
    <div className="bg-card rounded-lg border border-border px-4 py-3">
      <p className="text-xs text-foreground-muted">{label}</p>
      <p className="mt-1 text-2xl text-foreground">{value ?? '—'}</p>
      {failure && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {failure}
        </p>
      )}
    </div>
  );
}

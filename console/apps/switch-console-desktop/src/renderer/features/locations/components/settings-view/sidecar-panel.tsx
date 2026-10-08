import { useQuery, useQueryClient } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { SectionLabel } from '@renderer/features/locations/components/main-panel/agent-page-section';
import { SidecarSettingsSection } from '@renderer/features/locations/components/settings-view/sections/sidecar-settings-section';
import { events, rpc } from '@renderer/lib/ipc';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { Spinner } from '@renderer/lib/ui/spinner';
import { agentMigrationChannel } from '@shared/events/agentMigrationEvents';

export const SidecarPanel = observer(function SidecarPanel() {
  const {
    params: { locationId, agentName },
  } = useParams('location');

  const { data: agents, isLoading } = useQuery({
    queryKey: ['location-agents', locationId],
    queryFn: () => rpc.agents.getAgents(locationId),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Spinner />
      </div>
    );
  }

  const agent = agentName ? (agents ?? []).find((a) => a.name === agentName) : (agents ?? [])[0];

  if (!agent) {
    return <p className="py-10 text-sm text-foreground-muted">No agent found for this location.</p>;
  }

  return (
    <section className="flex flex-col gap-4">
      <SectionLabel>Room watcher</SectionLabel>
      <ConsoleWatcher agentId={agent.id} />
    </section>
  );
});

/**
 * This Console's own watcher for the agent. A managed agent has none: Switch
 * runs it on a machine's agents controller.
 */
function ConsoleWatcher({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const runner = useQuery({
    queryKey: ['agent-runner', agentId],
    queryFn: () => rpc.agentMigration.getRunner(agentId),
  });
  useEffect(
    () =>
      events.on(agentMigrationChannel, (event) => {
        if (event.agentId === agentId)
          queryClient.setQueryData(['agent-runner', agentId], event.runner);
      }),
    [agentId, queryClient]
  );
  if (runner.data === 'managed')
    return (
      <p className="text-sm text-foreground-muted">
        Switch runs this agent on a machine’s agents controller, so this Console does not watch its
        rooms.
      </p>
    );
  return <SidecarSettingsSection agentId={agentId} />;
}

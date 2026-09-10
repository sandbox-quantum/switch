import { useQuery } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { SectionLabel } from '@renderer/features/locations/components/main-panel/agent-page-section';
import { SidecarSettingsSection } from '@renderer/features/locations/components/settings-view/sections/sidecar-settings-section';
import { rpc } from '@renderer/lib/ipc';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { Spinner } from '@renderer/lib/ui/spinner';

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
      <SectionLabel>SDK hosts</SectionLabel>
      <SidecarSettingsSection agentId={agent.id} />
    </section>
  );
});

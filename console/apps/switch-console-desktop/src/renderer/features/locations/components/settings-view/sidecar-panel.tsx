import { useQuery } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { SectionLabel } from '@renderer/features/locations/components/main-panel/agent-page-section';
import { SidecarSettingsSection } from '@renderer/features/locations/components/settings-view/sections/sidecar-settings-section';
import { rpc } from '@renderer/lib/ipc';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { Spinner } from '@renderer/lib/ui/spinner';

/**
 * The "Sidecar" tab for a remote location: the on-host process that keeps this
 * agent connected to Switch while Switch Console is closed. Scoped to the same agent
 * the Settings tab resolves (by definition name, else the first). Only shown for
 * remote locations — `ActiveLocation` gates the tab — so this just resolves the
 * agent and hands off to the section.
 */
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
      <SectionLabel>Sidecar</SectionLabel>
      <SidecarSettingsSection agentId={agent.id} />
    </section>
  );
});

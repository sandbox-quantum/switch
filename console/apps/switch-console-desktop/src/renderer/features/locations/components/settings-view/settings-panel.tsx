import { useQuery } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { AgentInstructionsSection } from '@renderer/features/locations/components/main-panel/agent-instructions-section';
import { SectionLabel } from '@renderer/features/locations/components/main-panel/agent-page-section';
import { AddressingPolicySettingsSection } from '@renderer/features/locations/components/settings-view/sections/addressing-policy-settings-section';
import { AgentAdvancedSettingsSection } from '@renderer/features/locations/components/settings-view/sections/agent-advanced-settings-section';
import { AutoApproveSettingsSection } from '@renderer/features/locations/components/settings-view/sections/auto-approve-settings-section';
import { AutoSessionSettingsSection } from '@renderer/features/locations/components/settings-view/sections/auto-session-settings-section';
import {
  asMounted,
  getLocationStore,
} from '@renderer/features/locations/stores/location-selectors';
import { rpc } from '@renderer/lib/ipc';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { Spinner } from '@renderer/lib/ui/spinner';

export const SettingsPanel = observer(function SettingsPanel() {
  const {
    params: { locationId, agentName },
  } = useParams('location');
  const mounted = asMounted(getLocationStore(locationId));

  // Resolve the specific agent the page is scoped to (by its definition name),
  // so its settings render through the normal per-agent sections. Switch Console has
  // no main/subagent split — every agent gets the same settings (CHOO-1440).
  const { data: agents } = useQuery({
    queryKey: ['location-agents', locationId],
    queryFn: () => rpc.agents.getAgents(locationId),
  });

  if (!mounted) {
    return (
      <div className="flex items-center justify-center py-10">
        <Spinner />
      </div>
    );
  }

  const agent = agentName ? (agents ?? []).find((a) => a.name === agentName) : (agents ?? [])[0];
  const agentId = agent?.id;

  return (
    <div className="flex flex-col gap-10">
      <AgentInstructionsSection locationId={locationId} agentId={agentId} />
      <section className="flex flex-col gap-6">
        <SectionLabel>General</SectionLabel>
        <AutoSessionSettingsSection locationId={locationId} agentId={agentId} />
        <AutoApproveSettingsSection locationId={locationId} agentId={agentId} />
        <AddressingPolicySettingsSection locationId={locationId} agentId={agentId} />
      </section>
      <AgentAdvancedSettingsSection locationId={locationId} agentId={agentId} />
    </div>
  );
});

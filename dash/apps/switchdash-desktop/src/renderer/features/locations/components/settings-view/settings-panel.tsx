import { useQuery } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { AddressingPolicySettingsSection } from '@renderer/features/locations/components/settings-view/sections/addressing-policy-settings-section';
import { AutoApproveSettingsSection } from '@renderer/features/locations/components/settings-view/sections/auto-approve-settings-section';
import { AutoSessionSettingsSection } from '@renderer/features/locations/components/settings-view/sections/auto-session-settings-section';
import { SubagentAutoSessionSettingsSection } from '@renderer/features/locations/components/settings-view/sections/subagent-auto-session-settings-section';
import {
  asMounted,
  getLocationStore,
} from '@renderer/features/locations/stores/location-selectors';
import { rpc } from '@renderer/lib/ipc';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { Spinner } from '@renderer/lib/ui/spinner';

export const SettingsPanel = observer(function SettingsPanel() {
  const {
    params: { locationId, subagentName },
  } = useParams('location');
  const mounted = asMounted(getLocationStore(locationId));

  // When scoped to a subagent, resolve its own agent row so its settings render
  // through the normal per-agent sections — a subagent is just an agent now
  // (CHOO-1440).
  const { data: agents } = useQuery({
    queryKey: ['location-agents', locationId],
    queryFn: () => rpc.agents.getAgents(locationId),
    enabled: !!subagentName,
  });

  if (!mounted) {
    return (
      <div className="flex items-center justify-center py-10">
        <Spinner />
      </div>
    );
  }

  if (subagentName) {
    // A subagent is an agent row now, so it gets the same per-agent settings.
    // Auto-session stays on the subagent watcher path (keyed by parent+name);
    // auto-approve is a plain per-agent DB flag on the subagent's own row.
    const subagent = (agents ?? []).find((a) => a.definitionName === subagentName);
    return (
      <div className="flex flex-col gap-6">
        <SubagentAutoSessionSettingsSection locationId={locationId} subagentName={subagentName} />
        {subagent && <AutoApproveSettingsSection locationId={locationId} agentId={subagent.id} />}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <AutoSessionSettingsSection locationId={locationId} />
      <AutoApproveSettingsSection locationId={locationId} />
      <AddressingPolicySettingsSection locationId={locationId} />
    </div>
  );
});

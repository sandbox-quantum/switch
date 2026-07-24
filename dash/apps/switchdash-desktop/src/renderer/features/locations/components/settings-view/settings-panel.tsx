import { observer } from 'mobx-react-lite';
import { AddressingPolicySettingsSection } from '@renderer/features/locations/components/settings-view/sections/addressing-policy-settings-section';
import { AutoApproveSettingsSection } from '@renderer/features/locations/components/settings-view/sections/auto-approve-settings-section';
import { AutoSessionSettingsSection } from '@renderer/features/locations/components/settings-view/sections/auto-session-settings-section';
import { SubagentAutoSessionSettingsSection } from '@renderer/features/locations/components/settings-view/sections/subagent-auto-session-settings-section';
import {
  asMounted,
  getLocationStore,
} from '@renderer/features/locations/stores/location-selectors';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { Spinner } from '@renderer/lib/ui/spinner';

export const SettingsPanel = observer(function SettingsPanel() {
  const {
    params: { locationId, subagentName },
  } = useParams('location');
  const mounted = asMounted(getLocationStore(locationId));

  if (!mounted) {
    return (
      <div className="flex items-center justify-center py-10">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {subagentName ? (
        <SubagentAutoSessionSettingsSection locationId={locationId} subagentName={subagentName} />
      ) : (
        <>
          <AutoSessionSettingsSection locationId={locationId} />
          <AutoApproveSettingsSection locationId={locationId} />
          <AddressingPolicySettingsSection locationId={locationId} />
        </>
      )}
    </div>
  );
});

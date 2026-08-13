import React, { useCallback } from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import {
  TELEMETRY_NEVER_SHARED,
  TELEMETRY_SHARED,
  TELEMETRY_SUMMARY,
} from '@renderer/features/telemetry/telemetry-copy';
import { Switch } from '@renderer/lib/ui/switch';
import { SettingRow } from './SettingRow';

const TelemetrySettingsCard: React.FC = () => {
  const {
    value: telemetry,
    update,
    isLoading: loading,
    isSaving: saving,
  } = useAppSettingsKey('telemetry');

  const enabled = telemetry?.enabled ?? true;

  const toggle = useCallback(
    (next: boolean) => {
      // Answering here counts as being asked, so a user who visits Settings
      // before the prompt appears is not asked again for a choice they made.
      update({ enabled: next, askedAt: telemetry?.askedAt ?? Date.now() });
    },
    [telemetry?.askedAt, update]
  );

  return (
    <SettingRow
      title="Share anonymous usage data"
      description={`${TELEMETRY_SUMMARY} Shared: ${TELEMETRY_SHARED.join(
        '; '
      ).toLowerCase()}. Never shared: ${TELEMETRY_NEVER_SHARED.join('; ').toLowerCase()}.`}
      control={<Switch checked={enabled} disabled={loading || saving} onCheckedChange={toggle} />}
    />
  );
};

export default TelemetrySettingsCard;

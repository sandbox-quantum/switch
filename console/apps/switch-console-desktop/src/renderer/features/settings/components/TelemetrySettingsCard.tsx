import React, { useCallback } from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import {
  TELEMETRY_NEVER_SHARED,
  TELEMETRY_SHARED,
  TELEMETRY_SUMMARY,
} from '@renderer/features/telemetry/telemetry-copy';
import { Switch } from '@renderer/lib/ui/switch';
import { SettingRow } from './SettingRow';

function joinAsSentence(items: string[]): string {
  return items.map((item, index) => (index === 0 ? item : item.toLowerCase())).join('; ');
}

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
      // Answering here counts as being asked, so a user who reaches Settings
      // before the prompt appears is not asked again for a choice they made.
      update({ enabled: next, askedAt: telemetry?.askedAt ?? Date.now() });
    },
    [telemetry?.askedAt, update]
  );

  return (
    <SettingRow
      title="Share anonymous usage data"
      description={
        <>
          <p>{TELEMETRY_SUMMARY}</p>
          <p className="mt-1">
            <span className="text-foreground-muted">Shared:</span>{' '}
            {joinAsSentence(TELEMETRY_SHARED)}.
          </p>
          <p>
            <span className="text-foreground-muted">Never shared:</span>{' '}
            {joinAsSentence(TELEMETRY_NEVER_SHARED)}.
          </p>
        </>
      }
      control={<Switch checked={enabled} disabled={loading || saving} onCheckedChange={toggle} />}
    />
  );
};

export default TelemetrySettingsCard;

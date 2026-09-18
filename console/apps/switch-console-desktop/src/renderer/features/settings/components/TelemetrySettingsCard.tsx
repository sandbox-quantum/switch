import React, { useCallback } from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import {
  TELEMETRY_ANONYMITY,
  TELEMETRY_DETAILS_LABEL,
  TELEMETRY_DETAILS_URL,
  TELEMETRY_SUMMARY,
} from '@renderer/features/telemetry/telemetry-copy';
import { openExternalUrl } from '@renderer/lib/open-external';
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
      // Answering here counts as being told, so a user who reaches Settings
      // before the notice appears is not shown it again afterwards.
      update({ enabled: next, askedAt: telemetry?.askedAt ?? Date.now() });
    },
    [telemetry?.askedAt, update]
  );

  return (
    <SettingRow
      title="Share usage data"
      description={
        <>
          <p>{TELEMETRY_SUMMARY}</p>
          <p className="mt-1">{TELEMETRY_ANONYMITY}</p>
          <button
            type="button"
            className="mt-1 cursor-pointer text-foreground-muted underline-offset-2 transition-colors hover:text-foreground hover:underline"
            onClick={() => {
              void openExternalUrl(TELEMETRY_DETAILS_URL, 'Could not open the telemetry document');
            }}
          >
            {TELEMETRY_DETAILS_LABEL}
          </button>
        </>
      }
      control={<Switch checked={enabled} disabled={loading || saving} onCheckedChange={toggle} />}
    />
  );
};

export default TelemetrySettingsCard;

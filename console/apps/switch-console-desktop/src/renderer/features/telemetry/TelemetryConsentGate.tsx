import React, { useCallback, useState } from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { TelemetryConsentDialog } from './TelemetryConsentDialog';

/**
 * Shows the consent prompt on first run and nothing thereafter.
 *
 * `askedAt` flips as soon as the answer is saved, but the local flag closes the
 * dialog on the answer itself rather than waiting for the settings query to
 * come back, so Continue does not leave the prompt sitting there.
 */
export function TelemetryConsentGate() {
  const { value, isLoading } = useAppSettingsKey('telemetry');
  const [answered, setAnswered] = useState(false);

  const onAnswered = useCallback(() => setAnswered(true), []);

  if (isLoading || !value || answered || value.askedAt !== null) return null;

  return <TelemetryConsentDialog onAnswered={onAnswered} />;
}

export default TelemetryConsentGate;

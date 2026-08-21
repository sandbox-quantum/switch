import type { TelemetrySettingKey } from '@main/core/telemetry/events';
import { trackEvent } from '@main/core/telemetry/telemetry-service';
import type { TelemetrySettings } from '@shared/core/app-settings';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { appSettingsService, type AppSettings, type AppSettingsKey } from './settings-service';

/**
 * Report an agreement to share usage data, and only an agreement.
 *
 * Emitted after the write, which is the only order that can work: the gate is
 * read immediately before every send, so anything emitted before it would be
 * blocked by the very setting it is reporting. That also makes a refusal
 * unreportable, which is the intended outcome rather than a limitation to work
 * around — measuring someone at the moment they asked not to be measured is not
 * a thing to do because it is technically possible.
 *
 * Nothing is reported when the answer has not changed, so re-saving an unrelated
 * part of the settings does not look like a fresh agreement.
 */
function reportConsent(previous: TelemetrySettings, next: TelemetrySettings): void {
  if (!next.enabled || next.askedAt === null) return;
  if (previous.enabled && previous.askedAt !== null) return;

  trackEvent('telemetry_consent_changed', {
    source: previous.askedAt === null ? 'first_run' : 'settings',
  });
}

export const appSettingsController = createRPCController({
  get: <T extends AppSettingsKey>(key: T): Promise<AppSettings[T]> => appSettingsService.get(key),

  getAll: (): Promise<AppSettings> => appSettingsService.getAll(),

  getWithMeta: <T extends AppSettingsKey>(
    key: T
  ): Promise<{
    value: AppSettings[T];
    defaults: AppSettings[T];
    overrides: Partial<AppSettings[T]>;
  }> => appSettingsService.getWithMeta(key),

  // The single place every setting change passes through, so the key is reported
  // here rather than from each screen that offers one. The key only — several of
  // these values are free text.
  update: async <T extends AppSettingsKey>(key: T, value: AppSettings[T]): Promise<void> => {
    // Read before the write, because telling a first agreement from a later one
    // needs the old value — but never allowed to fail the write. This is the one
    // setting where a telemetry read blocking the write would stop someone
    // turning telemetry OFF, which is the last thing reporting may ever do.
    const previousTelemetry =
      key === 'telemetry' ? await appSettingsService.get('telemetry').catch(() => null) : null;

    await appSettingsService.update(key, value);

    trackEvent('setting_changed', { setting_key: key as TelemetrySettingKey });
    if (previousTelemetry) reportConsent(previousTelemetry, value as TelemetrySettings);
  },

  reset: <T extends AppSettingsKey>(key: T): Promise<void> => appSettingsService.reset(key),

  resetField: <T extends AppSettingsKey>(key: T, field: string): Promise<void> =>
    appSettingsService.resetField(key, field as keyof AppSettings[T]),
});

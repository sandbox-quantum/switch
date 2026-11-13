import { isDeepStrictEqual } from 'node:util';
import type { TelemetrySettingKey } from '@main/core/telemetry/events';
import { launchInstallKind } from '@main/core/telemetry/launch-history';
import { trackBackgroundEvent, trackEvent } from '@main/core/telemetry/telemetry-service';
import { log } from '@main/lib/logger';
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
 *
 * Waits for this launch's kind, which boot records without waiting, so the
 * first-run notice can be answered first. Never rejects.
 */
async function reportConsent(previous: TelemetrySettings, next: TelemetrySettings): Promise<void> {
  if (!next.enabled || next.askedAt === null) return;
  if (previous.enabled && previous.askedAt !== null) return;

  const properties = {
    source: previous.askedAt === null ? ('first_run' as const) : ('settings' as const),
    install_kind: await launchInstallKind(),
  };
  // The first-run notice records the answer as it is shown, which nobody did;
  // turning sharing on in Settings is someone using the app.
  if (properties.source === 'first_run') {
    trackBackgroundEvent('telemetry_consent_changed', properties);
  } else {
    trackEvent('telemetry_consent_changed', properties);
  }
}

/**
 * Settings the app writes as it goes rather than a person setting them, which
 * `setting_changed` would otherwise count as people changing them: the
 * first-run notice records the usage-data answer the moment it is shown, and
 * the first run keeps its own progress in `onboarding`.
 */
const UNREPORTED_SETTINGS: ReadonlySet<AppSettingsKey> = new Set(['telemetry', 'onboarding']);

function isReportedSetting(key: AppSettingsKey): key is TelemetrySettingKey {
  return !UNREPORTED_SETTINGS.has(key);
}

/** A value that was not read: the setting is not reported, or the read failed. */
const UNREAD = Symbol('unread');

/**
 * The value a reported setting holds before a write, to tell a change from a
 * write of what was already there. `UNREAD` for a setting that is not reported,
 * and for one that cannot be read: telemetry never gets to fail a write, and a
 * value nobody read is no evidence of a change.
 */
async function valueBefore(key: AppSettingsKey): Promise<unknown> {
  if (!isReportedSetting(key)) return UNREAD;
  return appSettingsService.get(key).catch((error: unknown) => {
    log.warn(
      'telemetry: could not read a setting before writing it, so its change is not reported',
      {
        error,
      }
    );
    return UNREAD;
  });
}

/**
 * Report a setting whose stored value a write changed. Read back rather than
 * compared with what was asked for, since the store fills in defaults. Never
 * rejects.
 */
async function reportChange(key: AppSettingsKey, before: unknown): Promise<void> {
  if (!isReportedSetting(key) || before === UNREAD) return;
  try {
    if (isDeepStrictEqual(before, await appSettingsService.get(key))) return;
  } catch (error) {
    log.warn('telemetry: could not read a setting back, so its change is not reported', {
      error,
    });
    return;
  }
  trackEvent('setting_changed', { setting_key: key });
}

export const appSettingsController = createRPCController({
  getWithMeta: <T extends AppSettingsKey>(
    key: T
  ): Promise<{
    value: AppSettings[T];
    defaults: AppSettings[T];
    overrides: Partial<AppSettings[T]>;
  }> => appSettingsService.getWithMeta(key),

  // Every setting change passes through this controller, so the key is reported
  // here rather than from each screen that offers one. The key only — several of
  // these values are free text.
  update: async <T extends AppSettingsKey>(key: T, value: AppSettings[T]): Promise<void> => {
    // Read before the write, because telling a first agreement from a later one
    // needs the old value — but never allowed to fail the write. This is the one
    // setting where a telemetry read blocking the write would stop someone
    // turning telemetry OFF, which is the last thing reporting may ever do.
    const previousTelemetry =
      key === 'telemetry' ? await appSettingsService.get('telemetry').catch(() => null) : null;
    const before = await valueBefore(key);

    await appSettingsService.update(key, value);

    void reportChange(key, before);
    if (previousTelemetry) void reportConsent(previousTelemetry, value as TelemetrySettings);
  },

  /**
   * Put a whole settings group, or one field of it, back to its default.
   *
   * Reported under the same key as the change that set it, because reverting is
   * a person changing a setting: counting only the change would make every
   * preference somebody tried and undid look like one that stuck. The Reset
   * control sits in the same rows the editors do, so the two have to be
   * comparable.
   *
   * The usage-data setting has no Reset control, and a reset is never reported
   * as consent.
   */
  reset: async <T extends AppSettingsKey>(key: T): Promise<void> => {
    const before = await valueBefore(key);
    await appSettingsService.reset(key);
    void reportChange(key, before);
  },

  resetField: async <T extends AppSettingsKey>(key: T, field: string): Promise<void> => {
    const before = await valueBefore(key);
    await appSettingsService.resetField(key, field as keyof AppSettings[T]);
    void reportChange(key, before);
  },
});

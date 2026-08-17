import { randomUUID } from 'node:crypto';
import { release } from 'node:os';
import { resolveAppVersion } from '@main/core/app/utils';
import { log } from '@main/lib/logger';
import { buildAmplitudeEvent, postAmplitudeEvent, TelemetrySendError } from './amplitude-client';
import { resolveTelemetryConfig, type TelemetryDisabledReason } from './config';
import { isTelemetryAllowed } from './consent';
import type { TelemetryEventMap, TelemetryEventName } from './events';
import { getInstallId } from './install-id';

const OS_NAMES: Record<string, string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
};

class TelemetryService {
  private reportedDisabled = new Set<TelemetryDisabledReason>();
  private appVersion: Promise<string> | null = null;

  /**
   * Send one event, if this build can send and the user has said yes.
   *
   * The consent gate is read here, on every event, and never cached: revoking
   * consent has to stop the next event, not the next launch. Both refusals
   * return before anything is built or opened, so consent off means no request
   * is made at all.
   */
  async track<K extends TelemetryEventName>(
    name: K,
    properties: TelemetryEventMap[K]
  ): Promise<void> {
    const resolution = resolveTelemetryConfig();
    if (!resolution.enabled) {
      this.reportDisabled(resolution.reason);
      return;
    }

    if (!(await isTelemetryAllowed())) return;

    const event = buildAmplitudeEvent(name, properties, {
      installId: await getInstallId(),
      appVersion: await this.resolveVersion(),
      osName: OS_NAMES[process.platform] ?? 'Other',
      osVersion: release(),
      build: resolution.config.build,
      time: Date.now(),
      insertId: randomUUID(),
    });

    await postAmplitudeEvent(event, resolution.config);
  }

  private resolveVersion(): Promise<string> {
    this.appVersion ??= resolveAppVersion();
    return this.appVersion;
  }

  /**
   * Say once, per reason, that this build reports nothing — a build that is
   * silent should be able to explain itself. A dev run is expected; a packaged
   * build with no key usually means someone meant to supply one.
   */
  private reportDisabled(reason: TelemetryDisabledReason): void {
    if (this.reportedDisabled.has(reason)) return;
    this.reportedDisabled.add(reason);

    const line = 'telemetry: not sending';
    const context = { event: 'telemetry_disabled', reason };
    if (reason === 'dev_build') log.info(line, context);
    else log.warn(line, context);
  }
}

export const telemetryService = new TelemetryService();

/**
 * Record that something happened, and get on with the work.
 *
 * This is what call sites use: it never throws, never rejects, and is never
 * awaited, so no user-facing operation can be delayed or failed by telemetry.
 * A send that does not arrive is logged with a code and dropped.
 */
export function trackEvent<K extends TelemetryEventName>(
  name: K,
  properties: TelemetryEventMap[K]
): void {
  void telemetryService.track(name, properties).catch((error: unknown) => {
    log.warn('telemetry: event not sent', {
      event: 'telemetry_send_failed',
      telemetryEvent: name,
      errorCode: error instanceof TelemetrySendError ? error.code : 'unexpected',
      error: String(error),
    });
  });
}

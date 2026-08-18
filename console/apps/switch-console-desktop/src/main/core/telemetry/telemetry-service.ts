import { release } from 'node:os';
import { resolveAppVersion } from '@main/core/app/utils';
import { log } from '@main/lib/logger';
import { resolveTelemetryConfig, type TelemetryDisabledReason } from './config';
import { isTelemetryAllowed } from './consent';
import type { TelemetryEventMap, TelemetryEventName } from './events';
import { getInstallId } from './install-id';
import { buildOtlpPayload, postTelemetryEvent, TelemetrySendError } from './relay-client';

/** OpenTelemetry's names for what `process.platform` calls darwin/win32/linux. */
const OS_TYPES: Record<string, string> = {
  darwin: 'darwin',
  win32: 'windows',
  linux: 'linux',
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

    // Before the gate, which reads the database: the event happened now, not
    // whenever the reads that describe it finish.
    const timeMs = Date.now();

    if (!(await isTelemetryAllowed())) return;

    const payload = buildOtlpPayload(name, properties, {
      clientId: await getInstallId(),
      appVersion: await this.resolveVersion(),
      osType: OS_TYPES[process.platform] ?? 'other',
      osVersion: release(),
      build: resolution.config.build,
      timeMs,
    });

    await postTelemetryEvent(payload, resolution.config);
  }

  private resolveVersion(): Promise<string> {
    this.appVersion ??= resolveAppVersion();
    return this.appVersion;
  }

  /**
   * Say once, per reason, that this build reports nothing — a build that is
   * silent should be able to explain itself. `info` rather than `warn`: a dev
   * run not reporting is the expected state, not a degraded one.
   */
  private reportDisabled(reason: TelemetryDisabledReason): void {
    if (this.reportedDisabled.has(reason)) return;
    this.reportedDisabled.add(reason);

    log.info('telemetry: not sending', { event: 'telemetry_disabled', reason });
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

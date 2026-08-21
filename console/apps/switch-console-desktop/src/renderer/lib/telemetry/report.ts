import { rpc } from '@renderer/lib/ipc';
import type { RendererTelemetryEvents } from '@shared/core/telemetry/renderer-events';

/**
 * Report something the interface observed.
 *
 * Fire-and-forget, like its counterpart in the main process: it is never
 * awaited and never throws, so nothing a user is doing can be slowed or broken
 * by reporting it. The rejection is swallowed on purpose — there is no failure
 * here a screen could act on, and the main process logs the reason.
 *
 * What may be reported, and which values each event accepts, is decided in the
 * main process. This is only the way to ask.
 */
export function report<K extends keyof RendererTelemetryEvents>(
  name: K,
  properties: RendererTelemetryEvents[K]
): void {
  void rpc.telemetry.track({ name, properties }).catch(() => {});
}

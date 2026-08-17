import type { TelemetryConfig } from './config';
import type { TelemetryEventMap, TelemetryEventName } from './events';

const SEND_TIMEOUT_MS = 5_000;

/**
 * Suppresses Amplitude's reverse lookup of a location from the IP the request
 * arrived on. Amplitude geolocates the sender unless the payload names an
 * address, so naming an unroutable one is how the lookup is declined. It does
 * not hide the source address from Amplitude at the network level — nothing
 * sent from the user's own machine can — it stops the address becoming a
 * recorded property of the user.
 */
const UNROUTABLE_IP = '0.0.0.0';

export type TelemetrySendErrorCode = 'timeout' | 'network' | 'http_status' | 'unexpected';

export class TelemetrySendError extends Error {
  constructor(
    readonly code: TelemetrySendErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'TelemetrySendError';
  }
}

/** The ambient fields every event carries, resolved once per send. */
export type TelemetryContext = {
  installId: string;
  appVersion: string;
  osName: string;
  osVersion: string;
  build: TelemetryConfig['build'];
  time: number;
  insertId: string;
};

export function buildAmplitudeEvent<K extends TelemetryEventName>(
  name: K,
  properties: TelemetryEventMap[K],
  context: TelemetryContext
): Record<string, unknown> {
  return {
    // Amplitude's per-user key. `user_id` is deliberately never set: there is no
    // account to tie an event to, and the install id is all we are entitled to.
    device_id: context.installId,
    event_type: name,
    time: context.time,
    insert_id: context.insertId,
    app_version: context.appVersion,
    os_name: context.osName,
    os_version: context.osVersion,
    platform: 'Electron',
    ip: UNROUTABLE_IP,
    event_properties: { ...properties, build: context.build },
  };
}

/**
 * Post one event to Amplitude's HTTP V2 API.
 *
 * A direct `fetch` rather than an Amplitude SDK, deliberately: an SDK brings its
 * own queueing, retry and identity behaviour, and the promise made to the user
 * is about exactly what leaves the machine and when. Everything sent is visible
 * in this file.
 *
 * Throws {@link TelemetrySendError} on any failure. There is no retry — an event
 * lost to a flaky network is lost, which is the right trade for something the
 * user never sees and must never wait on.
 */
export async function postAmplitudeEvent(
  event: Record<string, unknown>,
  config: TelemetryConfig
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: config.apiKey, events: [event] }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    throw new TelemetrySendError(timedOut ? 'timeout' : 'network', String(error));
  }

  if (!response.ok) {
    throw new TelemetrySendError('http_status', `Amplitude responded ${response.status}`);
  }
}

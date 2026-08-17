import type { TelemetryConfig } from './config';
import {
  TELEMETRY_EVENT_PROPERTIES,
  type TelemetryEventMap,
  type TelemetryEventName,
} from './events';

const SEND_TIMEOUT_MS = 5_000;

/**
 * Sent in place of whatever the HTTP client would otherwise volunteer.
 *
 * Amplitude parses the user agent of a request into device and OS properties of
 * the event, so leaving it to the runtime would put a field on every event that
 * this file does not account for — and the point of sending by hand is that
 * everything sent is visible here.
 */
const USER_AGENT = 'switch-console';

/**
 * Sent so that Amplitude resolves a location from a reserved address rather
 * than from the one the request arrived on, which it geolocates by default into
 * country, region, city and DMA properties of the event.
 *
 * Know what this is and is not. Amplitude documents no sentinel value for
 * declining the lookup — their supported route is to have IP and location
 * dropped at ingestion, which is a support request, not a payload field. This
 * works because no geolocation database resolves a reserved address, so the
 * lookup finds nothing; it is a convention, not a guarantee, and it should be
 * confirmed against really ingested events rather than assumed. It also does
 * not hide the source address from Amplitude at the network level — nothing
 * sent from the user's own machine can.
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

/**
 * Keep only the properties the catalogue names for this event.
 *
 * The types make an unexpected property a compile error at every call site that
 * passes an object literal — but not through a spread, which is how a field
 * added to some internal shape for an unrelated reason could otherwise arrive
 * in a payload. This is where that stops being a convention.
 */
function allowedProperties<K extends TelemetryEventName>(
  name: K,
  properties: TelemetryEventMap[K]
): Record<string, unknown> {
  const allowed: Record<string, unknown> = {};
  for (const key of TELEMETRY_EVENT_PROPERTIES[name]) {
    allowed[key] = (properties as Record<string, unknown>)[key];
  }
  return allowed;
}

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
    event_properties: { ...allowedProperties(name, properties), build: context.build },
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
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
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

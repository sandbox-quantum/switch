import type { TelemetryConfig } from './config';
import {
  TELEMETRY_EVENT_PROPERTIES,
  type TelemetryEventMap,
  type TelemetryEventName,
} from './events';

const SEND_TIMEOUT_MS = 10_000;

/**
 * Events from every product share one Amplitude project, so a bare
 * `session_started` would sit next to another product's and nobody could tell
 * whose it was.
 */
const EVENT_NAME_PREFIX = 'switch_console';

/** What the app calls itself to the relay, and to Datadog beyond it. */
const SERVICE_NAME = 'switch-console';

/**
 * The relay reads the event's name from this attribute.
 *
 * It looks in three places — the OTLP `event_name` field, then this attribute,
 * then `event_type` — and this is the one that does not depend on the record
 * carrying a field only newer OTLP builds know about. A record it cannot name
 * is dropped, and the response is still a 200, so the choice matters more than
 * it looks.
 */
const EVENT_NAME_ATTRIBUTE = 'event.name';

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

/** The ambient facts every event carries, resolved once per send. */
export type TelemetryContext = {
  /**
   * The relay's guard: a canonical UUID identifying this installation, which it
   * requires on every payload and forwards as Amplitude's device id. A payload
   * without one is dropped in silence.
   */
  clientId: string;
  appVersion: string;
  osType: string;
  osVersion: string;
  build: TelemetryConfig['build'];
  timeMs: number;
};

type OtlpAttribute = { key: string; value: { stringValue: string } };

/** Everything sent is a string; nothing in the catalogue is anything else. */
function attributes(values: Record<string, string>): OtlpAttribute[] {
  return Object.entries(values).map(([key, value]) => ({ key, value: { stringValue: value } }));
}

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
): Record<string, string> {
  const allowed: Record<string, string> = {};
  for (const key of TELEMETRY_EVENT_PROPERTIES[name]) {
    allowed[key] = String((properties as Record<string, unknown>)[key]);
  }
  return allowed;
}

/**
 * One event, as a single OTLP log record.
 *
 * The relay turns this into an Amplitude event — the name becomes `event_type`,
 * the client id becomes `device_id`, and the log attributes become
 * `event_properties` — and forwards the same record to Datadog. Both
 * destinations see exactly what is built here and nothing else.
 */
export function buildOtlpPayload<K extends TelemetryEventName>(
  name: K,
  properties: TelemetryEventMap[K],
  context: TelemetryContext
): Record<string, unknown> {
  const timeNano = String(BigInt(context.timeMs) * 1_000_000n);

  return {
    resourceLogs: [
      {
        resource: {
          attributes: attributes({
            'service.name': SERVICE_NAME,
            'service.version': context.appVersion,
            'flint.client_id': context.clientId,
            'os.type': context.osType,
            'os.version': context.osVersion,
          }),
        },
        scopeLogs: [
          {
            scope: { name: SERVICE_NAME, version: context.appVersion },
            logRecords: [
              {
                timeUnixNano: timeNano,
                observedTimeUnixNano: timeNano,
                severityNumber: 9,
                severityText: 'INFO',
                attributes: attributes({
                  [EVENT_NAME_ATTRIBUTE]: `${EVENT_NAME_PREFIX}.${name}`,
                  ...allowedProperties(name, properties),
                  build: context.build,
                }),
              },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * Post one event to the relay.
 *
 * A direct `fetch` of hand-built OTLP rather than the OpenTelemetry SDK,
 * deliberately: what leaves the machine, and when, is the promise being made to
 * the user, and an SDK brings its own batching, retry and identity behaviour.
 * Everything sent is visible in this file. The cost is that the wire format is
 * ours to keep correct, which is what the tests are for.
 *
 * Throws {@link TelemetrySendError} on any failure. There is no retry — an event
 * lost to a flaky network is lost, which is the right trade for something the
 * user never sees and must never wait on.
 *
 * A 200 does not prove the event arrived. The relay drops a payload it cannot
 * name or whose client id fails its guard, and answers 200 either way.
 */
export async function postTelemetryEvent(
  payload: Record<string, unknown>,
  config: TelemetryConfig
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    throw new TelemetrySendError(timedOut ? 'timeout' : 'network', String(error));
  }

  if (!response.ok) {
    throw new TelemetrySendError('http_status', `Relay responded ${response.status}`);
  }
}

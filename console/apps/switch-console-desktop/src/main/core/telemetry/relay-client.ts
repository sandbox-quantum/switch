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
 * Sent in place of whatever the HTTP client would otherwise volunteer, so that
 * everything leaving the machine is chosen here — and so the relay's operators
 * can see which client their traffic is coming from.
 */
const USER_AGENT = SERVICE_NAME;

/**
 * The name is sent twice, in both of the places the relay looks.
 *
 * `eventName` is the OTLP log record's own field and the first thing the
 * relay's exporter reads — it is what the reference client sends, and the only
 * form older builds of that exporter understand at all. The attribute is its
 * documented fallback, and is separately what the relay's "drop records with no
 * name" filter tests.
 *
 * Sending one was not enough: a record naming itself only in the attribute
 * survives the filter and reaches the exporter with an empty name field, which
 * an exporter without the fallback discards. Every step of that answers 200, so
 * nothing here would ever have seen it happen.
 */
const EVENT_NAME_ATTRIBUTE = 'event.name';

export type TelemetrySendErrorCode =
  | 'timeout'
  | 'network'
  | 'http_status'
  | 'rejected'
  | 'unexpected';

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
    const value = (properties as Record<string, unknown>)[key];
    // Coercing a missing property would send the string "undefined" as though
    // it were data. Refusing means the event is dropped and the mismatch is
    // logged, which is the lesser of the two.
    if (typeof value !== 'string') {
      throw new TelemetrySendError(
        'unexpected',
        `Event ${name} is missing the catalogued property ${key}`
      );
    }
    allowed[key] = value;
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
  const eventName = `${EVENT_NAME_PREFIX}.${name}`;

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
                eventName,
                severityNumber: 9,
                severityText: 'INFO',
                // The relay forwards the same record to Datadog, which reads
                // the body as the log message. Without one every event is a
                // blank line there. The name is already leaving the machine as
                // an attribute, so repeating it here discloses nothing new.
                body: { stringValue: eventName },
                attributes: attributes({
                  [EVENT_NAME_ATTRIBUTE]: eventName,
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
 * name or whose client id fails its guard, and answers 200 either way — so the
 * partial-success body is read for the cases where it does say something.
 */
export async function postTelemetryEvent(
  payload: Record<string, unknown>,
  config: TelemetryConfig
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
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

  await reportRejection(response);
}

/**
 * OTLP allows a 200 to carry a count of records the receiver would not take.
 *
 * Today's relay drops on a failed guard without reporting one, so this will
 * usually be empty — but it is the only channel through which a rejection can
 * ever become visible from here, and reading it costs one parse of a very small
 * body. A response that is not JSON at all is not worth a second failure.
 */
async function reportRejection(response: Response): Promise<void> {
  const body = (await response.json().catch(() => null)) as {
    partialSuccess?: { rejectedLogRecords?: string | number; errorMessage?: string };
  } | null;

  const rejected = Number(body?.partialSuccess?.rejectedLogRecords ?? 0);
  if (!rejected) return;

  throw new TelemetrySendError(
    'rejected',
    `Relay rejected ${rejected} record(s): ${body?.partialSuccess?.errorMessage ?? 'no reason given'}`
  );
}

import { describe, expect, it } from 'vitest';
import { TELEMETRY_EVENT_PROPERTIES, type TelemetryEventName } from './events';
import { buildOtlpPayload, type TelemetryContext } from './relay-client';

/**
 * Every catalogued event can actually be sent.
 *
 * The type map and the runtime allow-list are two lists that have to agree, and
 * nothing else checks that they do at the level that matters: a property named
 * in one and absent from the other only fails when a real user performs that
 * action, at which point the event is dropped and a line appears in a log
 * nobody is reading. This walks the whole catalogue instead.
 *
 * It is deliberately mechanical. It cannot tell you an event fires at the right
 * moment — only that if it fires, it can be built and carries nothing but what
 * it declared. Nor can it see the type map: `TelemetryEventMap` is erased by the
 * time this runs, and the samples below are derived from the allow-list, so a
 * property declared in one and missing from the other is invisible from here.
 * `_everyPropertyIsAllowListed` in `./events` is what catches that, at compile
 * time.
 */

const CONTEXT: TelemetryContext = {
  clientId: '11111111-2222-4333-8444-555555555555',
  appVersion: '1.2.3',
  osType: 'darwin',
  osVersion: '24.3.0',
  build: 'stable',
  timeMs: 1_700_000_000_000,
};

/**
 * A value of the right kind for each property, chosen by name.
 *
 * Counts are numbers, the yes/no properties are booleans, and everything else
 * is a placeholder string — the builder does not check a string against the
 * catalogue's unions, so any string exercises the same path.
 */
function sampleFor(property: string): string | number | boolean {
  if (property.endsWith('_count')) return 3;
  if (
    property.startsWith('has_') ||
    property.startsWith('was_') ||
    property.startsWith('picked_') ||
    property === 'connected_to_room' ||
    property === 'delete_in_switch' ||
    property === 'resolved' ||
    property === 'cold_start'
  ) {
    return true;
  }
  return 'sample';
}

const EVENT_NAMES = Object.keys(TELEMETRY_EVENT_PROPERTIES) as TelemetryEventName[];

function sampleEvent(name: TelemetryEventName): Record<string, string | number | boolean> {
  return Object.fromEntries(TELEMETRY_EVENT_PROPERTIES[name].map((p) => [p, sampleFor(p)]));
}

type LogRecord = {
  eventName: string;
  attributes: { key: string; value: { stringValue?: string } }[];
};

/** The one log record a payload carries. */
function recordOf(payload: Record<string, unknown>): LogRecord {
  const resourceLogs = payload.resourceLogs as [{ scopeLogs: [{ logRecords: [LogRecord] }] }];
  return resourceLogs[0].scopeLogs[0].logRecords[0];
}

describe('the catalogue as a whole', () => {
  it('has at least the events this work was meant to add', () => {
    // A floor, not an assertion about the exact number: the point is that the
    // catalogue did not silently shrink.
    expect(EVENT_NAMES.length).toBeGreaterThanOrEqual(35);
  });

  it.each(EVENT_NAMES)('builds a payload for %s', (name) => {
    const payload = buildOtlpPayload(name, sampleEvent(name) as never, CONTEXT);

    expect(JSON.stringify(payload)).toContain(`switch_console.${name}`);
  });

  it.each(EVENT_NAMES)('sends nothing beyond what %s declares', (name) => {
    const smuggled = {
      ...sampleEvent(name),
      working_dir: '/Users/someone/secret-project',
      error_message: 'ENOENT: no such file',
      room_name: 'incident-response',
    };

    const payload = buildOtlpPayload(name, smuggled as never, CONTEXT);
    const wire = JSON.stringify(payload);

    expect(wire).not.toContain('secret-project');
    expect(wire).not.toContain('ENOENT');
    expect(wire).not.toContain('incident-response');
    // The three above are the kinds of thing that must never leak, anywhere in
    // the payload. This is the check that generalises: the record carries the
    // event's own properties, the name it is filed under and the build that sent
    // it, and a search for words a test happened to think of would pass whatever
    // else arrived alongside them.
    const carried = recordOf(payload).attributes.map((a) => a.key);
    expect(carried.sort()).toEqual(
      [...TELEMETRY_EVENT_PROPERTIES[name], 'build', 'event.name'].sort()
    );
  });

  it.each(EVENT_NAMES)('refuses to send %s with a property missing', (name) => {
    const properties = sampleEvent(name);
    const declared = TELEMETRY_EVENT_PROPERTIES[name];
    if (declared.length === 0) return;

    delete properties[declared[0]];

    expect(() => buildOtlpPayload(name, properties as never, CONTEXT)).toThrow(
      /missing the catalogued property/
    );
  });

  it('names every event under this product, in both the places the relay looks', () => {
    // One project holds every product's events, so the prefix is what says whose
    // this is. And the name goes in both the record's own field and an attribute:
    // the exporter reads the first, the relay's "records with no name" filter
    // tests the second, and a record carrying only one of them is dropped
    // somewhere along a path where every step answers 200.
    for (const name of EVENT_NAMES) {
      const record = recordOf(buildOtlpPayload(name, sampleEvent(name) as never, CONTEXT));
      const named = `switch_console.${name}`;

      expect(record.eventName).toBe(named);
      expect(record.attributes.find((a) => a.key === 'event.name')?.value.stringValue).toBe(named);
    }
  });

  it('uses snake_case for every event name and every property', () => {
    // The catalogue's own convention, and the one thing a dashboard cannot
    // paper over once half the events break it.
    const snake = /^[a-z][a-z0-9_]*$/;
    for (const name of EVENT_NAMES) {
      expect(name).toMatch(snake);
      for (const property of TELEMETRY_EVENT_PROPERTIES[name]) {
        expect(property).toMatch(snake);
      }
    }
  });
});

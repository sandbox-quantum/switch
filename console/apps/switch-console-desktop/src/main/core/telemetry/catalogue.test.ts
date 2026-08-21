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
 * it declared.
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

  it('names every event under this product, so one project can hold them all', () => {
    for (const name of EVENT_NAMES) {
      const payload = buildOtlpPayload(name, sampleEvent(name) as never, CONTEXT);
      const record = (
        payload.resourceLogs as [{ scopeLogs: [{ logRecords: [{ eventName: string }] }] }]
      )[0].scopeLogs[0].logRecords[0];
      expect(record.eventName).toBe(`switch_console.${name}`);
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

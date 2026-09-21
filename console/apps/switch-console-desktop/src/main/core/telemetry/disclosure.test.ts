import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TELEMETRY_EVENT_PROPERTIES, type TelemetryEventName } from './events';

/**
 * The disclosure and the catalogue say the same thing.
 *
 * `console/AGENTS.md` makes widening what is sent a consent decision and names
 * two artefacts that must move with it: the summary in `telemetry-copy.ts` and
 * the field-by-field list in `docs/TELEMETRY.md`, which is what the link in the
 * consent dialog opens. Until this test there was nothing holding the second to
 * the code — and it had already drifted twice, naming a failure code that is
 * never sent and omitting one that is.
 *
 * Drift here is worse than an ordinary stale comment. The document is the
 * specific thing a user is pointed at to decide whether to turn telemetry on,
 * so a value missing from it is a value nobody agreed to send.
 *
 * What this can and cannot see: it compares names, not meanings. It cannot tell
 * you the prose around a table is still true, and it deliberately skips a union
 * that is built from another type (`InstallMethod | 'unspecified'`,
 * `Exclude<…>`) rather than written out as literals — resolving those needs the
 * type checker, which is gone by the time a test runs. Those are read by a
 * person; everything written as a literal is read by this.
 */

// …/src/main/core/telemetry → the repo root that holds `docs/`.
const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  '..'
);

const DISCLOSURE = readFileSync(join(REPO_ROOT, 'docs', 'TELEMETRY.md'), 'utf8');
const CATALOGUE_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'events.ts'),
  'utf8'
);

const EVENT_SECTION_HEADING = '### 3.3 Every event and its fields';

/**
 * Each event's row in the document, keyed by event name.
 *
 * Read from the per-event section alone. The section above it tabulates the
 * dimensions several events share (`outcome`, `agent_type`) in rows of the same
 * shape, and taking those for events would make the reverse check below —
 * "every row is an event" — unreadable.
 */
function eventRows(): Map<string, string> {
  const start = DISCLOSURE.indexOf(EVENT_SECTION_HEADING);
  if (start === -1) throw new Error(`docs/TELEMETRY.md no longer has "${EVENT_SECTION_HEADING}"`);
  const rest = DISCLOSURE.slice(start + EVENT_SECTION_HEADING.length);
  const end = rest.indexOf('\n### ');

  return new Map(
    (end === -1 ? rest : rest.slice(0, end))
      .split('\n')
      .map((line) => /^\|\s*`([a-z][a-z0-9_]*)`\s*\|(.*)\|\s*$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => [match[1]!, match[2]!])
  );
}

const ROWS = eventRows();

const EVENT_NAMES = Object.keys(TELEMETRY_EVENT_PROPERTIES) as TelemetryEventName[];

/** A backticked token, so `error` does not match the word in a sentence. */
function mentions(text: string, token: string): boolean {
  return text.includes(`\`${token}\``);
}

/** Comments are stripped first: an apostrophe in prose reads as a string quote. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** True when a union is written out as string literals and nothing else. */
function isLiteralUnion(body: string): boolean {
  return body.length > 0 && /^\s*\|?\s*'[^']*'(\s*\|\s*'[^']*')*\s*$/.test(body);
}

function literalsOf(body: string): string[] {
  return [...body.matchAll(/'([^']*)'/g)].map((match) => match[1]!);
}

/**
 * Every set of values the catalogue spells out, as `label → values`.
 *
 * Both shapes it is written in: a named `export type Telemetry… = 'a' | 'b'`,
 * and a union written inline on a property of `TelemetryEventMap`.
 */
function enumeratedValueSets(): Array<{ label: string; values: string[] }> {
  const source = withoutComments(CATALOGUE_SOURCE);
  const sets: Array<{ label: string; values: string[] }> = [];

  for (const match of source.matchAll(/export type (\w+) =([^;]*);/g)) {
    const body = match[2]!.trim();
    if (!isLiteralUnion(body)) continue;
    sets.push({ label: match[1]!, values: literalsOf(body) });
  }

  const mapStart = source.indexOf('export type TelemetryEventMap');
  const mapEnd = source.indexOf('export const TELEMETRY_EVENT_PROPERTIES');
  const map = source.slice(mapStart, mapEnd);
  for (const match of map.matchAll(/^\s+(\w+):([^;\n]*(?:\n[^;\n]*)*?);/gm)) {
    const body = match[2]!.trim();
    if (!isLiteralUnion(body)) continue;
    sets.push({ label: `${match[1]!} (inline)`, values: literalsOf(body) });
  }

  return sets;
}

const VALUE_SETS = enumeratedValueSets();

describe('what the consent dialog links to', () => {
  it('parsed the catalogue rather than silently matching nothing', () => {
    // Every check below is "no mismatches found", which is also what a broken
    // parse returns. These floors are what tells the two apart.
    expect(ROWS.size).toBe(EVENT_NAMES.length);
    expect(VALUE_SETS.length).toBeGreaterThanOrEqual(10);
  });

  it.each(EVENT_NAMES)('discloses %s', (name) => {
    expect(ROWS.get(name)).toBeDefined();
  });

  it.each(EVENT_NAMES)('names every property %s carries', (name) => {
    const row = ROWS.get(name) ?? '';
    const undisclosed = TELEMETRY_EVENT_PROPERTIES[name].filter(
      (property) => !mentions(row, property)
    );

    expect(undisclosed).toEqual([]);
  });

  it.each(VALUE_SETS)('names every value of $label', ({ values }) => {
    // Somewhere in the document rather than in a particular row: a set shared by
    // several events is written out once and referred to from the others.
    const undisclosed = values.filter((value) => !mentions(DISCLOSURE, value));

    expect(undisclosed).toEqual([]);
  });

  it('describes no event the catalogue does not have', () => {
    // The reverse direction, and the one that catches a removed event: a row
    // left behind promises something is sent that no longer is.
    const unknown = [...ROWS.keys()].filter(
      (name) => !EVENT_NAMES.includes(name as TelemetryEventName)
    );

    expect(unknown).toEqual([]);
  });
});

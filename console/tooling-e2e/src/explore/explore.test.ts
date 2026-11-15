import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { durationMs, exploreTimeLimitFrom, loadEnv } from '../core/env.ts';
import { ACTION_GENERATORS, PROPERTIES } from './properties.ts';
import { describeViolation, summarizeTrace } from './trace.ts';

const SPEC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'spec', 'gateway.ts');

/** Every name the spec exports: its own `export const`s and what it re-exports. */
function specExports(source: string): string[] {
  const own = [...source.matchAll(/^export const (\w+)/gm)].map((match) => match[1]!);
  const reexported = [...source.matchAll(/^export \{([^}]*)\} from/gm)].flatMap((match) =>
    match[1]!
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '')
  );
  return [...own, ...reexported];
}

const banner = (condition: string, value: unknown) => ({
  Always: {
    violation: {
      False: { time: 2, condition, snapshots: [{ index: 1, name: 'errorBanners', value, time: 2 }] },
    },
    subformula: { Thunk: { function: condition, negated: false } },
    start: 1,
    end: null,
    time: 2,
  },
});

const line = (timestamp: number, url: string, violations: unknown[]) =>
  JSON.stringify({
    timestamp,
    action: null,
    state: { url, screenshot: `/out/screenshots/${timestamp}.jpeg`, resources: {} },
    snapshots: [],
    violations,
  });

describe('explore lane', () => {
  it("lists exactly the spec's properties", () => {
    const exported = specExports(readFileSync(SPEC, 'utf8'));
    expect([...exported].sort()).toEqual([...PROPERTIES, ...ACTION_GENERATORS].sort());
  });

  it('reports each property by the first state it was violated in', () => {
    const condition = '() => errorBanners.current.length === 0';
    const trace = [
      line(1_000_000, 'http://ui/rooms', []),
      line(1_250_000, 'http://ui/agents', [{ name: 'noErrorBanner', violation: banner(condition, ['Boom']) }]),
      line(1_500_000, 'http://ui/rooms', [{ name: 'noErrorBanner', violation: banner(condition, ['Boom']) }]),
      '',
    ].join('\n');
    const summary = summarizeTrace(trace);
    expect(summary.states).toBe(3);
    expect([...summary.violations.values()]).toEqual([
      {
        name: 'noErrorBanner',
        states: 2,
        firstAtMicros: 250_000,
        url: 'http://ui/agents',
        screenshot: '/out/screenshots/1250000.jpeg',
        detail: `${condition}, with errorBanners = ["Boom"]`,
      },
    ]);
  });

  it('says which formula an eventually was still waiting for', () => {
    const violation = {
      Eventually: {
        subformula: { Thunk: { function: '() => !onLoginPage.current', negated: false } },
        reason: { TimedOut: 30_000_000 },
      },
    };
    expect(describeViolation(violation)).toBe(
      'never held within its time limit: () => !onLoginPage.current'
    );
  });

  it('describes the consequent of an implication', () => {
    const violation = {
      Implies: {
        left: { Thunk: { function: '() => a', negated: false } },
        right: { False: { time: 1, condition: '() => b', snapshots: [] } },
        antecedent_snapshots: [],
      },
    };
    expect(describeViolation(violation)).toBe('() => b');
  });

  it('says an or failed on both sides', () => {
    const side = (condition: string) => ({ False: { time: 1, condition, snapshots: [] } });
    expect(describeViolation({ Or: { left: side('() => a'), right: side('() => b') } })).toBe(
      'neither () => a nor () => b'
    );
  });

  it('reads its time limit apart from the other lanes', () => {
    const malformed = { SWITCH_E2E_EXPLORE_TIME_LIMIT: '1m30s' };
    const base = {
      SWITCH_API_URL: 'http://switch.invalid',
      SWITCH_GATEWAY_ADMIN_EMAIL: 'admin@example.invalid',
      SWITCH_GATEWAY_ADMIN_PASSWORD: 'placeholder',
      SWITCH_AGENT_REGISTRATION_TOKEN: 'placeholder',
      SWITCH_E2E_ENVIRONMENT: 'ephemeral',
    };
    expect(() => loadEnv('fast', { ...base, ...malformed }, {})).not.toThrow();
    expect(() => exploreTimeLimitFrom(malformed, {})).toThrow(/whole number with a unit/);
    expect(exploreTimeLimitFrom({}, {})).toBe('5m');
    expect(durationMs('90s')).toBe(90_000);
  });

  it('refuses a trace line that is not JSON', () => {
    expect(() => summarizeTrace('{"timestamp":')).toThrow(/trace line 1 is not JSON/);
  });
});

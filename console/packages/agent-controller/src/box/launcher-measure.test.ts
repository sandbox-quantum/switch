import { describe, expect, it } from 'vitest';
import type { LinkState } from './launcher-link';
import { LauncherMeasure } from './launcher-measure';

const A = '0fa651dd-faa3-4dda-80b8-f784b1750c95';
const measurement = {
  kind: 'measure' as const,
  at: 0,
  agents: { [A]: { bytes: 1000, processes: 4, disputedBytes: 300 } },
};

function measure(state: LinkState) {
  let clock = 0;
  const m = new LauncherMeasure({ link: { current: state }, now: () => clock });
  return { m, advance: (ms: number) => (clock += ms) };
}

describe('LauncherMeasure', () => {
  it('totals the agents undisputed bytes from a fresh measurement only (the source check)', () => {
    const live = measure('live');
    expect(live.m.totalBytes()).toBeNull();
    live.m.measured({
      ...measurement,
      agents: { ...measurement.agents, other: { bytes: 500, processes: 1, disputedBytes: 0 } },
    });
    expect(live.m.totalBytes()).toBe(700 + 500);
    live.advance(6_000);
    expect(live.m.totalBytes()).toBeNull();
    const quiet = measure('quiet');
    quiet.m.measured(measurement);
    expect(quiet.m.totalBytes()).toBeNull();
  });

  it('reads nothing after the agents container restarted', () => {
    const restarted = measure('live');
    restarted.m.measured(measurement);
    restarted.m.reset();
    expect(restarted.m.totalBytes()).toBeNull();
  });

  it('ignores and counts figures for an agent the controller never launched', () => {
    const logged: [string, Record<string, string | number>][] = [];
    const m = new LauncherMeasure({
      link: { current: 'live' },
      now: () => 0,
      launched: (agentId) => agentId === A,
      log: (event, fields) => void logged.push([event, fields]),
    });
    const B = '148578ff-daef-412f-9ade-2f5ec48420db';
    m.measured({
      ...measurement,
      agents: { ...measurement.agents, [B]: { bytes: 9, processes: 1, disputedBytes: 0 } },
    });
    expect(m.totalBytes()).toBe(700);
    expect(m.unknownEntries).toBe(1);
    expect(logged).toEqual([['measure_unknown_agent', { count: 1 }]]);
  });
});

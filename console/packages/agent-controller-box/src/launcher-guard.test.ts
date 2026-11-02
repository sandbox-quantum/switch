import { describe, expect, it } from 'vitest';
import { LauncherGuard } from './launcher-guard';
import type { LinkState } from './launcher-link';

const A = '0fa651dd-faa3-4dda-80b8-f784b1750c95';
const measurement = {
  kind: 'measure' as const,
  at: 0,
  agents: { [A]: { bytes: 1000, processes: 4, disputedBytes: 300 } },
};

function guard(state: LinkState, reply: Record<string, unknown> = { ok: true }) {
  let clock = 0;
  const orders: unknown[] = [];
  const g = new LauncherGuard({
    link: {
      current: state,
      order: async (order) => {
        orders.push(order);
        return { kind: 'reply', id: 1, ...reply } as never;
      },
    },
    now: () => clock,
  });
  return { g, orders, advance: (ms: number) => (clock += ms) };
}

describe('LauncherGuard', () => {
  it('reads undisputed bytes from a fresh measurement on a live link', () => {
    const { g } = guard('live');
    g.measured(measurement);
    expect(g.read([A, 'other'])).toEqual(new Map([[A, { undisputed: 700, processes: 4 }]]));
  });

  it('totals the agents undisputed bytes from a fresh measurement only (the source check)', () => {
    const live = guard('live');
    expect(live.g.totalBytes()).toBeNull();
    live.g.measured({
      ...measurement,
      agents: { ...measurement.agents, other: { bytes: 500, processes: 1, disputedBytes: 0 } },
    });
    expect(live.g.totalBytes()).toBe(700 + 500);
    live.advance(6_000);
    expect(live.g.totalBytes()).toBeNull();
    const quiet = guard('quiet');
    quiet.g.measured(measurement);
    expect(quiet.g.totalBytes()).toBeNull();
  });

  it('reads nothing from a stale measurement, a quiet or lost link, or after a restart', () => {
    const live = guard('live');
    live.g.measured(measurement);
    live.advance(6_000);
    expect(live.g.read([A])).toBeNull();
    const quiet = guard('quiet');
    quiet.g.measured(measurement);
    expect(quiet.g.read([A])).toBeNull();
    const restarted = guard('live');
    restarted.g.measured(measurement);
    restarted.g.reset();
    expect(restarted.g.read([A])).toBeNull();
  });

  it('sends the stop steps as orders, and an end the launcher could not do throws', async () => {
    const ok = guard('live', {
      ok: true,
      counts: { signalled: 3, gone: 1, notProven: 0, disputed: 1, left: 0 },
    });
    await ok.g.freeze(A);
    expect(await ok.g.end(A)).toEqual({ forced: 3, notProven: 0, left: 0 });
    expect(ok.orders).toEqual([
      { kind: 'freeze', agentId: A },
      { kind: 'end', agentId: A },
    ]);
    const lost = guard('lost', { ok: false, code: 'launcher_lost' });
    await expect(lost.g.end(A)).rejects.toThrow(/launcher_lost/);
  });

  it('ignores and counts figures for an agent the controller never launched', () => {
    const logged: [string, Record<string, string | number>][] = [];
    const g = new LauncherGuard({
      link: { current: 'live', order: async () => ({ kind: 'reply', id: 1, ok: true }) as never },
      now: () => 0,
      launched: (agentId) => agentId === A,
      log: (event, fields) => void logged.push([event, fields]),
    });
    const B = '148578ff-daef-412f-9ade-2f5ec48420db';
    g.measured({
      ...measurement,
      agents: { ...measurement.agents, [B]: { bytes: 9, processes: 1, disputedBytes: 0 } },
    });
    expect(g.read([A, B])).toEqual(new Map([[A, { undisputed: 700, processes: 4 }]]));
    expect(g.unknownEntries).toBe(1);
    expect(logged).toEqual([['measure_unknown_agent', { count: 1 }]]);
  });
});

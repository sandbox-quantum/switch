import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ParkCandidate,
  PressureValve,
  boxLimitFromEnv,
  maxAwakeFromEnv,
  startReserveFromEnv,
  parkOrder,
  readUsage,
} from './memory-pressure';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A box of `limit` bytes with sessions of 250 MiB each over a 200 MiB base. */
function box(
  limit: number,
  sessions: Array<{ id: string; idleSinceMs: number; busy?: boolean; duplicate?: boolean }>
) {
  const awake = new Map(sessions.map((s) => [s.id, s]));
  const parked: string[] = [];
  const usage = () => 200 * MIB + awake.size * 250 * MIB;
  const valve = new PressureValve({ limit, readUsage: async () => usage(), settleMs: 0 });
  valve.register(() =>
    [...awake.values()].map((s): ParkCandidate => ({
      sessionId: s.id,
      idleSinceMs: s.idleSinceMs,
      duplicate: s.duplicate ?? false,
      park: async () => {
        if (s.busy) return false; // mid-turn: the session refuses
        awake.delete(s.id);
        parked.push(s.id);
        return true;
      },
    }))
  );
  return {
    valve,
    awake,
    parked,
    usage,
    wake: (id: string) => awake.set(id, { id, idleSinceMs: Date.now() }),
  };
}

describe('park under pressure', () => {
  it('is off unless the box limit is a positive whole number of bytes', () => {
    const log = { warn: vi.fn() };
    expect(boxLimitFromEnv({}, log)).toBeNull();
    expect(boxLimitFromEnv({ SWITCH_BOX_MEMORY_LIMIT_BYTES: '' }, log)).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
    expect(boxLimitFromEnv({ SWITCH_BOX_MEMORY_LIMIT_BYTES: String(6 * GIB) }, log)).toBe(6 * GIB);
    expect(log.warn).not.toHaveBeenCalled();
    for (const bad of ['0', '-5', '6Gi', '1e10', String(Number.MAX_SAFE_INTEGER + 2)]) {
      log.warn.mockClear();
      expect(boxLimitFromEnv({ SWITCH_BOX_MEMORY_LIMIT_BYTES: bad }, log)).toBeNull();
      expect(log.warn).toHaveBeenCalledOnce();
    }
    expect(new PressureValve({ limit: null, readUsage: async () => 0 }).enabled).toBe(false);
  });

  it('refuses a box limit under 256 MiB as a unit mistake, loudly', () => {
    const log = { warn: vi.fn() };
    // 6144 meant as MiB would read as 6 KiB and refuse every session.
    expect(boxLimitFromEnv({ SWITCH_BOX_MEMORY_LIMIT_BYTES: '6144' }, log)).toBeNull();
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.warn.mock.calls[0]?.[0]).toContain('under 256 MiB');
    log.warn.mockClear();
    expect(
      boxLimitFromEnv({ SWITCH_BOX_MEMORY_LIMIT_BYTES: String(256 * MIB - 1) }, log)
    ).toBeNull();
    expect(log.warn).toHaveBeenCalledOnce();
    log.warn.mockClear();
    expect(boxLimitFromEnv({ SWITCH_BOX_MEMORY_LIMIT_BYTES: String(256 * MIB) }, log)).toBe(
      256 * MIB
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('reads usage from the first cgroup file that exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memory-pressure-'));
    roots.push(dir);
    await writeFile(join(dir, 'v2'), '12345\n');
    expect(await readUsage([join(dir, 'missing'), join(dir, 'v2')])).toBe(12345);
    expect(await readUsage([join(dir, 'missing')])).toBeNull();
  });

  it('parks duplicates first, then the longest idle', () => {
    const c = (sessionId: string, idleSinceMs: number, duplicate = false): ParkCandidate => ({
      sessionId,
      idleSinceMs,
      duplicate,
      park: async () => true,
    });
    expect(
      parkOrder([c('new', 300), c('old', 100), c('dup', 200, true)]).map((x) => x.sessionId)
    ).toEqual(['dup', 'old', 'new']);
  });

  it('does nothing below 80% of the limit', async () => {
    const b = box(
      6 * GIB,
      Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, idleSinceMs: i }))
    );
    await b.valve.check();
    expect(b.parked).toEqual([]);
  });

  it('a wake flood parks the oldest idle sessions down to 65% and the box survives', async () => {
    // 22 awake = 200 MiB + 5.5 GiB, past 80% of 6 GiB.
    const b = box(
      6 * GIB,
      Array.from({ length: 22 }, (_, i) => ({ id: `s${i}`, idleSinceMs: i }))
    );
    await b.valve.check();
    expect(b.usage()).toBeLessThan(0.65 * 6 * GIB);
    expect(b.parked[0]).toBe('s0');
    expect(b.parked).toEqual([...b.parked].sort((x, y) => Number(x.slice(1)) - Number(y.slice(1))));
  });

  it('never parks a session that is mid-turn', async () => {
    const sessions = Array.from({ length: 22 }, (_, i) => ({
      id: `s${i}`,
      idleSinceMs: i,
      busy: i < 5,
    }));
    const b = box(6 * GIB, sessions);
    await b.valve.check();
    for (let i = 0; i < 5; i++) expect(b.parked).not.toContain(`s${i}`);
  });

  it('refuses a new start when every awake session is busy and the box is near full', async () => {
    const busy = Array.from({ length: 22 }, (_, i) => ({
      id: `s${i}`,
      idleSinceMs: i,
      busy: true,
    }));
    const b = box(6 * GIB, busy);
    expect(await b.valve.admit()).toBe(false);
    expect(b.parked).toEqual([]);
  });

  it('admits a new start once parking makes room', async () => {
    const b = box(
      6 * GIB,
      Array.from({ length: 22 }, (_, i) => ({ id: `s${i}`, idleSinceMs: i }))
    );
    expect(await b.valve.admit()).toBe(true);
    expect(b.parked.length).toBeGreaterThan(0);
  });

  it('admits freely below the ceiling, and always when off', async () => {
    const b = box(6 * GIB, [{ id: 'a', idleSinceMs: 0 }]);
    expect(await b.valve.admit()).toBe(true);
    expect(await new PressureValve({ limit: null, readUsage: async () => 10 * GIB }).admit()).toBe(
      true
    );
  });
});

describe('what the valve says about itself', () => {
  const recorder = () => {
    const lines: Array<[string, string]> = [];
    return {
      lines,
      log: {
        info: (line: string) => lines.push(['info', line]),
        warn: (line: string) => lines.push(['warn', line]),
      },
    };
  };

  it('says at start that it is on, what it reads and the limit', async () => {
    const { lines, log } = recorder();
    const valve = new PressureValve({
      limit: 6 * GIB,
      readUsage: async () => 3 * GIB,
      source: '/sys/fs/cgroup/memory/memory.usage_in_bytes',
      log,
    });
    await valve.announce();
    await valve.announce();
    expect(lines).toEqual([
      [
        'info',
        `Park under pressure is on: reading /sys/fs/cgroup/memory/memory.usage_in_bytes, limit ${6 * GIB} bytes; now at 50%. Parks idle sessions from 80% down to 65%, refuses new ones at 90%.`,
      ],
    ]);
  });

  it('says at start that it is off when no limit is set', async () => {
    const { lines, log } = recorder();
    await new PressureValve({ limit: null, readUsage: async () => 0, log }).announce();
    expect(lines).toEqual([
      ['info', 'Park under pressure is off: SWITCH_BOX_MEMORY_LIMIT_BYTES is not set.'],
    ]);
  });

  it('warns once, loudly, when it cannot read the memory use, and lets starts through', async () => {
    const { lines, log } = recorder();
    const valve = new PressureValve({
      limit: 6 * GIB,
      readUsage: async () => null,
      source: '/nowhere',
      log,
    });
    await valve.announce();
    expect(await valve.admit()).toBe(true);
    await valve.check();
    expect(lines).toEqual([
      [
        'warn',
        "Park under pressure can't read this box's memory use (from /nowhere), so it is NOT protecting the box: no session is parked early and none is refused.",
      ],
    ]);
  });
});

describe('starts already under way', () => {
  it('counts each admitted start as its reserve, so a burst of parallel starts is cut off before the box fills', async () => {
    let usage = 4 * GIB;
    const valve = new PressureValve({
      limit: 6 * GIB,
      readUsage: async () => usage,
      startReserve: 512 * MIB,
      settleMs: 0,
    });
    // 4 GiB used; the ceiling is 90% of 6 GiB (5.4 GiB). Each start counts 0.5 GiB until it settles.
    expect(await valve.admit()).toBe(true); // 4.5
    expect(await valve.admit()).toBe(true); // 5.0
    expect(await valve.admit()).toBe(false); // 5.5: refused, though the reading alone (4 GiB) is far below 90%
    expect(valve.starting).toBe(2);
    // One start comes up and is counted in the reading itself from then on.
    usage += 300 * MIB;
    valve.settle();
    expect(await valve.admit()).toBe(true); // 4.3 + 2 x 0.5 = 5.3
    expect(valve.starting).toBe(2);
  });

  it('lets every start in when the box has room, and when the valve is off', async () => {
    const valve = new PressureValve({
      limit: 6 * GIB,
      readUsage: async () => 1 * GIB,
      startReserve: 512 * MIB,
      settleMs: 0,
    });
    for (let i = 0; i < 6; i++) expect(await valve.admit()).toBe(true);
    const off = new PressureValve({
      limit: null,
      readUsage: async () => 10 * GIB,
      startReserve: 512 * MIB,
    });
    for (let i = 0; i < 20; i++) expect(await off.admit()).toBe(true);
  });
});

describe('the cap on awake sessions', () => {
  it('parks an idle session to make room at the cap, and refuses when every awake session is busy', async () => {
    const awake = new Map<string, { busy: boolean }>([
      ['busy-1', { busy: true }],
      ['busy-2', { busy: true }],
      ['idle-1', { busy: false }],
    ]);
    const valve = new PressureValve({
      limit: 6 * GIB,
      readUsage: async () => 1 * GIB,
      maxAwake: 3,
      startReserve: 1,
      settleMs: 0,
    });
    valve.registerAwake(() => awake.size);
    valve.register(() =>
      [...awake.entries()]
        .filter(([, s]) => !s.busy)
        .map(([id]) => ({
          sessionId: id,
          idleSinceMs: 0,
          duplicate: false,
          park: async () => {
            awake.delete(id);
            return true;
          },
        }))
    );
    // 3 awake at a cap of 3: the idle one is parked to make room.
    expect(await valve.admit()).toBe(true);
    expect([...awake.keys()]).toEqual(['busy-1', 'busy-2']);
    // 2 awake plus 1 starting at a cap of 3: nothing idle left, so the next is refused.
    expect(await valve.admit()).toBe(false);
    expect(valve.lastRefusal).toBe(
      'the box is at its limit of 3 awake sessions (2 up, 1 starting)'
    );
    expect(valve.lastRefusal).not.toMatch(/memory/);
    valve.settle();
    awake.set('new-1', { busy: true });
    expect(await valve.admit()).toBe(false);
  });

  it('never counts parked sessions, and does not apply off a box', async () => {
    const valve = new PressureValve({
      limit: 6 * GIB,
      readUsage: async () => 1 * GIB,
      maxAwake: 2,
      startReserve: 1,
    });
    valve.registerAwake(() => 0); // every session parked
    expect(await valve.admit()).toBe(true);
    expect(await valve.admit()).toBe(true);
    expect(await valve.admit()).toBe(false); // two starting already reach the cap of 2
    const laptop = new PressureValve({ limit: null, readUsage: async () => 0, maxAwake: 1 });
    laptop.registerAwake(() => 50);
    expect(await laptop.admit()).toBe(true);
  });

  it('reads the cap from the environment, falling back to 15', () => {
    expect(maxAwakeFromEnv({ SWITCH_BOX_MAX_AWAKE_SESSIONS: '9' })).toBe(9);
    expect(maxAwakeFromEnv({ SWITCH_BOX_MAX_AWAKE_SESSIONS: '0' })).toBe(15);
    expect(maxAwakeFromEnv({ SWITCH_BOX_MAX_AWAKE_SESSIONS: 'lots' })).toBe(15);
    expect(maxAwakeFromEnv({})).toBe(15);
    expect(startReserveFromEnv({ SWITCH_SESSION_START_RESERVE_BYTES: '1048576' })).toBe(1048576);
    expect(startReserveFromEnv({})).toBe(512 * 1024 * 1024);
  });
});

describe('settings that are set wrongly', () => {
  it('falls back for a reserve of 0, a negative number or a typo, and says so', () => {
    for (const raw of ['0', '-5', 'abc']) {
      const warn = vi.fn();
      expect(startReserveFromEnv({ SWITCH_SESSION_START_RESERVE_BYTES: raw }, { warn })).toBe(
        512 * MIB
      );
      expect(warn).toHaveBeenCalledWith(
        `SWITCH_SESSION_START_RESERVE_BYTES is set to "${raw}", which is not a positive whole number; using ${512 * MIB}.`
      );
    }
  });

  it('falls back for a cap of 0, a negative number or a typo, and says so; unset falls back quietly', () => {
    for (const raw of ['0', '-5', 'lots']) {
      const warn = vi.fn();
      expect(maxAwakeFromEnv({ SWITCH_BOX_MAX_AWAKE_SESSIONS: raw }, { warn })).toBe(15);
      expect(warn).toHaveBeenCalledOnce();
    }
    const warn = vi.fn();
    expect(maxAwakeFromEnv({}, { warn })).toBe(15);
    expect(startReserveFromEnv({}, { warn })).toBe(512 * MIB);
    expect(warn).not.toHaveBeenCalled();
  });
});

/**
 * The flood on 26 Oct, replayed:
 * 25 parked agents asked for work at once, starts 3 at a time, each session
 * growing after it was let in. The box's own readings were 1,590, 2,999,
 * 4,219 and 5,116 MiB at +4, +12, +19 and +26 s with 6, 12, 15 and 21
 * session hosts up, and the box was killed before +36 s. Those readings put a
 * session at about 230 MiB once up and the base at about 210 MiB, on top of
 * which each start in progress grows by up to about 500 MiB.
 */
describe('the 26 Oct flood, replayed', () => {
  const BASE = 210 * MIB;
  const UP = 235 * MIB; // per session once up: (5,116 - 1,590) / (21 - 6)
  const STARTING = 450 * MIB; // per start in progress, before it settles
  const LIMIT = 6 * GIB;

  async function flood(valve: PressureValve | undefined, state: { up: number; starting: number }) {
    let peak = 0;
    let refused = 0;
    let maxAwake = 0;
    let waiting = 25;
    // Each step is one start slot's worth of time (about 3.7 s in the flood: 3 starts per step, 21 up in 26 s).
    for (let step = 0; step < 12 && (waiting > 0 || state.starting > 0); step++) {
      // The starts begun last step come up and settle.
      state.up += state.starting;
      for (let i = 0; i < state.starting; i++) valve?.settle();
      state.starting = 0;
      for (let slot = 0; slot < 3 && waiting > 0; slot++) {
        waiting--;
        if (!valve || (await valve.admit())) state.starting++;
        else refused++;
      }
      peak = Math.max(peak, BASE + state.up * UP + state.starting * STARTING);
      maxAwake = Math.max(maxAwake, state.up + state.starting);
    }
    return { peak, refused, maxAwake };
  }

  it('without the check on every wake (l1fix5-7 asked nobody on an ordinary wake), the box runs past its limit', async () => {
    const { peak, refused } = await flood(undefined, { up: 0, starting: 0 });
    expect(refused).toBe(0);
    expect(peak).toBeGreaterThan(LIMIT);
  });

  it('with the reserve and the cap of 15 (l1fix8), starts are refused before 90% and the limit is never reached', async () => {
    const state = { up: 0, starting: 0 };
    const valve = new PressureValve({
      limit: LIMIT,
      readUsage: async () => BASE + state.up * UP + state.starting * STARTING,
      startReserve: 512 * MIB,
      maxAwake: 15,
      settleMs: 0,
    });
    valve.registerAwake(() => state.up);
    const { peak, refused, maxAwake } = await flood(valve, state);
    expect(peak).toBeLessThan(0.9 * LIMIT);
    expect(maxAwake).toBeLessThanOrEqual(15);
    expect(refused).toBeGreaterThanOrEqual(10);
  });
});

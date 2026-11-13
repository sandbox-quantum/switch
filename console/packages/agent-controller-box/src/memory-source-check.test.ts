import { describe, expect, it } from 'vitest';
import { MemorySourceCheck } from './memory-source-check';

const MIB = 1024 * 1024;

function check(split: boolean, launcherTotal: () => number | null = () => null) {
  const errors: unknown[][] = [];
  const infos: unknown[][] = [];
  const c = new MemorySourceCheck({
    split,
    launcherTotal,
    marginBytes: 128 * MIB,
    samples: 3,
    log: {
      error: (...a: unknown[]) => void errors.push(a),
      info: (...a: unknown[]) => void infos.push(a),
    },
  });
  return { c, errors, infos };
}

describe('MemorySourceCheck (split boxes: the reading must see the whole pod)', () => {
  it('is off on a box without the split, whatever the reading says', () => {
    const { c, errors } = check(false, () => 4000 * MIB);
    for (let i = 0; i < 5; i++) c.observe({ bytes: 100 * MIB, shmem: null, source: 'cgroup' });
    expect(c.problem).toBeNull();
    expect(errors).toHaveLength(0);
  });

  it('reports unprotected at once when the reading came from the cgroup, with one error', () => {
    const { c, errors } = check(true);
    c.observe({ bytes: 122 * MIB, shmem: null, source: 'cgroup' });
    c.observe({ bytes: 122 * MIB, shmem: null, source: 'cgroup' });
    expect(c.problem).toBe('unprotected');
    expect(errors).toHaveLength(1);
    expect(errors[0]![1]).toEqual({ reason: 'not_meminfo' });
  });

  it('trips when the launcher agents exceed the reading by the margin, three readings in a row', () => {
    let agents = 900 * MIB;
    const { c, errors, infos } = check(true, () => agents);
    const reading = { bytes: 600 * MIB, shmem: 0, source: 'meminfo' as const };
    c.observe(reading);
    c.observe(reading);
    expect(c.problem).toBeNull();
    c.observe(reading);
    expect(c.problem).toBe('unprotected');
    expect(errors[0]![1]).toEqual({ reason: 'below_agents' });
    // Back within the margin: it clears, with one line.
    agents = 650 * MIB;
    c.observe(reading);
    expect(c.problem).toBeNull();
    expect(infos).toHaveLength(1);
  });

  it('on a split box a cgroup reading counts as no reading for the valve, so a failed reading fails closed', () => {
    const split = check(true);
    expect(split.c.usable({ bytes: 122 * MIB, shmem: null, source: 'cgroup' })).toBeNull();
    expect(split.c.usable({ bytes: 900 * MIB, shmem: 0, source: 'meminfo' })).toBe(900 * MIB);
    expect(split.c.usable({ bytes: 900 * MIB, shmem: null, source: 'meminfo_used' })).toBe(
      900 * MIB
    );
    expect(split.c.usable(null)).toBeNull();
    // An allow-list: a reading with no source is no reading on a split box too.
    expect(split.c.usable({ bytes: 900 * MIB, shmem: 0 })).toBeNull();
    split.c.observe({ bytes: 900 * MIB, shmem: 0 });
    expect(split.c.problem).toBe('unprotected');
    // A box without the split acts on any reading, as today.
    const unsplit = check(false);
    expect(unsplit.c.usable({ bytes: 122 * MIB, shmem: null, source: 'cgroup' })).toBe(122 * MIB);
  });

  it('never trips within the margin, on a stale launcher figure, or on a failed reading', () => {
    const within = check(true, () => 700 * MIB);
    for (let i = 0; i < 5; i++)
      within.c.observe({ bytes: 600 * MIB, shmem: 0, source: 'meminfo_used' });
    expect(within.c.problem).toBeNull();
    const stale = check(true, () => null);
    for (let i = 0; i < 5; i++) stale.c.observe({ bytes: 600 * MIB, shmem: 0, source: 'meminfo' });
    expect(stale.c.problem).toBeNull();
    const failed = check(true, () => 4000 * MIB);
    for (let i = 0; i < 5; i++) failed.c.observe(null);
    expect(failed.c.problem).toBeNull();
  });
});

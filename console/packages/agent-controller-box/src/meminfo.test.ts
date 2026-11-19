import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseMeminfo, readMeminfo } from './meminfo';
import { MEMINFO_MAX_BYTES } from './schemas';

/** Box A's `/proc/meminfo` at 11:50Z on 27 Oct, all five agents parked (gVisor's own lines). */
const BOX_A_PARKED = [
  'MemTotal:        6291456 kB',
  'MemFree:         4718936 kB',
  'MemAvailable:    5290480 kB',
  'Buffers:               0 kB',
  'Cached:           571544 kB',
  'SwapCache:             0 kB',
  'Active:          1212732 kB',
  'Inactive:         299308 kB',
  'AnonPages:        940496 kB',
  'Mapped:           211404 kB',
  'Shmem:             10236 kB',
  '',
].join('\n');

describe('parseMeminfo', () => {
  it("reads AnonPages and Cached in bytes from box A's parked reading", () => {
    expect(parseMeminfo(BOX_A_PARKED)).toEqual({
      anon: 940_496 * 1024,
      cached: 571_544 * 1024,
    });
  });

  it('is null when either field is missing', () => {
    expect(parseMeminfo(BOX_A_PARKED.replace(/^AnonPages:.*$/m, ''))).toBeNull();
    expect(parseMeminfo(BOX_A_PARKED.replace(/^Cached:.*$/m, ''))).toBeNull();
    expect(parseMeminfo('')).toBeNull();
  });

  it('does not take SwapCache for Cached, or a field with another unit or a sign', () => {
    expect(parseMeminfo('SwapCache: 5 kB\nAnonPages: 1 kB\n')).toBeNull();
    expect(parseMeminfo('Cached: 5 MB\nAnonPages: 1 kB\n')).toBeNull();
    expect(parseMeminfo('Cached: -5 kB\nAnonPages: 1 kB\n')).toBeNull();
    expect(parseMeminfo('Cached: 5.5 kB\nAnonPages: 1 kB\n')).toBeNull();
  });

  it('is null for a reading out of range, so the report never carries one', () => {
    const tooBig = MEMINFO_MAX_BYTES / 1024 + 1;
    expect(parseMeminfo(`Cached: 1 kB\nAnonPages: ${tooBig} kB\n`)).toBeNull();
    expect(parseMeminfo(`Cached: 1 kB\nAnonPages: ${'9'.repeat(30)} kB\n`)).toBeNull();
    expect(parseMeminfo(`Cached: 1 kB\nAnonPages: ${tooBig - 1} kB\n`)).toEqual({
      anon: MEMINFO_MAX_BYTES,
      cached: 1024,
    });
  });
});

describe('readMeminfo', () => {
  let proc: string;
  beforeEach(() => {
    proc = mkdtempSync(join(tmpdir(), 'controller-meminfo-'));
  });
  afterEach(() => {
    rmSync(proc, { recursive: true, force: true });
  });

  it('reads the file under the given /proc', async () => {
    writeFileSync(join(proc, 'meminfo'), BOX_A_PARKED);
    expect(await readMeminfo(proc)).toEqual({ anon: 940_496 * 1024, cached: 571_544 * 1024 });
  });

  it('is null where there is no /proc, as on macOS', async () => {
    expect(await readMeminfo(join(proc, 'missing'))).toBeNull();
  });
});

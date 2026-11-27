import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  anonymousBytes,
  anonymousBytesIn,
  anonymousKiB,
  boxMemoryFromMeminfo,
  readBoxMemory,
  usedFromMeminfo,
} from './box-memory';
import { ProcReader } from './owner-marker';

const GIB = 1024 ** 3;

describe('anonymousBytes', () => {
  it("sums every mapping's Anonymous line, as gVisor writes smaps", () => {
    const smaps = [
      '00400000-00b1c000 r-xp 00000000 00:05 12 /usr/local/bin/node',
      'Size:               7280 kB',
      'Rss:                7280 kB',
      'Pss:                7280 kB',
      'Shared_Clean:          0 kB',
      'Private_Dirty:         0 kB',
      'Anonymous:             0 kB',
      '7f1c2a000000-7f1c2e000000 rw-p 00000000 00:00 0',
      'Size:              65536 kB',
      'Rss:               61440 kB',
      'Pss:               61440 kB',
      'Private_Dirty:     61312 kB',
      'Anonymous:         61440 kB',
      '7ffd0c3e0000-7ffd0c401000 rw-p 00000000 00:00 0 [stack]',
      'Anonymous:           132 kB',
      '',
    ].join('\n');
    expect(anonymousBytes(smaps)).toBe((61440 + 132) * 1024);
    expect(anonymousBytes('')).toBe(0);
  });
});

describe('boxMemoryFromMeminfo', () => {
  it('reads AnonPages, Shmem and MemTotal, and gives null when one is missing', () => {
    const meminfo = [
      'MemTotal:        6291456 kB',
      'MemFree:         4921344 kB',
      'AnonPages:        940496 kB',
      'Shmem:              4096 kB',
      '',
    ].join('\n');
    expect(boxMemoryFromMeminfo(meminfo)).toEqual({
      anon: 940496 * 1024,
      shmem: 4096 * 1024,
      total: 6291456 * 1024,
    });
    expect(boxMemoryFromMeminfo('MemTotal: 6291456 kB\n')).toBeNull();
  });
});

describe('reading smaps', () => {
  let proc: string;
  beforeEach(() => {
    proc = mkdtempSync(join(tmpdir(), 'box-memory-'));
  });
  afterEach(() => rmSync(proc, { recursive: true, force: true }));

  it('reads an Anonymous line from its bytes, and nothing from any other line', () => {
    const kib = (text: string) => {
      const line = Buffer.from(`xx${text}yy`, 'latin1');
      return anonymousKiB(line, 2, line.length - 2);
    };
    expect(kib('Anonymous:          78332 kB')).toBe(78_332);
    expect(kib('Anonymous:\t0 kB')).toBe(0);
    for (const other of [
      'AnonHugePages:      2048 kB',
      'Anonymous:78332 kB',
      'Anonymous:       kB',
      'Anonymous:       12 MB',
      'Anonymous:       12 kB trailing',
      'Anonymous:       1x2 kB',
      ' Anonymous:       12 kB',
      'Rss:              12 kB',
      '',
    ])
      expect(kib(other)).toBeNull();
  });

  it('streams smaps to the same sum as reading it whole, whatever the chunk size', async () => {
    const at = join(proc, 'smaps-only');
    const smaps = Array.from(
      { length: 2_000 },
      (_, i) =>
        `7f00${i}-7f01${i} rw-p 00000000 00:00 0\nSize:  ${i} kB\nRss:  ${i} kB\nAnonymous:  ${i % 97} kB\nVmFlags: rd wr mr mw me ac\n`
    ).join('');
    writeFileSync(at, smaps);
    for (const size of [16, 100, 4096, 64 * 1024])
      expect(await anonymousBytesIn(new ProcReader(size), at)).toEqual({
        bytes: anonymousBytes(smaps),
        complete: true,
      });
  });
});

describe('readBoxMemory', () => {
  let proc: string;
  beforeEach(() => {
    proc = mkdtempSync(join(tmpdir(), 'box-memory-read-'));
  });
  afterEach(() => rmSync(proc, { recursive: true, force: true }));

  it('counts Shmem with AnonPages, and takes the cgroup reading when it is higher', async () => {
    writeFileSync(
      join(proc, 'meminfo'),
      'MemTotal:        6291456 kB\nAnonPages:       1058816 kB\nShmem:           2097152 kB\n'
    );
    expect(await readBoxMemory({ procRoot: proc, cgroupUsage: async () => null })).toEqual({
      bytes: (1058816 + 2097152) * 1024,
      shmem: 2097152 * 1024,
      source: 'meminfo',
    });
    expect(await readBoxMemory({ procRoot: proc, cgroupUsage: async () => 5 * GIB })).toEqual({
      bytes: 5 * GIB,
      shmem: 2097152 * 1024,
      source: 'cgroup',
    });
    rmSync(join(proc, 'meminfo'));
    expect(await readBoxMemory({ procRoot: proc, cgroupUsage: async () => null })).toBeNull();
    expect(await readBoxMemory({ procRoot: proc, cgroupUsage: async () => GIB })).toEqual({
      bytes: GIB,
      shmem: null,
      source: 'cgroup',
    });
  });

  it('falls back to MemTotal − MemAvailable when AnonPages or Shmem is missing (gVisor)', async () => {
    writeFileSync(
      join(proc, 'meminfo'),
      'MemTotal:        1310720 kB\nMemFree:          100000 kB\nMemAvailable:     139264 kB\n'
    );
    const used = (1310720 - 139264) * 1024;
    // A split box passes no cgroup: the pod's total comes from meminfo alone.
    expect(await readBoxMemory({ procRoot: proc, cgroupUsage: async () => null })).toEqual({
      bytes: used,
      shmem: null,
      source: 'meminfo_used',
    });
    // The cgroup still wins where it reads higher (a box without the split).
    expect(await readBoxMemory({ procRoot: proc, cgroupUsage: async () => 2 * GIB })).toEqual({
      bytes: 2 * GIB,
      shmem: null,
      source: 'cgroup',
    });
    expect(usedFromMeminfo('MemTotal:        1310720 kB\n')).toBeNull();
  });
});

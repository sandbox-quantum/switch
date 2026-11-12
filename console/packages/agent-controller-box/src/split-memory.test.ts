import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSplitBoxMemory } from './split-memory';

const MIB = 1024 * 1024;
let proc: string;
beforeEach(() => {
  proc = mkdtempSync(join(tmpdir(), 'split-memory-'));
});
afterEach(() => rmSync(proc, { recursive: true, force: true }));

describe('a split box’s memory reading', () => {
  it('is AnonPages plus Shmem from /proc/meminfo: the pod total under gVisor', async () => {
    writeFileSync(
      join(proc, 'meminfo'),
      [
        'MemTotal:        1310720 kB',
        'AnonPages:        921600 kB',
        'Shmem:             10240 kB',
      ].join('\n')
    );
    expect(await readSplitBoxMemory(proc)).toMatchObject({
      bytes: 910 * MIB,
      shmem: 10 * MIB,
      source: 'meminfo',
    });
  });

  it('never falls back to the cgroup, which there is the controller’s own container: null instead', async () => {
    // No meminfo at all: the valve reports `unprotected` for a null reading.
    expect(await readSplitBoxMemory(proc)).toBeNull();
    writeFileSync(join(proc, 'meminfo'), 'MemTotal: 1310720 kB\n');
    expect(await readSplitBoxMemory(proc)).toBeNull();
    // Without AnonPages, the fallback (MemTotal − MemAvailable) still reads the pod, never the cgroup.
    writeFileSync(
      join(proc, 'meminfo'),
      'MemTotal:        1310720 kB\nMemAvailable:     409600 kB\n'
    );
    expect(await readSplitBoxMemory(proc)).toMatchObject({
      bytes: 880 * MIB,
      source: 'meminfo_used',
    });
  });
});

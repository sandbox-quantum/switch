import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdirSync } from 'node:fs';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  elapsedMs,
  fenceDeadOwner,
  judgeOwnerRecord,
  type OwnerProbes,
  pidOneStartFrom,
  COMMAND_LINE_MAX,
  processCommandLine,
  processExists,
  processStartedAt,
  recordedOwnerAlive,
  recordPredatesHolder,
  tgidOf,
} from './process-fence';

function terminateGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

it.skipIf(process.platform === 'win32')(
  'fences provider children after a real host process crash',
  async () => {
    const owner = spawn(
      process.execPath,
      [
        '-e',
        `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    console.log(child.pid);
    setInterval(() => {}, 1000);
  `,
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const pid = owner.pid!;
    let fenced = false;
    try {
      await once(owner.stdout!, 'data');
      await expect(fenceDeadOwner(pid, pid, null)).rejects.toThrow('still alive');
      const exited = once(owner, 'exit');
      owner.kill('SIGKILL');
      await exited;
      await fenceDeadOwner(pid, pid, null);
      fenced = true;
      expect(() => process.kill(-pid, 0)).toThrow();
    } finally {
      if (!fenced) terminateGroup(pid);
    }
  }
);

it.skipIf(process.platform === 'win32')(
  'accepts a group exiting between the liveness check and fencing',
  async () => {
    const gone = Object.assign(new Error('Process exited'), { code: 'ESRCH' });
    const kill = vi
      .spyOn(process, 'kill')
      .mockImplementationOnce(() => {
        throw gone;
      })
      .mockReturnValueOnce(true)
      .mockImplementationOnce(() => {
        throw gone;
      });
    try {
      await expect(fenceDeadOwner(12345, 12345, null)).resolves.toBeUndefined();
      expect(kill).toHaveBeenLastCalledWith(-12345, 'SIGKILL');
    } finally {
      kill.mockRestore();
    }
  }
);

it.skipIf(process.platform === 'win32')(
  'waits for confirmed exit after a transient permission error during group teardown',
  async () => {
    const gone = Object.assign(new Error('Process exited'), { code: 'ESRCH' });
    const denied = Object.assign(new Error('Permission denied'), { code: 'EPERM' });
    const kill = vi
      .spyOn(process, 'kill')
      .mockImplementationOnce(() => {
        throw gone;
      })
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockImplementationOnce(() => {
        throw denied;
      })
      .mockImplementationOnce(() => {
        throw gone;
      });
    try {
      await expect(fenceDeadOwner(12345, 12345, null)).resolves.toBeUndefined();
      expect(kill).toHaveBeenCalledTimes(5);
    } finally {
      kill.mockRestore();
    }
  }
);

const throws = (code: string) => () => {
  throw Object.assign(new Error(code), { code });
};

// macOS answers EPERM for a group left with only unreaped members, as it can
// be the moment a host exits.
it.skipIf(process.platform === 'win32').each([
  ['checking it', [throws('EPERM'), throws('EPERM')]],
  ['killing it', [(): true => true, throws('EPERM')]],
])('waits out a group that answers EPERM when %s', async (_when, answers) => {
  const kill = vi.spyOn(process, 'kill');
  for (const answer of [throws('ESRCH'), ...answers, throws('ESRCH')])
    kill.mockImplementationOnce(answer);
  try {
    await expect(fenceDeadOwner(12345, 12345, null)).resolves.toBeUndefined();
    expect(kill).toHaveBeenLastCalledWith(-12345, 0);
  } finally {
    kill.mockRestore();
  }
});

it.skipIf(process.platform === 'win32')(
  'does not assume a group is gone when permission stays denied',
  async () => {
    const gone = Object.assign(new Error('Process exited'), { code: 'ESRCH' });
    const denied = Object.assign(new Error('Permission denied'), { code: 'EPERM' });
    const kill = vi
      .spyOn(process, 'kill')
      .mockImplementationOnce(() => {
        throw gone;
      })
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockImplementation(() => {
        throw denied;
      });
    try {
      const result = expect(fenceDeadOwner(12345, 12345, null)).rejects.toThrow('has not exited');
      await result;
    } finally {
      kill.mockRestore();
    }
  },
  10000
);

describe('elapsedMs', () => {
  it('reads ps etime in each of its shapes', () => {
    expect(elapsedMs('00:07')).toBe(7_000);
    expect(elapsedMs('15:03')).toBe((15 * 60 + 3) * 1000);
    expect(elapsedMs('02:15:03')).toBe(((2 * 60 + 15) * 60 + 3) * 1000);
    expect(elapsedMs('4-02:15:03')).toBe((((4 * 24 + 2) * 60 + 15) * 60 + 3) * 1000);
    expect(elapsedMs('')).toBeNull();
    expect(elapsedMs('soon')).toBeNull();
  });
});

describe('processStartedAt', () => {
  it.skipIf(process.platform === 'win32')(
    'puts this process’s start within a few seconds of its own record',
    async () => {
      const started = await processStartedAt(process.pid);
      expect(started).not.toBeNull();
      expect(Math.abs(started! - performance.timeOrigin)).toBeLessThan(3_000);
    }
  );

  it.runIf(process.platform === 'linux')(
    'reads a start from /proc on Linux, so a box without ps still judges saved ids',
    async () => {
      const path = process.env.PATH;
      process.env.PATH = '/nonexistent'; // no `ps` to be found
      try {
        const started = await processStartedAt(process.pid);
        expect(started).not.toBeNull();
        expect(Math.abs(started! - performance.timeOrigin)).toBeLessThan(3_000);
        // An id nothing holds is no process, still without `ps`.
        expect(await processStartedAt(4_000_000)).toBeNull();
      } finally {
        process.env.PATH = path;
      }
    }
  );
});

describe('a saved id now held by a later process (box A, 27 Oct)', () => {
  const fourDaysAgo = () => new Date(Date.now() - 4 * 24 * 3600 * 1000);

  it.skipIf(process.platform === 'win32')(
    'counts a fresh record as alive and an older one as gone',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'recorded-owner-'));
      try {
        const record = join(dir, 'owner.json');
        await writeFile(record, JSON.stringify({ pid: process.ppid }));
        expect(await recordedOwnerAlive(record, process.ppid)).toBe(true);
        await utimes(record, fourDaysAgo(), fourDaysAgo());
        expect(await recordedOwnerAlive(record, process.ppid)).toBe(false);
        expect(await recordPredatesHolder(record, process.ppid)).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(process.platform === 'win32')(
    'fences nothing for a stale worker lock, and still refuses a current one',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'fence-stale-'));
      try {
        const lock = join(dir, 'shared-owner.lock');
        await writeFile(lock, JSON.stringify({ pid: process.ppid, group: process.ppid }));
        await expect(fenceDeadOwner(process.ppid, process.ppid, null, lock)).rejects.toThrow(
          'FENCING_REQUIRED'
        );
        await utimes(lock, fourDaysAgo(), fourDaysAgo());
        await expect(
          fenceDeadOwner(process.ppid, process.ppid, null, lock)
        ).resolves.toBeUndefined();
        expect(() => process.kill(process.ppid, 0)).not.toThrow();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  );
});

describe('a saved id that now names a thread, not a process (box B, 27 Oct)', () => {
  it('reads the thread-group id from a status text', () => {
    expect(tgidOf('Name:\tclaude\nTgid:\t183\nPid:\t264\n')).toBe(183);
    expect(tgidOf('Name:\tx\n')).toBeNull();
  });

  // After the restart, id 264 was a thread of a Claude CLI (Tgid 183): kill(264, 0)
  // succeeded, `ps -p 264` found nothing, and pm's session never started.
  const aThread = (): number | null => {
    if (process.platform !== 'linux') return null;
    const tid = readdirSync('/proc/self/task')
      .map(Number)
      .find((id) => id !== process.pid);
    return tid ?? null;
  };

  it.skipIf(process.platform !== 'linux')(
    'does not count a thread of another process as an owner',
    async () => {
      const tid = aThread();
      expect(tid).not.toBeNull();
      expect(processExists(process.pid)).toBe(true);
      expect(processExists(tid!)).toBe(false);
      const dir = await mkdtemp(join(tmpdir(), 'thread-owner-'));
      try {
        const lock = join(dir, 'shared-owner.lock');
        await writeFile(lock, JSON.stringify({ pid: tid, group: tid }));
        expect(await recordedOwnerAlive(lock, tid!)).toBe(false);
        expect(await recordPredatesHolder(lock, tid!)).toBe(true);
        await expect(fenceDeadOwner(tid!, tid!, null, lock)).resolves.toBeUndefined();
        expect(() => process.kill(process.pid, 0)).not.toThrow();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  );
});

describe('judgeOwnerRecord, the one verdict every owner check uses', () => {
  const T = Date.parse('2026-10-27T10:23:38Z'); // box B's pid 1 start after the second hog
  const probes = (over: Partial<OwnerProbes> = {}): OwnerProbes => ({
    platform: 'linux',
    recordTime: async () => T + 60_000,
    boxStartedAt: async () => T,
    exists: () => true,
    threadGroupOf: (pid) => pid,
    startedAt: async () => T + 1_000,
    ...over,
  });

  it('calls a live owner alive, and a fence leaves it alone', async () => {
    expect(await judgeOwnerRecord('lock', 500, probes())).toEqual({ kind: 'alive' });
    await expect(fenceDeadOwner(500, 500, null, 'lock', probes())).rejects.toThrow(
      'FENCING_REQUIRED'
    );
  });

  it("B's real sequence: id 264 is a thread of process 183, so the record names nobody", async () => {
    const p = probes({ recordTime: async () => T - 120_000 + 200_000, threadGroupOf: () => 183 });
    expect(await judgeOwnerRecord('lock', 264, p)).toEqual({
      kind: 'stale',
      reason: 'not-a-process',
    });
    await expect(fenceDeadOwner(264, 264, null, 'lock', p)).resolves.toBeUndefined();
  });

  it("A's 08:50 sequence: a 23 Oct record naming pid 2, now the controller, predates the box", async () => {
    const p = probes({
      recordTime: async () => Date.parse('2026-10-23T12:44:41Z'),
      startedAt: async () => T,
    });
    expect(await judgeOwnerRecord('owner.json', 2, p)).toEqual({
      kind: 'stale',
      reason: 'predates-box',
    });
  });

  it('a record written before the box started is stale without asking the holder anything', async () => {
    let asked = false;
    const p = probes({
      recordTime: async () => T - 10_000,
      startedAt: async () => {
        asked = true;
        return null;
      },
    });
    expect(await judgeOwnerRecord('lock', 500, p)).toEqual({
      kind: 'stale',
      reason: 'predates-box',
    });
    expect(asked).toBe(false);
    await expect(fenceDeadOwner(500, 500, null, 'lock', p)).resolves.toBeUndefined();
  });

  it('a record written in the box’s first second is not mistaken for one from before it', async () => {
    const p = probes({ recordTime: async () => T + 500, startedAt: async () => T + 200 });
    expect(await judgeOwnerRecord('lock', 500, p)).toEqual({ kind: 'alive' });
    const justBefore = probes({
      recordTime: async () => T - 1_000,
      startedAt: async () => T - 1_500,
    });
    expect((await judgeOwnerRecord('lock', 500, justBefore)).kind).toBe('alive');
  });

  it('a holder that exits mid-check is gone, not alive', async () => {
    let looks = 0;
    const p = probes({ exists: () => looks++ === 0, startedAt: async () => null });
    expect(await judgeOwnerRecord('lock', 500, p)).toEqual({ kind: 'stale', reason: 'gone' });
  });

  it('an unreadable start is unknown: never killed on, never taken over', async () => {
    const p = probes({ startedAt: async () => null });
    expect(await judgeOwnerRecord('lock', 500, p)).toEqual({ kind: 'unknown' });
    expect(await recordedOwnerAliveWith(p)).toBe(true);
    await expect(fenceDeadOwner(500, 500, null, 'lock', p)).rejects.toThrow('could not be read');
  });

  it('an id handed to a later process is stale', async () => {
    const p = probes({ recordTime: async () => T + 5_000, startedAt: async () => T + 60_000 });
    expect(await judgeOwnerRecord('lock', 500, p)).toEqual({
      kind: 'stale',
      reason: 'predates-holder',
    });
  });

  it('macOS and Windows: no thread check, the rest unchanged', async () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const p = probes({ platform, threadGroupOf: () => 183 });
      expect(await judgeOwnerRecord('lock', 264, p)).toEqual({ kind: 'alive' });
      const noBox = probes({
        platform,
        boxStartedAt: async () => null,
        recordTime: async () => T - 10_000,
        startedAt: async () => T,
      });
      expect(await judgeOwnerRecord('lock', 264, noBox)).toEqual({
        kind: 'stale',
        reason: 'predates-holder',
      });
    }
  });

  it('reads pid 1’s start from /proc as gVisor gives it (box B, 10:53)', () => {
    const stat = 'cpu  1 2 3\nbtime 1793096606\nprocesses 900\n';
    const pidOne =
      '1 (tini) S 0 1 1 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 1238 2412544 200 18446744073709551615';
    expect(pidOneStartFrom(stat, pidOne)).toBe((1793096606 + 12.38) * 1000);
    expect(pidOneStartFrom('cpu 1\n', pidOne)).toBeNull();
  });
});

async function recordedOwnerAliveWith(p: OwnerProbes): Promise<boolean> {
  return (await judgeOwnerRecord('lock', 500, p)).kind !== 'stale';
}

it.skipIf(process.platform === 'win32')(
  'fences a dead leader’s group that outlives it inside this box, and nothing for a record from before the box',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fence-group-'));
    const leader = spawn(
      process.execPath,
      [
        '-e',
        "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).unref(); setInterval(() => {}, 1000)",
      ],
      { detached: true, stdio: 'ignore' }
    );
    const group = leader.pid!;
    try {
      const lock = join(dir, 'shared-owner.lock');
      await writeFile(lock, JSON.stringify({ pid: group, group }));
      await new Promise((resolve) => setTimeout(resolve, 500));
      process.kill(group, 'SIGKILL');
      await once(leader, 'exit');
      // The group lives on in the child. Written before this box: kill nothing.
      const beforeBox = {
        platform: process.platform,
        recordTime: async () => Date.now() - 60_000,
        boxStartedAt: async () => Date.now(),
        exists: (pid: number) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        },
        threadGroupOf: (pid: number) => pid,
        startedAt: async () => null,
      };
      await expect(fenceDeadOwner(group, group, null, lock, beforeBox)).resolves.toBeUndefined();
      expect(() => process.kill(-group, 0)).not.toThrow();
      // Inside this box's life: the dead leader's own group is fenced.
      await expect(fenceDeadOwner(group, group, null, lock)).resolves.toBeUndefined();
      expect(() => process.kill(-group, 0)).toThrow();
    } finally {
      terminateGroup(group);
      await rm(dir, { recursive: true, force: true });
    }
  },
  20_000
);

describe('the INFO line for a stale verdict (kill -9 proof, 27 Oct)', () => {
  const T = Date.parse('2026-10-27T11:34:11Z');
  const probes = (over: Partial<OwnerProbes> = {}): OwnerProbes => ({
    platform: 'linux',
    recordTime: async () => T - 120_000,
    boxStartedAt: async () => T,
    exists: () => true,
    threadGroupOf: (pid) => pid,
    startedAt: async () => T + 1_000,
    ...over,
  });

  it('logs one line per stale record: the folder, the reason and when it was written, never the full path', async () => {
    const lines: string[] = [];
    const path = '/data/home/.local/state/switch/sdk-sessions/e923c6f9142c/supervisor/owner.json';
    for (let i = 0; i < 3; i++)
      await judgeOwnerRecord(path, 2, probes(), (line) => lines.push(line));
    expect(lines).toEqual([
      'Owner record judged stale (predates-box): sdk-sessions/e923c6f9142c, written 2026-10-27T11:32:11.000Z; replacing it, nothing killed.',
    ]);
    expect(lines[0]).not.toContain('/data/home');
  });

  it('logs nothing for a live owner or an unknown one', async () => {
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    await judgeOwnerRecord(
      '/w/watchers/agent-1/shared-owner.lock',
      9,
      probes({ recordTime: async () => T + 5_000 }),
      log
    );
    await judgeOwnerRecord(
      '/w/watchers/agent-2/shared-owner.lock',
      9,
      probes({ recordTime: async () => T + 5_000, startedAt: async () => null }),
      log
    );
    expect(lines).toEqual([]);
  });

  it('names a thread id as not-a-process', async () => {
    const lines: string[] = [];
    await judgeOwnerRecord(
      '/w/sdk-sessions/s1/shared-owner.lock',
      264,
      probes({ recordTime: async () => T + 60_000, threadGroupOf: () => 183 }),
      (line) => lines.push(line)
    );
    expect(lines[0]).toContain('(not-a-process): sdk-sessions/s1,');
  });
});

describe('processCommandLine', () => {
  it("gives a live process's command line, its state root included", async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmdline-root-'));
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', root], {
      stdio: 'ignore',
    });
    try {
      await once(child, 'spawn');
      expect(await processCommandLine(child.pid!)).toContain(root);
    } finally {
      child.kill('SIGKILL');
      await rm(root, { recursive: true, force: true });
    }
  });

  it('answers null for a process that has ended', async () => {
    const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    await once(child, 'exit');
    expect(await processCommandLine(child.pid!)).toBeNull();
  });

  it.skipIf(process.platform !== 'linux')(
    'reads a command line past the cap no further, and it names no root',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'cmdline-long-'));
      const long = 'x'.repeat(COMMAND_LINE_MAX + 1024);
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', long, root], {
        stdio: 'ignore',
      });
      try {
        await once(child, 'spawn');
        expect(await processCommandLine(child.pid!)).toBe('');
      } finally {
        child.kill('SIGKILL');
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(process.platform !== 'linux')(
    'reads one just under the cap whole, past the first 4 KiB',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'cmdline-mid-'));
      const filler = 'y'.repeat(COMMAND_LINE_MAX - 2048);
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', filler, root], {
        stdio: 'ignore',
      });
      try {
        await once(child, 'spawn');
        expect(await processCommandLine(child.pid!)).toContain(root);
      } finally {
        child.kill('SIGKILL');
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(process.platform !== 'linux')(
    'reads /proc on Linux, starting no ps: owner records are checked many times a second',
    async () => {
      const path = process.env.PATH;
      process.env.PATH = '/nonexistent-b88';
      try {
        // With no `ps` to be found, only the /proc read can answer.
        expect(await processCommandLine(process.pid)).toContain(process.execPath.split('/').pop()!);
      } finally {
        process.env.PATH = path;
      }
    }
  );
});

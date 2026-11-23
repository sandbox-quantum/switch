import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { fenceDeadOwner, killProcessTree, processCommandLine } from './process-fence';
import { descendants, listWindowsProcesses, type WindowsProcess } from './windows-processes';

const at = (seconds: number) => Date.UTC(2026, 0, 1) + seconds * 1000;
const proc = (pid: number, ppid: number, created: number): WindowsProcess => ({
  pid,
  ppid,
  createdAt: at(created),
  commandLine: null,
});

describe('descendants', () => {
  it('walks children and grandchildren of a live root', () => {
    const processes = [proc(10, 1, 0), proc(11, 10, 5), proc(12, 11, 6), proc(20, 1, 3)];
    expect(descendants(processes, 10, null).map((entry) => entry.pid)).toEqual([11, 12]);
  });

  it('finds orphans that still name a root that has exited', () => {
    const processes = [proc(11, 10, 5), proc(12, 11, 6)];
    expect(descendants(processes, 10, at(0)).map((entry) => entry.pid)).toEqual([11, 12]);
  });

  it('skips a process created before its supposed parent: its parent id was reused', () => {
    const processes = [proc(10, 1, 100), proc(11, 10, 5)];
    expect(descendants(processes, 10, null)).toEqual([]);
  });

  it('leaves alone what a newer process holding the id started', () => {
    // The owner started at 0 and died; pid 10 now belongs to a process from 50.
    const processes = [proc(10, 1, 50), proc(11, 10, 5), proc(12, 10, 60)];
    expect(descendants(processes, 10, at(0)).map((entry) => entry.pid)).toEqual([11]);
  });

  it('survives a parent cycle', () => {
    const processes = [proc(11, 12, 5), proc(12, 11, 6)];
    expect(descendants(processes, 11, at(0)).map((entry) => entry.pid)).toEqual([12]);
  });
});

/** A process that starts a child which outlives it, printing the child's pid. */
const PARENT_OF_A_SURVIVOR = `
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true, windowsHide: true });
  console.log(child.pid);
  setInterval(() => {}, 1000);
`;

function exists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.runIf(process.platform === 'win32')('on Windows', () => {
  it('lists this process with its command line', async () => {
    const processes = await listWindowsProcesses();
    const self = processes.find((entry) => entry.pid === process.pid);
    expect(self?.ppid).toBe(process.ppid);
    expect(await processCommandLine(process.pid)).toContain('node');
  }, 60_000);

  it('answers null for a process that is gone', async () => {
    const child = spawn(process.execPath, ['-e', ''], { windowsHide: true });
    await once(child, 'exit');
    expect(await processCommandLine(child.pid!)).toBeNull();
  }, 60_000);

  it('fences what a crashed owner left running', async () => {
    const startedAt = Date.now();
    const owner = spawn(process.execPath, ['-e', PARENT_OF_A_SURVIVOR], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const [line] = await once(owner.stdout!, 'data');
    const survivor = Number(String(line).trim());
    try {
      await expect(fenceDeadOwner(owner.pid!, null, startedAt)).rejects.toThrow('still alive');
      const exited = once(owner, 'exit');
      owner.kill();
      await exited;
      expect(exists(survivor)).toBe(true);
      await fenceDeadOwner(owner.pid!, null, startedAt);
      expect(exists(survivor)).toBe(false);
    } finally {
      if (exists(survivor)) process.kill(survivor);
    }
  }, 120_000);

  it('kills a whole tree', async () => {
    const owner = spawn(process.execPath, ['-e', PARENT_OF_A_SURVIVOR], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const [line] = await once(owner.stdout!, 'data');
    const survivor = Number(String(line).trim());
    try {
      const exited = once(owner, 'exit');
      await killProcessTree(owner.pid!);
      await exited;
      expect(exists(survivor)).toBe(false);
    } finally {
      if (exists(survivor)) process.kill(survivor);
    }
  }, 120_000);
});

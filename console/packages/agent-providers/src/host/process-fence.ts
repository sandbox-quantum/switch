import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function ownProcessGroup(): Promise<number | null> {
  if (process.platform === 'win32') return null;
  const { stdout } = await execute('ps', ['-o', 'pgid=', '-p', String(process.pid)]);
  return Number(stdout.trim()) === process.pid ? process.pid : null;
}

function exists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/** Only a dead group leader can be reclaimed; a live owner is never displaced. */
export async function fenceDeadOwner(pid: number, group: number | null): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid shared host owner PID.');
  if (exists(pid)) throw new Error('FENCING_REQUIRED: the shared host owner is still alive.');
  if (group !== pid || process.platform === 'win32')
    throw new Error('FENCING_REQUIRED: the previous host did not isolate its provider processes.');
  try {
    if (!exists(-group)) return;
    process.kill(-group, 'SIGKILL');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return;
    // macOS answers EPERM for a group whose members have all exited but are
    // not yet reaped. The wait below tells that apart from one that stays.
    if (code !== 'EPERM') throw error;
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if (!exists(-group)) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
    await delay(50);
  }
  throw new Error('FENCING_REQUIRED: the previous provider process group has not exited.');
}

/**
 * Kill a process and every process descended from it, whatever group each is
 * in.
 *
 * A watcher and each session host it runs are started detached, so each leads
 * its own process group, and a provider a session host starts sits in that
 * host's group. Killing one group therefore leaves the rest: kill a watcher's
 * and its session hosts carry on, still holding their sessions' locks. This
 * walks the tree instead. For a process that would not stop when asked;
 * there is no grace here.
 */
export async function killProcessTree(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid process to kill.');
  if (process.platform === 'win32') {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    return;
  }
  const { stdout } = await execute('ps', ['-A', '-o', 'pid=,ppid=']);
  const children = new Map<number, number[]>();
  for (const line of stdout.split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (!child || parent === undefined || Number.isNaN(parent)) continue;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const doomed: number[] = [];
  const visit = (next: number) => {
    doomed.push(next);
    for (const child of children.get(next) ?? []) visit(child);
  };
  visit(pid);
  for (const target of doomed) {
    try {
      process.kill(target, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
}

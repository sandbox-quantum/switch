import { execFile, type ExecFileOptions } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { descendants, listWindowsProcesses, reused, windowsProcess } from './windows-processes';

/** Bound when called, so a test that mocks `node:child_process` without it can still import this. */
function execute(file: string, args: string[], options: ExecFileOptions = {}) {
  return promisify(execFile)(file, args, { ...options, encoding: 'utf8' }) as Promise<{
    stdout: string;
    stderr: string;
  }>;
}

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

/**
 * When this process started, as an owner record keeps it on Windows, where
 * ids are reused soon and a process's children are found by creation time
 * rather than by group. Null elsewhere: groups do that job.
 */
export function ownStartTime(): number | null {
  return process.platform === 'win32' ? Math.floor(performance.timeOrigin) : null;
}

/**
 * Only a dead group leader can be reclaimed; a live owner is never displaced.
 * `startedAt` is when the owner started, where its record says (Windows).
 */
export async function fenceDeadOwner(
  pid: number,
  group: number | null,
  startedAt: number | null
): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid shared host owner PID.');
  if (process.platform === 'win32') return fenceDeadWindowsOwner(pid, startedAt);
  if (exists(pid)) throw new Error('FENCING_REQUIRED: the shared host owner is still alive.');
  if (group !== pid)
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
 * Windows has no process groups, so what a dead owner left behind is what
 * still names it as a parent, created after it started, and theirs in turn.
 * An owner whose id now belongs to a newer process is dead; one whose start
 * is not recorded cannot be told from such a process, so is taken as alive.
 */
async function fenceDeadWindowsOwner(pid: number, startedAt: number | null): Promise<void> {
  const processes = await listWindowsProcesses();
  const holder = processes.find((entry) => entry.pid === pid);
  if (holder && (startedAt === null || !reused(holder, startedAt)))
    throw new Error('FENCING_REQUIRED: the shared host owner is still alive.');
  const left = descendants(processes, pid, startedAt);
  if (left.length === 0) return;
  for (const entry of left) terminate(entry.pid);
  for (let attempt = 0; attempt < 20; attempt++) {
    const now = await listWindowsProcesses();
    const remaining = left.filter((entry) =>
      now.some((next) => next.pid === entry.pid && !reused(next, entry.createdAt))
    );
    if (remaining.length === 0) return;
    await delay(250);
  }
  throw new Error('FENCING_REQUIRED: the processes the previous host started have not exited.');
}

function terminate(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/**
 * The command line a live process was started with, or null when no process
 * has `pid`: what an owner record's PID is checked against before it is
 * stopped, so a reused id never stops someone else's process.
 */
export async function processCommandLine(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid process id ${pid}.`);
  if (process.platform === 'win32') {
    const entry = await windowsProcess(pid);
    // A process of another user reports no command line to this one.
    return entry ? (entry.commandLine ?? '') : null;
  }
  try {
    const { stdout } = await execute('ps', ['-p', String(pid), '-o', 'command=']);
    return stdout;
  } catch (error) {
    if ((error as { code?: number }).code === 1) return null;
    throw error;
  }
}

/**
 * Whether `commandLine` names the state root `root`. Windows paths compare
 * without regard to case or slash direction.
 */
export function commandLineNames(commandLine: string, root: string): boolean {
  if (process.platform !== 'win32') return commandLine.includes(root);
  const normal = (value: string) => value.replaceAll('/', '\\').toLowerCase();
  return normal(commandLine).includes(normal(root));
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
    const processes = await listWindowsProcesses();
    const doomed = [pid, ...descendants(processes, pid, null).map((entry) => entry.pid)];
    for (const target of doomed) terminate(target);
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

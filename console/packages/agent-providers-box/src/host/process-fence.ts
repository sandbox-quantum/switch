import { execFile, type ExecFileOptions } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { isProcessAlive } from '../process-alive';
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

/** The thread-group id in a `/proc/<id>/status` text, or null if it has none. */
export function tgidOf(status: string): number | null {
  const match = /^Tgid:\s*(\d+)/m.exec(status);
  return match ? Number(match[1]) : null;
}

/**
 * Whether `pid` names a live process. On Linux `kill(id, 0)` also succeeds
 * for the id of any thread, and after a box restart a reused id often lands on
 * one (box B, 27 Oct: id 264 was a thread of a Claude CLI, so a stale lock
 * read as alive and its session never started). A thread is not an owner.
 */
export function processExists(pid: number): boolean {
  if (!exists(pid)) return false;
  if (process.platform !== 'linux') return true;
  try {
    const tgid = tgidOf(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return tgid === null || tgid === pid;
  } catch {
    return exists(pid);
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
  startedAt: number | null,
  recordPath: string | null = null,
  probes: OwnerProbes = systemProbes
): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid shared host owner PID.');
  if (process.platform === 'win32') return fenceDeadWindowsOwner(pid, startedAt);
  if (recordPath !== null) {
    const verdict = await judgeOwnerRecord(recordPath, pid, probes);
    if (verdict.kind === 'alive' || verdict.kind === 'unknown')
      throw new Error(
        verdict.kind === 'alive'
          ? 'FENCING_REQUIRED: the shared host owner is still alive.'
          : 'FENCING_REQUIRED: the shared host owner may still be alive; its start could not be read.'
      );
    // Stale for any reason but "gone": the record names nothing of ours that
    // could still be running (written before this box, a thread of another
    // process, or an id handed on), so there is nothing to fence and nothing
    // is killed. Only a leader that died inside this box's life leaves a group
    // worth fencing below.
    if (verdict.reason !== 'gone') return;
  } else if (probes.exists(pid)) {
    throw new Error('FENCING_REQUIRED: the shared host owner is still alive.');
  }
  if (group !== pid)
    throw new Error('FENCING_REQUIRED: the previous host did not isolate its provider processes.');
  try {
    if (!isProcessAlive(-group, 'any-user')) return;
    process.kill(-group, 'SIGKILL');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return;
    // macOS answers EPERM for a group whose members have all exited but are
    // not yet reaped. The wait below tells that apart from one that stays.
    if (code !== 'EPERM') throw error;
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!isProcessAlive(-group, 'any-user')) return;
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
  // Linux: from `/proc`, as `processStartedAt` reads start times. Called for
  // every owner record on every observe, so a `ps` here was a child process
  // many times a second with hosts awake. Read bounded and off the event
  // loop: a process can be started with megabytes of arguments.
  if (process.platform === 'linux') {
    try {
      return await procCommandLine(pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      // Anything else unreadable: `ps` below decides.
    }
  }
  try {
    const { stdout } = await execute('ps', ['-p', String(pid), '-o', 'command=']);
    return stdout;
  } catch (error) {
    if ((error as { code?: number }).code === 1) return null;
    throw error;
  }
}

/** The most of `/proc/<pid>/cmdline` read: far more than a state root needs. */
export const COMMAND_LINE_MAX = 64 * 1024;

/**
 * A process's command line from `/proc/<pid>/cmdline`, its NUL-separated
 * arguments joined with spaces as `ps -o command=` prints them. One longer
 * than `COMMAND_LINE_MAX` is not read on and gives "" (it names no root).
 */
async function procCommandLine(pid: number): Promise<string> {
  const file = await open(`/proc/${pid}/cmdline`, 'r');
  try {
    // Most command lines fit the first 4 KiB; grown only when one does not.
    let buffer = Buffer.allocUnsafe(4096);
    let length = 0;
    for (;;) {
      if (length === buffer.length) {
        if (length > COMMAND_LINE_MAX) return '';
        const bigger = Buffer.allocUnsafe(Math.min(buffer.length * 2, COMMAND_LINE_MAX + 1));
        buffer.copy(bigger, 0, 0, length);
        buffer = bigger;
      }
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > COMMAND_LINE_MAX) return '';
    return buffer.toString('utf8', 0, length).split('\0').filter(Boolean).join(' ');
  } finally {
    await file.close();
  }
}

/**
 * When the process now holding `pid` started, in ms since the epoch to about a
 * second, or null when no process holds it.
 */
export async function processStartedAt(pid: number): Promise<number | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid process id ${pid}.`);
  if (process.platform === 'win32') return (await windowsProcess(pid))?.createdAt ?? null;
  // Linux: from `/proc`, as the box's own start is read, so a box without
  // `ps` still judges saved ids rather than reading every one as unknown.
  if (process.platform === 'linux') {
    try {
      const started = pidOneStartFrom(
        readFileSync('/proc/stat', 'utf8'),
        readFileSync(`/proc/${pid}/stat`, 'utf8')
      );
      if (started !== null) return started;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      // Anything else unreadable: `ps` below decides.
    }
  }
  try {
    const { stdout } = await execute('ps', ['-p', String(pid), '-o', 'etime=']);
    const elapsed = elapsedMs(stdout.trim());
    return elapsed === null ? null : Date.now() - elapsed;
  } catch (error) {
    if ((error as { code?: number }).code === 1) return null;
    throw error;
  }
}

/** `ps`'s `etime`, `[[dd-]hh:]mm:ss`, in ms; null for anything else. */
export function elapsedMs(etime: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime);
  if (!match) return null;
  const [, days = '0', hours = '0', minutes, seconds] = match;
  return (
    (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes!)) * 60 + Number(seconds!)) * 1000
  );
}

/** Slack for the second-level start time and for file times. */
const RECORD_TOLERANCE_MS = 2_000;

/**
 * What an owner record (a lock, a supervisor record) says about its owner now.
 * The one judgement every site that trusts a saved process id makes:
 *
 * - `alive`: a process holds the id and started before the record was
 *   written. The only verdict a stop or a kill may act on, and then only with
 *   the command-line check besides.
 * - `stale`: the record names nobody alive. Replace it; kill nothing on its
 *   account. `predates-box` (written before this machine or sandbox started,
 *   so nothing in it is alive), `gone`, `not-a-process` (the id is a thread of
 *   another process; Linux answers kill(id, 0) for threads), `predates-holder`
 *   (the id was handed to a later process), `no-record`.
 * - `unknown`: a process holds the id but its start cannot be read. Never
 *   grounds for a kill, and not for a takeover either: wait and look again.
 */
export type OwnerVerdict =
  | { kind: 'alive' }
  | { kind: 'unknown' }
  | {
      kind: 'stale';
      reason: 'no-record' | 'predates-box' | 'gone' | 'not-a-process' | 'predates-holder';
    };

/** What `judgeOwnerRecord` reads from the system, injectable for tests. */
export interface OwnerProbes {
  platform: NodeJS.Platform;
  recordTime: (path: string) => Promise<number | null>;
  boxStartedAt: () => Promise<number | null>;
  exists: (pid: number) => boolean;
  threadGroupOf: (pid: number) => number | null;
  startedAt: (pid: number) => Promise<number | null>;
}

async function recordTime(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function threadGroupOf(pid: number): number | null {
  try {
    return tgidOf(readFileSync(`/proc/${pid}/status`, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * When a process started, from `/proc/stat` (the boot time) and its own
 * `/proc/<pid>/stat` (its start in clock ticks after boot), in ms since the
 * epoch; null when either cannot be read as such. For pid 1 that is the box's
 * own start in a sandbox, the machine's boot on a laptop. Linux reads `/proc`
 * (no `ps`); macOS asks `ps` about launchd; null on Windows.
 */
export function pidOneStartFrom(
  procStat: string,
  pidOneStat: string,
  ticksPerSecond = 100
): number | null {
  const boot = /^btime\s+(\d+)/m.exec(procStat);
  const fields = pidOneStat.slice(pidOneStat.lastIndexOf(')') + 2).split(' ');
  const ticks = Number(fields[19]);
  if (!boot || !Number.isFinite(ticks)) return null;
  return (Number(boot[1]) + ticks / ticksPerSecond) * 1000;
}

let boxStart: Promise<number | null> | null = null;
function boxStartedAt(): Promise<number | null> {
  boxStart ??= (async () => {
    if (process.platform === 'linux') {
      try {
        return pidOneStartFrom(
          readFileSync('/proc/stat', 'utf8'),
          readFileSync('/proc/1/stat', 'utf8')
        );
      } catch {
        return null;
      }
    }
    if (process.platform === 'win32') return null;
    return processStartedAt(1).catch(() => null);
  })();
  return boxStart;
}

const systemProbes: OwnerProbes = {
  platform: process.platform,
  recordTime,
  boxStartedAt,
  exists,
  threadGroupOf,
  startedAt: processStartedAt,
};

const noted = new Set<string>();

/**
 * One INFO line the first time a record is judged stale: the folder it sits
 * in (a session's or agent's id), the reason and when the record was written.
 * Never content. Once per record, so a check that polls does not flood the log.
 */
/**
 * The session or watcher folder a path lies in (`sdk-sessions/<id>` or
 * `watchers/<id>`), for logs: the full path names the user's home folder.
 */
export function recordFolder(path: string): string {
  const parts = path.split(/[\\/]/);
  const at = parts.findIndex((part) => part === 'sdk-sessions' || part === 'watchers');
  if (at >= 0 && parts[at + 1]) return `${parts[at]}/${parts[at + 1]}`;
  return parts.at(-2) ?? '';
}

function noteStale(
  path: string,
  reason: string,
  written: number,
  log: (line: string) => void
): void {
  const key = `${path}:${written}:${reason}`;
  if (noted.has(key)) return;
  noted.add(key);
  log(
    `Owner record judged stale (${reason}): ${recordFolder(path)}, written ${new Date(written).toISOString()}; replacing it, nothing killed.`
  );
}

/** See `OwnerVerdict`. */
export async function judgeOwnerRecord(
  path: string,
  pid: number,
  probes: OwnerProbes = systemProbes,
  log: (line: string) => void = (line) => console.info(line)
): Promise<OwnerVerdict> {
  const verdict = await judge(path, pid, probes);
  if (verdict.kind === 'stale' && verdict.reason !== 'no-record') {
    const written = await probes.recordTime(path);
    if (written !== null) noteStale(path, verdict.reason, written, log);
  }
  return verdict;
}

async function judge(path: string, pid: number, probes: OwnerProbes): Promise<OwnerVerdict> {
  const written = await probes.recordTime(path);
  if (written === null) return { kind: 'stale', reason: 'no-record' };
  // The cheapest guard, needing neither `ps` nor the holder: nothing written
  // before this box started can name a process alive in it.
  const box = await probes.boxStartedAt();
  if (box !== null && written < box - RECORD_TOLERANCE_MS)
    return { kind: 'stale', reason: 'predates-box' };
  if (!probes.exists(pid)) return { kind: 'stale', reason: 'gone' };
  if (probes.platform === 'linux') {
    const group = probes.threadGroupOf(pid);
    if (group !== null && group !== pid) return { kind: 'stale', reason: 'not-a-process' };
  }
  const started = await probes.startedAt(pid);
  if (started === null) {
    // Gone between the two looks (it exited mid-check), or unreadable.
    return probes.exists(pid) ? { kind: 'unknown' } : { kind: 'stale', reason: 'gone' };
  }
  if (written < started - RECORD_TOLERANCE_MS) return { kind: 'stale', reason: 'predates-holder' };
  return { kind: 'alive' };
}

/**
 * Whether the record at `path` names nobody alive (`judgeOwnerRecord` says
 * stale). An unknown verdict is not stale: it is looked at again later.
 */
export async function recordPredatesHolder(path: string, pid: number): Promise<boolean> {
  return (await judgeOwnerRecord(path, pid)).kind === 'stale';
}

/**
 * Whether the owner recorded at `path` as `pid` may still be alive: alive, or
 * unknown (and so not to be displaced yet). For decisions that only read or
 * replace a record; a stop needs `judgeOwnerRecord` to say `alive`.
 */
export async function recordedOwnerAlive(path: string, pid: number): Promise<boolean> {
  return (await judgeOwnerRecord(path, pid)).kind !== 'stale';
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

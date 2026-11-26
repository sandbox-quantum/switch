/**
 * Box mode only: judging a saved process id (an owner lock, a supervisor
 * record) after a box restart, where ids are reused at once and the controller
 * and the agents run as different users. Loaded only through a dynamic import
 * behind `options.box`, so Console's own hosts never run it.
 */
import { execFile, type ExecFileOptions } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fenceDeadOwner, processCommandLine } from '../process-fence';

function execute(file: string, args: string[], options: ExecFileOptions = {}) {
  return promisify(execFile)(file, args, { ...options, encoding: 'utf8' });
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
 * Fences a dead owner as `fenceDeadOwner` does, judging its record first: only
 * an owner that died inside this box's life leaves a process group worth
 * fencing. A record naming nothing of ours (written before this box, a thread
 * of another process, an id handed on) has nothing to fence, and nothing is
 * killed on its account. Alive or unknown refuses, as a live owner does.
 */
export async function boxFenceDeadOwner(
  pid: number,
  group: number | null,
  startedAt: number | null,
  recordPath: string,
  probes: OwnerProbes = systemProbes
): Promise<void> {
  if (process.platform !== 'win32') {
    const verdict = await judgeOwnerRecord(recordPath, pid, probes);
    if (verdict.kind === 'alive' || verdict.kind === 'unknown')
      throw new Error(
        verdict.kind === 'alive'
          ? 'FENCING_REQUIRED: the shared host owner is still alive.'
          : 'FENCING_REQUIRED: the shared host owner may still be alive; its start could not be read.'
      );
    if (verdict.reason !== 'gone') return;
  }
  await fenceDeadOwner(pid, group, startedAt);
}

export async function boxProcessCommandLine(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid process id ${pid}.`);
  if (process.platform === 'win32') {
    return processCommandLine(pid);
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
  return processCommandLine(pid);
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
  if (process.platform === 'win32') return null;
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
 * Whether the ticket at `path` was written before the process now holding
 * `pid` started: left by an earlier process with that id (after a restart),
 * so it is no contender. Never true on Windows, whose ids are not checked here.
 */
export async function ticketPredatesHolder(path: string, pid: number): Promise<boolean> {
  if (process.platform === 'win32') return false;
  // A ticket in an election under way is seconds old, and one left by an
  // earlier process is older: only those are worth a look, so a busy election
  // does not run `ps` for every rival on every pass.
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (Date.now() - mtimeMs < 5_000) return false;
  // Written before this box (or machine) started: nothing in it can be alive.
  // `process-fence`'s box-start check, written out: boot time plus pid 1's
  // start ticks, from /proc, with no `ps`.
  if (process.platform === 'linux') {
    try {
      const boot = /^btime\s+(\d+)/m.exec(readFileSync('/proc/stat', 'utf8'));
      const pidOne = readFileSync('/proc/1/stat', 'utf8');
      const ticks = Number(pidOne.slice(pidOne.lastIndexOf(')') + 2).split(' ')[19]);
      if (
        boot &&
        Number.isFinite(ticks) &&
        mtimeMs < (Number(boot[1]) + ticks / 100) * 1000 - 2_000
      )
        return true;
    } catch {
      // Unreadable: fall through to the per-id checks.
    }
  }
  // On Linux a thread's id answers kill(id, 0) too; a thread of some other
  // process is no contender (`process-fence`'s `processExists`, written out).
  if (process.platform === 'linux') {
    try {
      const tgid = /^Tgid:\s*(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1];
      if (tgid !== undefined && Number(tgid) !== pid) return true;
    } catch (error) {
      // Only "no such process" makes it stale. Any other read error counts the
      // rival, or an election could end with two winners.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      return false;
    }
  }
  const etime = await new Promise<string | null>((resolve) =>
    execFile('ps', ['-p', String(pid), '-o', 'etime='], { encoding: 'utf8' }, (error, stdout) =>
      resolve(error ? null : stdout.trim())
    )
  );
  const match = etime === null ? null : /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime);
  if (!match) return false;
  const [, days = '0', hours = '0', minutes, seconds] = match;
  const elapsed =
    (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes!)) * 60 + Number(seconds!)) * 1000;
  return mtimeMs < Date.now() - elapsed - 2_000;
}

/**
 * The box's `TicketJudge` for `ownership-lock`: this process's own id counts
 * only for a ticket it holds right now; any other id counts while it answers
 * as alive and its ticket isn't older than the process holding it.
 */
export async function boxTicketJudge(path: string, pid: number, own: boolean): Promise<boolean> {
  if (pid === process.pid) return !own;
  return !exists(pid) || (await ticketPredatesHolder(path, pid));
}

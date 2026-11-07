import * as childProcess from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

/**
 * Host side of the bridge's own `bash` (`./bridge.ts`, ER-06): reads the process registry the
 * bridge writes and signals the registered process groups after checking that they are still the
 * ones the bridge created. Which groups to stop, when, and how to confirm they are gone is the
 * adapter's stop policy (Q1); this module only gives it the registry and a checked signal.
 *
 * The registry is a JSON-lines file, appended and fsynced by the bridge:
 * - `intent` before a shell is spawned (`toolCallId`, `run`, `marker`);
 * - `spawn` right after (`pid`, `pgid` = `pid`: every shell leads its own group, `starttime` from
 *   `/proc/<pid>/stat` where there is procfs; `ppid`: the bridge's own process, the shell's parent;
 *   `args`: `piBashArgsFingerprint` of the command line the shell was started with);
 * - `lstart` where there is no procfs (D-15), once the bridge's `ps` answered: the shell's start
 *   (`lstart`) and the bridge's own (`plstart`) as `ps -o lstart=` prints them, read while the
 *   shell was not yet reaped (R11-A, R11-D). An older `spawn` may carry `lstart` itself;
 * - `kill` when the bridge signalled the group itself (abort, timeout, or a failed pipe or output
 *   callback; `sent: false` and the error `code` when the signal failed, which leaves the group's
 *   state unknown, except `ESRCH`: no process was left in the group, so it is gone), `exit` when
 *   the shell ends. Members of the group may outlive the shell, so `exit` does not mean the group
 *   is empty. After `exit` the bridge sends nothing to the group. The bridge writes at most one
 *   `kill` per shell (R7-C); a second one is not trusted.
 * Every process of a shell carries `SWITCH_PI_TC=<instance>:<toolCallId>` in its environment, which
 * identifies the group's members once its leader is gone (P-03(c)).
 *
 * D-18: every shell also carries a label of its own in its command line (`label` in `intent` and
 * `spawn`: 32 hex digits, 128 random bits, a word of its own after the command, see `./bridge.ts`),
 * which `ps` shows where no environment can be read. Where there is no procfs the bridge records,
 * in `lstart`, the digest of the command line `ps` printed for the shell while it carried its label
 * (`cmd`, `piBashPsArgsDigest`). The label is visible to every user of the machine in the process
 * list; it is random and says nothing of the command.
 */

/** Environment variable the bridge sets for every shell it starts. */
export const PI_BASH_MARKER_ENV = 'SWITCH_PI_TC';
/** Version of the registry records (`v`). */
export const PI_BASH_REGISTRY_VERSION = 1;

/** One shell the bridge started, folded from its registry records. */
export interface PiBashGroup {
  /** Bridge instance (one per Pi process). */
  instance: string;
  toolCallId: string;
  /** Pi run that approved the call. */
  run: number;
  /** Value of `SWITCH_PI_TC` in the group's environment. */
  marker: string;
  pid: number;
  pgid: number;
  /** Field 22 of `/proc/<pid>/stat` when the bridge recorded the spawn; `null` if unknown. */
  starttime: string | null;
  /**
   * The shell's start as `ps -o lstart=` printed it (whitespace collapsed), recorded by the bridge
   * where procfs gave no `starttime` (D-15); absent otherwise. Only the `ps` path reads it.
   */
  lstart?: string;
  /**
   * The shell's parent when it was spawned: the process of the bridge (Pi), recorded at the spawn
   * (R11-A). Only the `ps` path reads it.
   */
  ppid?: number;
  /** That parent's start as `ps -o lstart=` printed it, recorded with `lstart` (R11-A). */
  parentLstart?: string;
  /**
   * `piBashArgsFingerprint` of the command line the bridge started the shell with (R11-A): a leader
   * whose command line differs has run `exec` since. Only the `ps` path reads it.
   */
  args?: string;
  /**
   * D-18: the shell's own label, a word of its command line (`intent`, `spawn`). Only the `ps`
   * path reads it.
   */
  label?: string;
  /**
   * D-18: `piBashPsArgsDigest` of the command line `ps` printed for the shell while it carried its
   * label, recorded with `lstart`. Only the `ps` path reads it.
   */
  psArgs?: string;
  /** Whether the shell itself ended (`exit`); the group may still have members. */
  shellExited: boolean;
  /**
   * Whether the bridge sent SIGKILL to the group itself (`kill` with the signal sent). The signal
   * was sent; that the group is gone is not confirmed by it.
   */
  killedByBridge: boolean;
  /**
   * Whether the bridge tried to signal the group and the signal failed: state unknown. Not set for
   * `ESRCH`, which says the group no longer existed (then neither this nor `killedByBridge`).
   */
  bridgeKillFailed: boolean;
}

/** A shell announced with `intent` but never recorded as spawned. */
export interface PiBashIntent {
  instance: string;
  toolCallId: string;
  run: number;
  marker: string;
  /** D-18: the label its command line carries, when the bridge gave it one. */
  label?: string;
}

export interface PiBashRegistry {
  groups: PiBashGroup[];
  /** Intents without a `spawn`: the spawn failed, or Pi died before recording it. */
  unspawned: PiBashIntent[];
  /** Lines that are not registry records (for example a line cut off by a crash). */
  invalidLines: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `ps` pads `lstart` (`Wed Nov  4 …`); the bridge and the checks compare it with runs collapsed. */
const normalizeLstart = (text: string) => text.trim().replace(/\s+/g, ' ');

/**
 * `lstart` as `ps` prints it with `LC_ALL=C` (`%a %b %e %H:%M:%S %Y`), whitespace collapsed.
 * Anything else (a cut-off date, `unavailable`, a header) is not a start time (R11-B).
 */
const LSTART =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):[0-5]\d:[0-5]\d \d{4}$/;
/** The collapsed `lstart` when `text` is one; `undefined` otherwise. */
const validLstart = (text: unknown): string | undefined => {
  if (typeof text !== 'string') return undefined;
  const collapsed = normalizeLstart(text);
  return LSTART.test(collapsed) ? collapsed : undefined;
};
/** A PID as the registry may hold it: an integer above 1 that fits `pid_t`. */
const isPid = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 1 && (value as number) <= 2_147_483_647;
const FINGERPRINT = /^[0-9a-f]{64}$/;
/** D-18: a shell's label, as the bridge makes it: at least 128 random bits in hex. */
const LABEL = /^[0-9a-f]{32,128}$/;
const validLabel = (value: unknown): string | undefined =>
  typeof value === 'string' && LABEL.test(value) ? value : undefined;

/**
 * D-18: digest (SHA-256, hex) of a command line exactly as `ps -o args=` printed it
 * (`readPiPsCommand`'s `args`). The bridge records it for the shell while the shell carries its
 * label; the `ps` path accepts a leader only with the same command line, so any `exec` that
 * changed the command line (or dropped the label) since is refused. `./bridge.ts` computes the
 * same digest in its own body (it cannot import this module).
 */
export function piBashPsArgsDigest(args: string): string {
  return crypto.createHash('sha256').update(args, 'utf8').digest('hex');
}

/** D-18: whether `label` is a word of the command line `args` (words split at whitespace). */
const carriesLabel = (args: string, label: string) => args.split(/\s+/).includes(label);

/**
 * Fingerprint of a command line (R11-A): SHA-256 (hex) of its ASCII letters and digits only.
 * `ps` prints a command line in its own way (procps: a space for each separator and newline, `?`
 * for each byte outside printable ASCII, `.` for a tab; macOS: `needs-source`), so only what every
 * such rendering keeps is compared. The bridge fingerprints the arguments it spawned the shell with
 * (`argv` joined with spaces), the `ps` path what `ps -o args=` prints for the leader; a leader that
 * has run `exec` since has another command line, so another fingerprint.
 */
export function piBashArgsFingerprint(commandLine: string | readonly string[]): string {
  const text = typeof commandLine === 'string' ? commandLine : commandLine.join(' ');
  return crypto
    .createHash('sha256')
    .update(text.replace(/[^A-Za-z0-9]/g, ''))
    .digest('hex');
}

/** Folds registry text into groups. Unknown or broken lines are counted, never trusted. */
export function parsePiBashRegistry(text: string): PiBashRegistry {
  const groups = new Map<string, PiBashGroup>();
  const intents = new Map<string, PiBashIntent>();
  // Groups that already have their one `kill` record (R7-C).
  const killRecorded = new Set<string>();
  // Groups that already have their one `lstart` record (D-15, R11-A).
  const lstartRecorded = new Set<string>();
  let invalidLines = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      invalidLines += 1;
      continue;
    }
    if (
      !isRecord(entry) ||
      entry.v !== PI_BASH_REGISTRY_VERSION ||
      typeof entry.instance !== 'string' ||
      typeof entry.toolCallId !== 'string'
    ) {
      invalidLines += 1;
      continue;
    }
    const key = `${entry.instance}\n${entry.toolCallId}`;
    if (entry.event === 'intent' && typeof entry.marker === 'string') {
      const label = validLabel(entry.label);
      intents.set(key, {
        instance: entry.instance,
        toolCallId: entry.toolCallId,
        run: typeof entry.run === 'number' ? entry.run : 0,
        marker: entry.marker,
        ...(label === undefined ? {} : { label }),
      });
    } else if (
      entry.event === 'spawn' &&
      typeof entry.marker === 'string' &&
      Number.isSafeInteger(entry.pid) &&
      (entry.pid as number) > 1 &&
      entry.pgid === entry.pid
    ) {
      // Only a start time in `ps`'s format is one (R11-B): `unavailable` or a cut-off date is none.
      const lstart = validLstart(entry.lstart);
      // D-18: the label of the spawn; one that contradicts the intent's is none.
      const intended = intents.get(key)?.label;
      const spawned = validLabel(entry.label);
      const label = intended === undefined || intended === spawned ? spawned : undefined;
      groups.set(key, {
        instance: entry.instance,
        toolCallId: entry.toolCallId,
        run: typeof entry.run === 'number' ? entry.run : 0,
        marker: entry.marker,
        pid: entry.pid as number,
        pgid: entry.pgid as number,
        starttime: typeof entry.starttime === 'string' ? entry.starttime : null,
        ...(lstart === undefined ? {} : { lstart }),
        ...(isPid(entry.ppid) ? { ppid: entry.ppid } : {}),
        ...(typeof entry.args === 'string' && FINGERPRINT.test(entry.args)
          ? { args: entry.args }
          : {}),
        ...(label === undefined ? {} : { label }),
        shellExited: false,
        killedByBridge: false,
        bridgeKillFailed: false,
      });
      intents.delete(key);
    } else if (entry.event === 'lstart') {
      // D-15: the starts the bridge's `ps` read for a shell it had not reaped (R11-A). One per
      // shell, before its `exit`, both in `ps`'s format; anything else is not trusted.
      const group = groups.get(key);
      const lstart = validLstart(entry.lstart);
      const parentLstart = validLstart(entry.plstart);
      // D-18: the digest of the command line, when the bridge read it with the label in it.
      const psArgs =
        typeof entry.cmd === 'string' && FINGERPRINT.test(entry.cmd) ? entry.cmd : undefined;
      if (
        !group ||
        entry.pid !== group.pid ||
        group.shellExited ||
        group.lstart !== undefined ||
        lstartRecorded.has(key) ||
        lstart === undefined ||
        parentLstart === undefined ||
        (entry.cmd !== undefined && psArgs === undefined)
      ) {
        invalidLines += 1;
        // A second or broken one for this shell contradicts the first: neither is trusted.
        if (group && entry.pid === group.pid) {
          lstartRecorded.add(key);
          delete group.lstart;
          delete group.parentLstart;
          delete group.psArgs;
        }
      } else {
        lstartRecorded.add(key);
        group.lstart = lstart;
        group.parentLstart = parentLstart;
        if (psArgs !== undefined) group.psArgs = psArgs;
      }
    } else if (entry.event === 'exit' || entry.event === 'kill') {
      const group = groups.get(key);
      if (!group || entry.pid !== group.pid) {
        invalidLines += 1;
      } else if (entry.event === 'exit') {
        group.shellExited = true;
      } else if (killRecorded.has(key)) {
        // The first `kill` stands; a second would contradict it.
        invalidLines += 1;
      } else {
        killRecorded.add(key);
        if (entry.sent !== false) group.killedByBridge = true;
        else if (entry.error !== 'ESRCH') group.bridgeKillFailed = true;
      }
    } else {
      invalidLines += 1;
    }
  }
  return { groups: [...groups.values()], unspawned: [...intents.values()], invalidLines };
}

/** Reads a registry file; a missing file is an empty registry. */
export function readPiBashRegistry(file: string): PiBashRegistry {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { groups: [], unspawned: [], invalidLines: 0 };
    }
    throw error;
  }
  return parsePiBashRegistry(text);
}

/** Fields of `/proc/<pid>/stat` the checks use. */
export interface PiProcStat {
  pid: number;
  state: string;
  pgrp: number;
  sid: number;
  starttime: string;
}

export interface PiProcOptions {
  /** Root of procfs; `/proc` by default. */
  procRoot?: string;
  /**
   * `ps` command for a system without procfs (macOS, D-15); `ps` by default. Whether the `ps` path
   * is taken is `piProcSource`'s rule (given or not, it is one input of it).
   */
  ps?: string;
  /** User the group's leader must run as on the `ps` path; this process's effective user by default. */
  uid?: number;
}

/** Root of the system's procfs: where it is absent, the system has none (macOS). */
const SYSTEM_PROC_ROOT = '/proc';

/** Where processes are read, and what the root of procfs held (`piProcSource`). */
export interface PiProcSource {
  /**
   * `procfs`: read procfs (whose reads say what they cannot see); `ps`: there is no procfs, `ps`
   * answers; `none`: neither can be trusted (a root someone passed that holds nothing, without a
   * `ps` given): whatever asks gets no answer, never an empty one.
   */
  source: 'procfs' | 'ps' | 'none';
  /**
   * `complete`: `self` is there; `incomplete`: processes (`<pid>`) but no `self`; `unreadable`: it
   * could not be listed (other than absent); `absent`: it does not exist (`ENOENT`, `ENOTDIR`);
   * `empty`: neither `self` nor any process (an empty mount point, or an empty directory).
   */
  root: 'complete' | 'incomplete' | 'unreadable' | 'absent' | 'empty';
}

/**
 * The one rule of where processes are read (D-15, R11-C, R7-C), for the bridge (`./bridge.ts`,
 * where it records a shell's start), the checks here (`verifyPiBashGroup`), the adapter and the
 * conversation store (`./pi-adapter.ts`, `./pi-conversation.ts`): chosen by what is there, not by
 * platform. `list` lists `root` (`readdirSync`); `psGiven`: a `ps` was passed (tests that hide
 * procfs, and the adapter's view without procfs).
 * - A root that does not exist has no procfs: `ps` (R1-I).
 * - A root with `self`, or with processes but no `self` (procfs that is incomplete, R11-C), is
 *   procfs; so is one that cannot be listed (its reads fail and say so, `inspection_failed`).
 * - A root that holds neither `self` nor any process is no procfs: `ps` for the system's root
 *   (`/proc`, an empty mount point) or when `ps` was given; any other root (a directory someone
 *   passed without `ps`) is no authoritative source at all (`none`, R7-C, Codex A12): an empty
 *   directory must never read as "no process left".
 *
 * Self-contained (it reads nothing from outside its body but built-ins): the bridge and the store,
 * which are serialized with `fn.toString()`, are given this very function (`bridgeSource`,
 * `piRecoverSource`), so every place decides by one code.
 */
export function piProcSource(
  root: string,
  psGiven: boolean,
  list: (root: string) => string[]
): PiProcSource {
  let entries: string[];
  try {
    entries = list(root);
  } catch (error) {
    const code = (error as { code?: unknown } | null | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { source: 'ps', root: 'absent' };
    return { source: 'procfs', root: 'unreadable' };
  }
  if (entries.includes('self')) return { source: 'procfs', root: 'complete' };
  if (entries.some((name) => /^\d+$/.test(name))) return { source: 'procfs', root: 'incomplete' };
  return { source: psGiven || root === '/proc' ? 'ps' : 'none', root: 'empty' };
}

/** `piProcSource` for `options` (the root, and whether `ps` was given). */
function procSourceOf(options: PiProcOptions): PiProcSource {
  return piProcSource(options.procRoot ?? SYSTEM_PROC_ROOT, options.ps !== undefined, (root) =>
    fs.readdirSync(root)
  );
}

/**
 * Where processes are read (D-15): `ps` exactly when `piProcSource` says so; otherwise procfs. A
 * root that is no source at all (`none`) is reported as procfs here (the path that fails rather
 * than answers); `verifyPiBashGroup` refuses it (`inspection_failed`).
 */
export function piBashProcessView(options: PiProcOptions = {}): 'procfs' | 'ps' {
  return procSourceOf(options).source === 'ps' ? 'ps' : 'procfs';
}

/** Largest value of a `pid_t` (and of a process group id). */
const PID_MAX = 2_147_483_647;
/** Largest user id; `(uid_t)-1` is no user. */
const UID_MAX = 4_294_967_294;
/**
 * `stat` as `ps` prints it (R11-B): a state letter (procps: `D I R S T t W X Z`; macOS:
 * `I R S T U Z`, `needs-source`), then flags (procps: `< N L s l +`; macOS: `+ < > A E L N S s u V
 * W X`). Anything else is not a row.
 */
const PS_STATE = /^[DIRSTUWXZt][+<>AELNSVWXlsux]*$/;
/** A decimal number in `0…max` without a sign or leading junk; `undefined` otherwise. */
const boundedId = (text: string, max: number): number | undefined => {
  if (!/^\d{1,10}$/.test(text)) return undefined;
  const value = Number(text);
  return value <= max ? value : undefined;
};

/** One row of `ps -A -o pid=,ppid=,pgid=,uid=,stat=,lstart=`. */
export interface PiPsProcess {
  pid: number;
  /** Parent process (R11-A). */
  ppid: number;
  pgid: number;
  /** Effective user id. */
  uid: number;
  /** `stat`: the state letter first (`Z` = zombie), then flags. */
  state: string;
  /** Start of the process, whitespace collapsed (`normalizeLstart`). */
  lstart: string;
}

/** Runs `ps` with `args` the way every read here does; throws when it cannot or it fails. */
function runPs(options: PiProcOptions, args: string[]): string {
  const command = options.ps ?? 'ps';
  const result = childProcess.spawnSync(command, args, {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new PiProcInspectionError(command, errorCode(result.error));
  if (result.status !== 0) {
    throw new PiProcInspectionError(command, `exit ${result.status ?? result.signal ?? 'unknown'}`);
  }
  return result.stdout;
}

/**
 * Reads every process with `ps` (D-15), in one pass. Throws `PiProcInspectionError` when `ps`
 * cannot be run, fails, or prints anything that is not a row: the table is only returned when
 * every row was read. A row is read whole and in range (R11-B): PIDs and process groups fit a
 * `pid_t`, the user a `uid_t`, the state is one `ps` prints, `lstart` is a date in `ps`'s format.
 * A dead process (`X`, being reaped) is gone: its row is read, then left out. Its parent and group
 * may be gone too (procps prints its group as -1, `4294967295`, seen on Linux while a killed group
 * exited), so only those two may then be any 32-bit value. R12-B: a PID is in the table once, the
 * dead included: two rows of one PID (live or dead) contradict each other, and the table is not
 * read (`malformed`), never read as the one row that is left.
 * `-ww`: no column is cut to a terminal width; `LC_ALL=C` and `TZ=UTC`: the bridge records `lstart`
 * with the same environment, so equal starts print alike.
 */
export function readPiPsTable(options: PiProcOptions = {}): Map<number, PiPsProcess> {
  const command = options.ps ?? 'ps';
  const stdout = runPs(options, ['-A', '-ww', '-o', 'pid=,ppid=,pgid=,uid=,stat=,lstart=']);
  const table = new Map<number, PiPsProcess>();
  // R12-B: every PID of the output, dead rows included, before any row is left out.
  const seen = new Set<number>();
  const malformed = () => new PiProcInspectionError(command, 'malformed');
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    const row = /^\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S.*)$/.exec(line);
    if (!row) throw malformed();
    const state = row[5] as string;
    const dead = state.startsWith('X');
    const pid = boundedId(row[1] as string, PID_MAX);
    const ppid = boundedId(row[2] as string, dead ? UID_MAX + 1 : PID_MAX);
    const pgid = boundedId(row[3] as string, dead ? UID_MAX + 1 : PID_MAX);
    const uid = boundedId(row[4] as string, UID_MAX);
    const lstart = validLstart(row[6]);
    if (
      pid === undefined ||
      ppid === undefined ||
      pgid === undefined ||
      uid === undefined ||
      !PS_STATE.test(state) ||
      lstart === undefined
    ) {
      throw malformed();
    }
    if (seen.has(pid)) throw malformed();
    seen.add(pid);
    if (dead) continue;
    table.set(pid, { pid, ppid, pgid, uid, state, lstart });
  }
  // `ps` lists itself at least: an empty table was not read.
  if (table.size === 0) throw new PiProcInspectionError(command, 'empty');
  return table;
}

/** What `ps -o pid=,ppid=,lstart=,args= -p <pid>` prints of one process (R11-A). */
export interface PiPsCommand {
  pid: number;
  ppid: number;
  lstart: string;
  /** The command line as `ps` prints it; the lines after the first joined with `\n`. */
  args: string;
}

/**
 * Reads the command line of one process with `ps` (R11-A), with its PID, parent and start so that
 * the caller can tell it is the process of its table. Throws `PiProcInspectionError` when `ps`
 * fails (also when the process is gone: `ps -p` then fails, and a gone process is not told apart
 * from a failed read) or the first line is not a whole row. The command line is printed last and
 * may span lines; whatever follows the first line belongs to it.
 */
export function readPiPsCommand(pid: number, options: PiProcOptions = {}): PiPsCommand {
  const command = options.ps ?? 'ps';
  const stdout = runPs(options, ['-ww', '-o', 'pid=,ppid=,lstart=,args=', '-p', String(pid)]);
  const [first = '', ...rest] = stdout.replace(/\n$/, '').split('\n');
  const row = /^\s*(\S+)\s+(\S+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)(?:\s(.*))?$/.exec(first);
  const seenPid = row ? boundedId(row[1] as string, PID_MAX) : undefined;
  const ppid = row ? boundedId(row[2] as string, PID_MAX) : undefined;
  const lstart = row ? validLstart(row[3]) : undefined;
  if (seenPid === undefined || ppid === undefined || lstart === undefined) {
    throw new PiProcInspectionError(command, 'malformed');
  }
  return { pid: seenPid, ppid, lstart, args: [row?.[4] ?? '', ...rest].join('\n') };
}

/**
 * D-18: the live processes whose command line (`ps -A -ww -o pid=,stat=,args=`) holds one of
 * `labels` as a word, per label; where procfs finds a shell by the marker in its environment, the
 * `ps` path finds it by its label. Only processes that carry the label are found: the shell, or a
 * process it replaced itself with keeping its command line; a child it started does not carry it
 * (`./pi-adapter.ts` counts groups for those). Throws `PiProcInspectionError` when `ps` fails or
 * prints a line that is not a row (a PID and a state first): then nothing is known. A line of a
 * command line that spans lines (`needs-source` on macOS) that does not start like a row is such
 * a line, so the read fails rather than miss a label.
 */
export function readPiPsLabelled(
  labels: readonly string[],
  options: PiProcOptions = {}
): Map<string, number[]> {
  const command = options.ps ?? 'ps';
  const found = new Map<string, number[]>(labels.map((label) => [label, []]));
  if (labels.length === 0) return found;
  const stdout = runPs(options, ['-A', '-ww', '-o', 'pid=,stat=,args=']);
  let rows = 0;
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    const row = /^\s*(\S+)\s+(\S+)(?:\s(.*))?$/.exec(line);
    const pid = row ? boundedId(row[1] as string, PID_MAX) : undefined;
    const state = row?.[2] ?? '';
    if (pid === undefined || !PS_STATE.test(state)) {
      throw new PiProcInspectionError(command, 'malformed');
    }
    rows += 1;
    if (state.startsWith('Z') || state.startsWith('X')) continue;
    for (const label of labels) {
      if (carriesLabel(row?.[3] ?? '', label)) found.get(label)?.push(pid);
    }
  }
  if (rows === 0) throw new PiProcInspectionError(command, 'empty');
  return found;
}

/**
 * Procfs could not be read well enough to answer (ER-06): a failed inspection is never taken for
 * an empty group or a missing process.
 */
export class PiProcInspectionError extends Error {
  constructor(
    readonly path: string,
    readonly code: string
  ) {
    super(`cannot inspect ${path}: ${code}`);
    this.name = 'PiProcInspectionError';
  }
}

/** Errors that prove a process is gone: its procfs entry no longer exists. */
const isGone = (code: string) => code === 'ENOENT' || code === 'ESRCH';
const errorCode = (error: unknown) => String((error as NodeJS.ErrnoException).code ?? 'unknown');

/**
 * Reads `/proc/<pid>/stat`; `undefined` only when the process does not exist. Any other failure
 * (no permission, unreadable content) throws `PiProcInspectionError`.
 */
export function readPiProcStat(pid: number, options: PiProcOptions = {}): PiProcStat | undefined {
  const file = `${options.procRoot ?? '/proc'}/${pid}/stat`;
  let stat: string;
  try {
    stat = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (isGone(errorCode(error))) return undefined;
    throw new PiProcInspectionError(file, errorCode(error));
  }
  // The command name (field 2) may contain spaces and parentheses; the rest follows the last `)`.
  // Decoding as UTF-8 cannot move or add a `)` (bytes that are not UTF-8 become U+FFFD), and the
  // fields read after it are ASCII digits and a state letter (R6-B).
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const [state, , pgrp, sid] = rest;
  const starttime = rest[19];
  if (state === undefined || starttime === undefined) {
    throw new PiProcInspectionError(file, 'malformed');
  }
  return { pid, state, pgrp: Number(pgrp), sid: Number(sid), starttime };
}

/**
 * Live (not zombie) processes whose process group is `pgid`. Throws `PiProcInspectionError` when
 * procfs cannot be listed or a process in it cannot be read: an empty result is only returned when
 * every process was seen.
 */
export function piProcessGroupMembers(pgid: number, options: PiProcOptions = {}): PiProcStat[] {
  const root = options.procRoot ?? '/proc';
  const members: PiProcStat[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch (error) {
    throw new PiProcInspectionError(root, errorCode(error));
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = readPiProcStat(Number(entry), options);
    if (stat && stat.pgrp === pgid && stat.state !== 'Z') members.push(stat);
  }
  return members;
}

/**
 * Whether the process carries the marker; throws when its environment cannot be read. The entries
 * are compared as bytes (R6-B): the kernel holds the environment as bytes, and Node passed the
 * marker to the shell as UTF-8, so the expected entry is its UTF-8 encoding. Decoding `environ`
 * as text instead would miss a marker outside ASCII, or match bytes that merely decode alike.
 */
function hasMarker(pid: number, marker: string, options: PiProcOptions): boolean {
  const file = `${options.procRoot ?? '/proc'}/${pid}/environ`;
  let environ: Buffer;
  try {
    environ = fs.readFileSync(file);
  } catch (error) {
    // A process that is gone carries nothing; the caller refuses to treat it as verified.
    if (isGone(errorCode(error))) return false;
    throw new PiProcInspectionError(file, errorCode(error));
  }
  const expected = Buffer.from(`${PI_BASH_MARKER_ENV}=${marker}`, 'utf8');
  for (let start = 0; start < environ.length;) {
    const nul = environ.indexOf(0, start);
    const end = nul === -1 ? environ.length : nul;
    if (environ.subarray(start, end).equals(expected)) return true;
    start = end + 1;
  }
  return false;
}

export type PiBashVerification =
  | { ok: true; reason: 'leader_verified' | 'members_verified'; members: number }
  | {
      ok: false;
      reason:
        | 'group_empty'
        | 'starttime_unknown'
        | 'leader_starttime_mismatch'
        | 'leader_without_marker'
        | 'member_outside_session'
        | 'member_without_marker'
        /** `ps` path (D-15): the leader's PID now leads another group. */
        | 'leader_outside_group'
        /** `ps` path (D-15): the leader runs as another user. */
        | 'leader_other_user'
        /**
         * `ps` path (R11-A): the leader is not a child of the live process that spawned it (the
         * bridge's, with the start recorded), or that was not recorded.
         */
        | 'leader_parent_mismatch'
        /**
         * `ps` path (R11-A, D-18): the leader's command line is not the one it was spawned with
         * (it ran `exec`, which may have dropped the marker), it does not carry the shell's label
         * as a word, or that was not recorded.
         */
        | 'leader_command_mismatch'
        /** `ps` path (D-15): the leader is gone; without procfs no member's marker can be read. */
        | 'members_unverifiable';
      members: number;
    }
  /** Procfs (or `ps`) could not be read completely: the group's state is unknown, not empty. */
  | { ok: false; reason: 'inspection_failed'; members: null; error: string };

/**
 * Whether the group is still the one the bridge created. With the leader alive: same start time
 * and the marker in its environment (a reused PID has another start time). With the leader gone:
 * every member is in the leader's session and carries the marker. `group_empty` only when procfs was
 * read completely; a failed read is `inspection_failed`, which proves nothing about the group.
 *
 * Without procfs (`piBashProcessView`, D-15) `ps` answers, and no environment is read: that `ps`
 * can show another process's environment is not confirmed by a source for macOS, so the marker is
 * not the evidence there. The `ps` path accepts no group procfs would refuse (R11-A): `lstart` has
 * a resolution of one second, so the same PID, group, user and `lstart` do not tell the shell from
 * another process that got its PID in the same second, and a leader that ran `exec` may have
 * dropped the marker procfs would look for. So the group is the bridge's only when its leader is
 * alive, the bridge did not see it exit, and it is the process recorded: same PID leading the same
 * group, the `lstart` recorded, this user; still a child of the process that spawned it (`ppid`),
 * which is alive with the start recorded (`parentLstart`), so the shell was never reaped and its
 * PID never reused (a PID is free again only once its process is reaped); and with the command
 * line it was spawned with (`args`), so it ran no `exec`. D-18: and it carries the shell's own
 * label as a word of that command line, which is exactly (`psArgs`, `piBashPsArgsDigest`) the one
 * `ps` printed for the shell when the bridge recorded it: another shell of the same bridge, which
 * got the PID in the same second, has another label (R12-D), and an `exec` that changed the
 * command line at all (R12-A: also only by characters the fingerprint leaves out) is refused. One
 * case stays (known limit): a command that replaces itself (`exec`) keeping its exact command
 * line, label included, and dropping the marker is taken for the shell; it is the approved
 * command's own process, not a foreign one. Whatever cannot be shown is refused
 * (`leader_parent_mismatch`, `leader_command_mismatch`): a shell whose bridge is gone, or that ran
 * `exec` (as `bash -c` may for the last command it runs), is not signalled. A group whose leader is
 * gone cannot be verified then (`members_unverifiable`): nothing is sent to it.
 *
 * Where processes are read is `piProcSource`'s rule; a root that is no source at all (`none`) is a
 * failed inspection (R7-C).
 */
export function verifyPiBashGroup(
  group: PiBashGroup,
  options: PiProcOptions = {}
): PiBashVerification {
  try {
    const source = procSourceOf(options).source;
    if (source === 'none') {
      return { ok: false, reason: 'inspection_failed', members: null, error: 'no_source' };
    }
    return source === 'ps' ? verifyGroupWithPs(group, options) : verifyGroup(group, options);
  } catch (error) {
    if (error instanceof PiProcInspectionError) {
      return { ok: false, reason: 'inspection_failed', members: null, error: error.code };
    }
    throw error;
  }
}

function verifyGroup(group: PiBashGroup, options: PiProcOptions): PiBashVerification {
  const members = piProcessGroupMembers(group.pgid, options);
  const leader = readPiProcStat(group.pgid, options);
  if (leader && leader.state !== 'Z') {
    if (group.starttime === null) {
      return { ok: false, reason: 'starttime_unknown', members: members.length };
    }
    if (leader.starttime !== group.starttime) {
      return { ok: false, reason: 'leader_starttime_mismatch', members: members.length };
    }
    if (!hasMarker(group.pgid, group.marker, options)) {
      return { ok: false, reason: 'leader_without_marker', members: members.length };
    }
    return { ok: true, reason: 'leader_verified', members: members.length };
  }
  if (members.length === 0) return { ok: false, reason: 'group_empty', members: 0 };
  if (members.some((member) => member.sid !== group.pgid)) {
    return { ok: false, reason: 'member_outside_session', members: members.length };
  }
  if (members.some((member) => !hasMarker(member.pid, group.marker, options))) {
    return { ok: false, reason: 'member_without_marker', members: members.length };
  }
  return { ok: true, reason: 'members_verified', members: members.length };
}

/** `verifyGroup` without procfs (D-15): from one `ps` pass, with no marker. */
function verifyGroupWithPs(group: PiBashGroup, options: PiProcOptions): PiBashVerification {
  const table = readPiPsTable(options);
  const live = (row: PiPsProcess) => !row.state.startsWith('Z');
  const members = [...table.values()].filter((row) => row.pgid === group.pgid && live(row));
  const leader = table.get(group.pgid);
  // The bridge saw its shell exit: whatever has the PID now is not the shell (R11-A).
  if (leader && live(leader) && !group.shellExited) {
    const refuse = (
      reason:
        | 'starttime_unknown'
        | 'leader_starttime_mismatch'
        | 'leader_outside_group'
        | 'leader_other_user'
        | 'leader_parent_mismatch'
        | 'leader_command_mismatch'
    ): PiBashVerification => ({ ok: false, reason, members: members.length });
    if (group.lstart === undefined) return refuse('starttime_unknown');
    if (leader.lstart !== group.lstart) return refuse('leader_starttime_mismatch');
    // The shell leads its own session, so it cannot join another group: this is another process.
    if (leader.pgid !== group.pgid) return refuse('leader_outside_group');
    const uid = options.uid ?? process.geteuid?.();
    if (uid === undefined || leader.uid !== uid) return refuse('leader_other_user');
    // R11-A: a child of the process that spawned it, alive and the one recorded. While that parent
    // has not reaped the shell, no other process can have the shell's PID.
    const parent = group.ppid === undefined ? undefined : table.get(group.ppid);
    if (
      group.ppid === undefined ||
      group.parentLstart === undefined ||
      leader.ppid !== group.ppid ||
      parent === undefined ||
      !live(parent) ||
      parent.lstart !== group.parentLstart ||
      parent.uid !== uid
    ) {
      return refuse('leader_parent_mismatch');
    }
    // R11-A: the command line it was spawned with, read for the same process (PID, parent, start).
    if (group.args === undefined || group.label === undefined || group.psArgs === undefined) {
      return refuse('leader_command_mismatch');
    }
    const seen = readPiPsCommand(group.pgid, options);
    if (seen.pid !== group.pgid || seen.ppid !== group.ppid || seen.lstart !== group.lstart) {
      // Not the process of the table any more: its state is not known.
      throw new PiProcInspectionError(options.ps ?? 'ps', 'changed');
    }
    // D-18: the shell's own label, as a word, in exactly the command line recorded with it.
    if (!carriesLabel(seen.args, group.label)) return refuse('leader_command_mismatch');
    if (piBashPsArgsDigest(seen.args) !== group.psArgs) return refuse('leader_command_mismatch');
    if (piBashArgsFingerprint(seen.args) !== group.args) return refuse('leader_command_mismatch');
    return { ok: true, reason: 'leader_verified', members: members.length };
  }
  if (members.length === 0) return { ok: false, reason: 'group_empty', members: 0 };
  return { ok: false, reason: 'members_unverifiable', members: members.length };
}

export interface PiBashSignalResult {
  verification: PiBashVerification;
  /** Whether the signal was sent to the group. */
  sent: boolean;
  /** `code` of the error `kill` threw, if it did. */
  error?: string;
}

/**
 * Sends `signal` to the group, only after `verifyPiBashGroup` accepts it. Nothing is sent to a
 * group that cannot be verified, so a process that took over a recorded PID is left alone.
 */
export function signalPiBashGroup(
  group: PiBashGroup,
  signal: NodeJS.Signals,
  options: PiProcOptions & { kill?: (pid: number, signal: NodeJS.Signals) => void } = {}
): PiBashSignalResult {
  const verification = verifyPiBashGroup(group, options);
  if (!verification.ok) return { verification, sent: false };
  try {
    const kill = options.kill ?? ((pid: number, sig: NodeJS.Signals) => process.kill(pid, sig));
    kill(-group.pgid, signal);
    return { verification, sent: true };
  } catch (error) {
    return { verification, sent: false, error: String((error as NodeJS.ErrnoException).code) };
  }
}

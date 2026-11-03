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
 *   `/proc/<pid>/stat`);
 * - `kill` when the bridge signalled the group itself (abort, timeout, or a failed pipe or output
 *   callback; `sent: false` and the error `code` when the signal failed, which leaves the group's
 *   state unknown, except `ESRCH`: no process was left in the group, so it is gone), `exit` when
 *   the shell ends. Members of the group may outlive the shell, so `exit` does not mean the group
 *   is empty. After `exit` the bridge sends nothing to the group. The bridge writes at most one
 *   `kill` per shell (R7-C); a second one is not trusted.
 * Every process of a shell carries `SWITCH_PI_TC=<instance>:<toolCallId>` in its environment, which
 * identifies the group's members once its leader is gone (P-03(c)).
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

/** Folds registry text into groups. Unknown or broken lines are counted, never trusted. */
export function parsePiBashRegistry(text: string): PiBashRegistry {
  const groups = new Map<string, PiBashGroup>();
  const intents = new Map<string, PiBashIntent>();
  // Groups that already have their one `kill` record (R7-C).
  const killRecorded = new Set<string>();
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
      intents.set(key, {
        instance: entry.instance,
        toolCallId: entry.toolCallId,
        run: typeof entry.run === 'number' ? entry.run : 0,
        marker: entry.marker,
      });
    } else if (
      entry.event === 'spawn' &&
      typeof entry.marker === 'string' &&
      Number.isSafeInteger(entry.pid) &&
      (entry.pid as number) > 1 &&
      entry.pgid === entry.pid
    ) {
      groups.set(key, {
        instance: entry.instance,
        toolCallId: entry.toolCallId,
        run: typeof entry.run === 'number' ? entry.run : 0,
        marker: entry.marker,
        pid: entry.pid as number,
        pgid: entry.pgid as number,
        starttime: typeof entry.starttime === 'string' ? entry.starttime : null,
        shellExited: false,
        killedByBridge: false,
        bridgeKillFailed: false,
      });
      intents.delete(key);
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
        | 'member_without_marker';
      members: number;
    }
  /** Procfs could not be read completely: the group's state is unknown, not empty. */
  | { ok: false; reason: 'inspection_failed'; members: null; error: string };

/**
 * Whether the group is still the one the bridge created. With the leader alive: same start time
 * and the marker in its environment (a reused PID has another start time). With the leader gone:
 * every member is in the leader's session and carries the marker. `group_empty` only when procfs was
 * read completely; a failed read is `inspection_failed`, which proves nothing about the group.
 */
export function verifyPiBashGroup(
  group: PiBashGroup,
  options: PiProcOptions = {}
): PiBashVerification {
  try {
    return verifyGroup(group, options);
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

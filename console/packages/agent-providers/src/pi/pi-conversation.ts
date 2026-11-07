import type * as NodeFs from 'node:fs';
import { piProcSource } from './pi-bash';

/**
 * Pi conversations on disk, as Switch keeps them (#777 plan, stage 5; ER-06, ER-07, EQ-04, Q2 A′,
 * SC26): the conversation's lock, which transcript is the conversation, the transcript check, the
 * record of a cleanup that could not be confirmed, and the administrative procedure "recover a
 * conversation" that runs outside Console.
 *
 * The procedure has to run where no Switch module is installed (the shared host travels as one
 * bundle, see `./bridge.ts`), so everything here is one self-contained function,
 * `piConversationStore`, serialized with `fn.toString()` into `pi-recover.mjs` (`piRecoverSource`;
 * precedent: `piBridge`, `readHostSessions` in `../host/session-list.ts`). It must not use
 * anything from outside its own body: Node modules come from `process.getBuiltinModule` or from
 * its options. The adapter uses the same function, so the lock and the checks are one code.
 *
 * In Pi's session directory, beside Pi's `<time>_<X>.jsonl` transcripts:
 * - `<X>.lock/`: the conversation's lock. Entries `<n>.owner` (pid and start time of the holder,
 *   created whole with `link`, which fails if the entry exists) and `<n>.released`. The highest
 *   `<n>` is the lock; it is free when released or when its holder is gone. Taking a free lock is
 *   creating `<n+1>.owner`: of two that saw the same free lock only one can, so a lock that was
 *   taken over is never taken over again from an old reading (R1-D). A holder whose start time
 *   is unknown is never taken for gone (a pid can be reused).
 * - `<X>.map.json`: which file is the conversation, once the procedure recovered it. Without it
 *   the conversation is the one `<time>_<X>.jsonl` there is. A mapped conversation ignores every
 *   other file of `<X>`: the original of a recovered conversation is kept, never resumed.
 * - `<X>.cleanup.json`: launches of `<X>` whose processes Switch could not confirm gone when it
 *   stopped them (Pi itself, or a process group of its shells). Every start of `<X>`, in any
 *   adapter and any host, tries again first and refuses while they are not (ER-06, R1-E). Each
 *   entry carries the identity of the host that made the launch and, once every process of it
 *   was confirmed gone, says so (`ended`): it can be settled without the launch directory (R5-B).
 * - Beside the session directory, `run/<launch>/` (`owner.json`, `config.json`,
 *   `processes.jsonl`): the launches a Switch started. A Switch that was killed leaves them and
 *   no record; the recovery refuses while one of them may still run (R2-B).
 *
 * Processes are read from procfs (`/proc`), or with `ps` where there is none (macOS, R1-I).
 */

export interface PiConversationOptions {
  /** The file system (tests pass one that records or stops); `node:fs` by default. */
  fs?: typeof NodeFs;
  /** Root of procfs; `/proc` by default. Without it, processes are read with `ps`. */
  procRoot?: string;
  /** The `ps` to run without procfs; `ps` on PATH by default. */
  ps?: string;
  /**
   * The user Switch's processes run as; this process's by default. A process that cannot be read
   * is another user's only when procfs shows it is not this user's (R3-A).
   */
  uid?: number;
  /** The clock of the recovered transcript's name. */
  now?: () => Date;
  /**
   * R7-C: the one rule of where processes are read, `piProcSource` of `./pi-bash.ts` (this
   * self-contained function cannot import it: the adapter passes it, and `pi-recover.mjs` defines
   * it from that function's own source, `piRecoverSource`). Without it no process can be told:
   * every question about one is answered "cannot be seen", never "gone".
   */
  procSource?: (
    root: string,
    psGiven: boolean,
    list: (root: string) => string[]
  ) => { source: 'procfs' | 'ps' | 'none' };
}

/** A process as far as it can be told from another: its start time (procfs or `ps`) and whether it is a zombie. */
export interface PiProcessStart {
  start: string;
  zombie: boolean;
}

export interface PiLockOwner {
  v: 1;
  pid: number;
  /** procfs start time, `ps:<lstart>` without procfs, null when unknown. */
  start: string | null;
}

/**
 * A lock taken (`release`, and `owner`: the identity it was taken with, read once, which the
 * holder writes into its launches' `owner.json`, R4-A), or why not. D16-C1: `failed` is a lock
 * this process took (its `<n>.owner` is there) and could not finish taking: it is not held for
 * use, but it is this process's to let go (`release`, which can be tried again), so that a failure
 * after the entry was made never leaves the conversation held by a live host with no way out.
 * R6-C: `release` lets the lock go only once `<n>.released` is durably there; when that write
 * fails it throws and can be called again.
 */
export type PiConversationLock =
  | { release: () => void; owner: PiLockOwner }
  | { busy: string }
  | { failed: string; release: () => void };

export type PiTranscriptLocation =
  | { file: string; mapped: boolean }
  | { none: true }
  | { problem: string };

/** Whether Switch may give Pi a transcript, and why not (ER-07). */
export type PiTranscriptCheck = { ok: true } | { ok: false; reason: string; cutOff: boolean };

/** A launch whose processes were not confirmed gone: where its registry is and what its Pi carries. */
export interface PiPendingLaunch {
  runDir: string;
  registry: string;
  /** Value of `SWITCH_PI_BRIDGE` in the environment of the launch's Pi. */
  bridgeConfig: string;
  /**
   * R5-B: the Switch host that made the launch (its `owner.json`, kept in the record itself), so
   * that the record can be settled once that directory is gone: its start time is the reference
   * of every scan of the launch (`since`, R3-A). Absent in records written before round 5.
   */
  owner?: { pid: number; start: string };
  /**
   * R5-B: every process of the launch was confirmed gone; only its directory and this entry are
   * left to remove. A missing directory never says that; this does.
   */
  ended?: true;
  /**
   * O-1 A (FAP-01): the launch's Pi was confirmed gone (its exit seen, `confirmExit`), while its
   * groups were not. Every reader then looks only for the launch's commands (its groups, its
   * intended and marked or labelled shells), never for its Pi again, which without procfs could
   * never be confirmed. Set only by the one that saw the exit, kept once written (`addCleanup`
   * merges it, `settleCleanup` keeps it); it says nothing of the commands (`ended` does). Absent
   * in records written before it: their Pi is looked for, as before.
   */
  piExited?: true;
}

/**
 * What the recovery did. R6-C: `lockKept` says the conversation's lock could not be let go after
 * it (the write of `<n>.released` failed); the lock is free once this process ends (its holder is
 * gone then), and what the recovery did stands.
 */
export type PiRecoverResult = (
  | { status: 'refused'; reason: string }
  | { status: 'whole'; file: string }
  | {
      status: 'preview' | 'recovered';
      from: string;
      to: string;
      keptBytes: number;
      keptEntries: number;
      branches: number;
      removedBytes: number;
      removedStart: string;
      digest: string;
    }
) & { lockKept?: string };

export type PiConversationStore = ReturnType<typeof piConversationStore>;

export function piConversationStore(options: PiConversationOptions = {}) {
  const fs = options.fs ?? process.getBuiltinModule('node:fs');
  const path = process.getBuiltinModule('node:path');
  const childProcess = process.getBuiltinModule('node:child_process');
  const crypto = process.getBuiltinModule('node:crypto');
  const procRoot = options.procRoot ?? '/proc';
  const psCommand = options.ps ?? 'ps';
  const uid = options.uid ?? process.getuid?.();
  const now = options.now ?? (() => new Date());
  /** Pi's rule for a session id (`dist/core/session-manager.js:15-19`; `pi-args.ts`). */
  const SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
  /** How Pi names a transcript: `<ISO time, : and . as ->_<id>.jsonl` (`session-manager.js:711-713`). */
  const TRANSCRIPT_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
  /** Pi's current transcript format (`session-manager.js:11`). */
  const PI_SESSION_VERSION = 3;
  const code = (error: unknown): string =>
    String((error as { code?: unknown } | null)?.code ?? (error as Error)?.message ?? error);
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

  // ---------------------------------------------------------------------------------------------
  // Processes

  /**
   * Where processes are read (D-15, R7-C): `piProcSource` of `./pi-bash.ts` (`options.procSource`),
   * the rule of the bridge and of the checks of process groups, by what is there, not by platform:
   * `procfs` (also one with processes but no `self`, and one that cannot be listed, whose reads
   * then fail), `ps` (no procfs), or `none` (an empty root someone passed without `ps`: no source
   * at all). Throws when there is no rule: what asked cannot tell.
   */
  function processSource(): 'procfs' | 'ps' | 'none' {
    const rule = options.procSource;
    if (typeof rule !== 'function') throw new Error('no rule of where processes are read');
    return rule(procRoot, options.ps !== undefined, () => fs.readdirSync(procRoot)).source;
  }

  /**
   * R7-A: `stat` and `lstart` as `ps` prints them (`LC_ALL=C`), as `./pi-bash.ts` reads them
   * (`PS_STATE`, `LSTART` there): a state letter and its flags, then a date. Anything else is no
   * identity: unknown, never another process.
   */
  const PS_STATE = /^[DIRSTUWXZt][+<>AELNSVWXlsux]*$/;
  const LSTART =
    /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):[0-5]\d:[0-5]\d \d{4}$/;
  /**
   * R7-A: a start read with `ps` (`ps:`) is one only with a date in `ps`'s format after it; one
   * that is not (a recorded identity from an answer that was not whole) tells nothing. A start read
   * from procfs is compared as before.
   */
  const validStart = (start: string) =>
    !start.startsWith('ps:') || LSTART.test(start.slice(3).trim().replace(/\s+/g, ' '));

  /**
   * Runs `ps` (C locale, UTC, like `./pi-bash.ts` and `./bridge.ts`: a start `ps` prints is local
   * time, and one read in another time zone than it was recorded in would be another process's);
   * null when it found no process, throws when it could not run or told anything else.
   */
  function runPs(args: string[]): string | null {
    const result = childProcess.spawnSync(psCommand, args, {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    if (result.error) throw result.error;
    // `ps -p <pid>` exits 1 with nothing printed, on either stream, when there is no such process.
    // Exit 1 with anything on stderr is `ps` failing, not an answer: the process is not known.
    if (result.status === 1 && result.stdout.trim() === '' && result.stderr.trim() === '')
      return null;
    if (result.status !== 0)
      throw new Error(`ps failed (${result.status}): ${result.stderr.trim()}`);
    return result.stdout;
  }

  /**
   * The process `pid` (null: none), from procfs or `ps`; throws when it cannot be told (also when
   * there is no source, R7-C, and when `ps` printed anything but a state and a date, R7-A).
   */
  function processStart(pid: number): PiProcessStart | null {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    const source = processSource();
    if (source === 'none') throw new Error(`no source to read process ${pid} from`);
    if (source === 'procfs') {
      let stat: string;
      try {
        stat = fs.readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
      } catch (error) {
        if (code(error) === 'ENOENT' || code(error) === 'ESRCH') return null;
        throw error;
      }
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const state = rest[0];
      const start = rest[19];
      if (state === undefined || start === undefined) throw new Error(`malformed ${pid}/stat`);
      return { start, zombie: state === 'Z' };
    }
    const out = runPs(['-o', 'stat=,lstart=', '-p', String(pid)]);
    if (out === null) return null;
    const line = out.trim().replace(/\s+/g, ' ');
    const space = line.indexOf(' ');
    if (space <= 0) throw new Error(`ps printed no start time for ${pid}`);
    // R7-A: the whole answer, or none: a state `ps` prints, then one date in its format. Anything
    // else (`S unavailable`, a cut-off date, a second line) is not a start, so not another process.
    const state = line.slice(0, space);
    const start = line.slice(space + 1);
    if (!PS_STATE.test(state) || !LSTART.test(start))
      throw new Error(`ps printed no start time for ${pid}`);
    return { start: `ps:${start}`, zombie: state.startsWith('Z') };
  }

  function ownIdentity(): PiLockOwner {
    let start: string | null = null;
    try {
      start = processStart(process.pid)?.start ?? null;
    } catch {
      start = null;
    }
    return { v: 1, pid: process.pid, start };
  }

  /**
   * Whether the process that wrote `{ pid, start }` still runs: same pid, same start time, not a
   * zombie. When that cannot be told (procfs or `ps` failed, the start time is unknown or read
   * another way than it was recorded), it is taken to run: nothing it holds is taken over.
   */
  function stillRuns(pid: unknown, start: unknown): boolean {
    if (typeof pid !== 'number' || typeof start !== 'string') return true;
    let found: PiProcessStart | null;
    try {
      found = processStart(pid);
    } catch {
      return true;
    }
    if (found === null || found.zombie) return false;
    // R7-A: a process has the PID, and the recorded start is not one (read from a `ps` answer that
    // was not whole): it cannot be told from the holder, so it is taken to run.
    if (!validStart(start)) return true;
    if (found.start.startsWith('ps:') !== start.startsWith('ps:')) return true;
    return found.start === start;
  }

  /**
   * R3-A: what a failed read of `/proc/<pid>/environ` tells of that process. Only `ENOENT` and
   * `ESRCH` say it is gone, and, for an `EACCES`, a `stat` that shows none or a zombie (a process
   * that exited). `EACCES` says it is another user's only once procfs shows that:
   * `/proc/<pid>` is not this user's (`proc(5)`: the process's effective user) and none of the
   * user ids in its `status` (readable for every process, also one whose `/proc/<pid>` turned
   * root's because it is not dumpable) is this user's. A process of this user's whose environment
   * only root can read (not dumpable: `(sd-pam)`, `ssh-agent`) is left out only when it started
   * (procfs ticks since boot) before `since`, the start of the Switch that made the launch: an
   * environment is the one given at the process's last `execve`, and none older than that Switch
   * was given the launch's variables. Anything else leaves it unseen.
   */
  function environFailure(
    name: string,
    error: unknown,
    since: string | null
  ): 'gone' | 'foreign' | 'older' | 'unreadable' {
    const gone = (failure: unknown) => code(failure) === 'ENOENT' || code(failure) === 'ESRCH';
    if (gone(error)) return 'gone';
    if (code(error) !== 'EACCES') return 'unreadable';
    try {
      // A process that exited and is not reaped yet (a zombie) has no environment left: `EACCES`.
      const found = processStart(Number(name));
      if (found === null || found.zombie) return 'gone';
      if (uid !== undefined && fs.statSync(`${procRoot}/${name}`).uid !== uid) {
        const status = fs.readFileSync(`${procRoot}/${name}/status`, 'utf8');
        const ids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(status);
        if (ids && !ids.slice(1).map(Number).includes(uid)) return 'foreign';
      }
      if (
        since !== null &&
        /^\d+$/.test(since) &&
        /^\d+$/.test(found.start) &&
        BigInt(found.start) < BigInt(since)
      )
        return 'older';
      return 'unreadable';
    } catch (failure) {
      return gone(failure) ? 'gone' : 'unreadable';
    }
  }

  /**
   * Live processes whose environment holds one of `entries` (`NAME=value`), with their title
   * (`comm`: Pi names itself `pi`); processes that could not be read are counted (R3-A: all but
   * those gone, those shown to be another user's and those older than `since`, the start of the
   * Switch that made the launch). Without procfs no environment can be read: every wanted entry is
   * then unreadable, never absent.
   */
  function processesWith(
    entries: readonly string[],
    since: string | null
  ): {
    found: string[];
    unreadable: number;
  } {
    const found: string[] = [];
    if (entries.length === 0) return { found, unreadable: 0 };
    let names: string[];
    try {
      if (processSource() !== 'procfs') return { found, unreadable: 1 };
      names = fs.readdirSync(procRoot);
    } catch {
      return { found, unreadable: 1 };
    }
    const wanted = entries.map((item) => Buffer.from(item));
    let unreadable = 0;
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      let environ: Buffer;
      try {
        environ = fs.readFileSync(`${procRoot}/${name}/environ`);
      } catch (error) {
        // R3-A: gone meanwhile, or shown to be another user's (no Pi or shell of this user's);
        // anything else cannot be seen.
        if (environFailure(name, error, since) === 'unreadable') unreadable += 1;
        continue;
      }
      const variables: Buffer[] = [];
      for (let start = 0; start < environ.length;) {
        const nul = environ.indexOf(0, start);
        const end = nul === -1 ? environ.length : nul;
        variables.push(environ.subarray(start, end));
        start = end + 1;
      }
      if (!variables.some((variable) => wanted.some((item) => variable.equals(item)))) continue;
      let alive: PiProcessStart | null;
      try {
        alive = processStart(Number(name));
      } catch {
        unreadable += 1;
        continue;
      }
      if (!alive || alive.zombie) continue;
      let title = '?';
      try {
        title = fs.readFileSync(`${procRoot}/${name}/comm`, 'utf8').trim();
      } catch {
        // Gone meanwhile: still named by its pid.
      }
      found.push(`${name} (${title})`);
    }
    return { found, unreadable };
  }

  /**
   * Live members per process group; null when the process table cannot be read completely. D-15:
   * without procfs from one `ps` pass, read only whole: a line that is not a row, or no row at all
   * (`ps` lists itself at least), is a table not read, never an empty one.
   */
  function liveGroups(): Map<number, number> | null {
    const table = new Map<number, number>();
    try {
      const source = processSource();
      if (source === 'none') return null;
      if (source === 'ps') {
        const out = runPs(['-A', '-o', 'pid=,pgid=,stat=']);
        if (out === null) return null;
        let rows = 0;
        const pids = new Set<string>();
        for (const line of out.split('\n')) {
          if (line.trim() === '') continue;
          const fields = line.trim().split(/\s+/);
          if (fields.length !== 3) return null;
          const [pid, pgid, stat] = fields as [string, string, string];
          if (!/^\d{1,10}$/.test(pid) || !/^\d{1,10}$/.test(pgid)) return null;
          // R7-A: a state `ps` prints, and each PID once; anything else is a table not read.
          if (!PS_STATE.test(stat) || pids.has(pid)) return null;
          pids.add(pid);
          rows += 1;
          if (!stat.startsWith('Z') && !stat.startsWith('X'))
            table.set(Number(pgid), (table.get(Number(pgid)) ?? 0) + 1);
        }
        return rows > 0 ? table : null;
      }
      for (const name of fs.readdirSync(procRoot)) {
        if (!/^\d+$/.test(name)) continue;
        let stat: string;
        try {
          stat = fs.readFileSync(`${procRoot}/${name}/stat`, 'utf8');
        } catch (error) {
          if (code(error) === 'ENOENT' || code(error) === 'ESRCH') continue;
          return null;
        }
        const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const pgrp = Number(rest[2]);
        if (rest[0] !== 'Z' && Number.isSafeInteger(pgrp) && pgrp > 0)
          table.set(pgrp, (table.get(pgrp) ?? 0) + 1);
      }
      return table;
    } catch {
      return null;
    }
  }

  /**
   * What launches of conversation `id` a Switch that is gone left running (R2-B): the launch
   * directories `<state>/run/<launch>` (`<state>` holds the session directory, `pi-launch.ts`)
   * whose `owner.json` names `id`. A launch is over only when its owner is gone and nothing of it
   * lives: no process carries its `SWITCH_PI_BRIDGE=<launch>/config.json` (its Pi, found whatever
   * its title), no group of its registry (`processes.jsonl`) has a live member, no process
   * carries the marker (`SWITCH_PI_TC`) of a shell it recorded. A live owner, a launch whose owner
   * cannot be read while a process of it lives, and anything that cannot be seen are reasons too:
   * the answer is the reasons, empty when every launch is over.
   *
   * R4-A: an owner that is there but not resolved (`owner.json` unreadable or damaged, so its
   * conversation unknown too; or one of this conversation whose start time is unknown, so its
   * Switch cannot be told gone) is checked as one that is gone: over only when the scan shows that
   * nothing of the launch lives, its Pi, its groups and its intended shells. (Whoever holds a live
   * session of this conversation holds its lock, which the procedure holds now.) A launch with no
   * `owner.json` at all (R3-E, stage 4) is checked as before: its Pi only.
   *
   * O-1 A: `checked` are the launches the record of cleanup keeps Pi's exit of, whose commands the
   * caller checked already: passed over here.
   *
   * O-9 A′ (S4-11): a launch directory being made (`.preparing-<id>`, `pi-launch.ts`
   * `PI_RUN_PREPARING_PREFIX`; written here, the procedure has no imports) has had no Pi: Pi is
   * started on the directory's own name, after it is renamed into place whole. It is passed over
   * when its owner is whole and is another conversation's or a Switch that is gone; one of this
   * conversation whose Switch still runs (or cannot be told gone) refuses, as a launch in place
   * would; one whose owner is missing, cut off or damaged (its maker died before it was whole, or
   * is writing it) is checked as a launch without one: refused only while a Pi of it is seen or
   * what runs cannot be seen.
   */
  function launchesLeft(sessionDir: string, id: string, checked = new Set<string>()): string[] {
    const reasons: string[] = [];
    const runRoot = path.join(path.dirname(sessionDir), 'run');
    let names: string[];
    try {
      names = fs.readdirSync(runRoot);
    } catch (error) {
      if (code(error) === 'ENOENT') return reasons;
      return [`Switch cannot list ${runRoot} (${code(error)})`];
    }
    for (const name of names) {
      // D-16: a launch Switch is removing (renamed to `.removed-<id>` once nothing of it ran or
      // runs, `pi-adapter.ts` `removeLaunch`): nothing of it can write the transcript.
      if (name.startsWith('.removed-')) continue;
      const dir = path.join(runRoot, name);
      if (checked.has(path.resolve(dir))) continue;
      if (name.startsWith('.preparing-')) {
        reasons.push(...preparingLeft(dir, id));
        continue;
      }
      let owner: Record<string, unknown> | null = null;
      /** No `owner.json` (R3-E), as opposed to one Switch cannot read or parse (R4-A). */
      let ownerless = false;
      let unreadOwner = '';
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8'));
        owner = isRecord(parsed) ? parsed : null;
        if (!owner) unreadOwner = 'is not one Switch wrote';
      } catch (error) {
        owner = null;
        ownerless = code(error) === 'ENOENT';
        unreadOwner =
          error instanceof SyntaxError ? 'is damaged' : `cannot be read (${code(error)})`;
      }
      // R3-A: the start of the Switch that made the launch; unknown for one without an owner.
      const since = owner && typeof owner.start === 'string' ? owner.start : null;
      const pi = processesWith([`SWITCH_PI_BRIDGE=${path.join(dir, 'config.json')}`], since);
      if (ownerless) {
        // No Pi is started before its owner is written (`pi-adapter.ts`), but one that runs
        // cannot be told from a launch of this conversation.
        if (pi.found.length > 0 || pi.unreadable > 0)
          reasons.push(
            `launch ${dir} has no owner Switch can read and ${pi.found.length > 0 ? `its Pi still runs (process ${pi.found.join(', ')})` : 'its processes cannot be seen'}`
          );
        continue;
      }
      const resolved =
        owner !== null &&
        owner.v === 1 &&
        typeof owner.piSessionId === 'string' &&
        typeof owner.pid === 'number';
      if (!resolved && !unreadOwner) unreadOwner = 'is not one Switch wrote';
      // A launch of another conversation, whose owner names it: not this procedure's.
      if (resolved && owner?.piSessionId !== id) continue;
      if (resolved && typeof owner?.start === 'string' && stillRuns(owner.pid, owner.start)) {
        reasons.push(
          `launch ${dir} belongs to Switch process ${String(owner.pid)}, which still runs or cannot be told gone`
        );
        continue;
      }
      // R4-A: from here, the owner is gone or not resolved; either way the launch is over only
      // when nothing of it is seen to live.
      if (!resolved)
        reasons.push(
          ...launchLeftovers(dir, pi, since).map(
            (reason) =>
              `launch ${dir} has an owner (owner.json) that ${unreadOwner}, so its conversation is unknown, and ${reason}`
          )
        );
      else reasons.push(...launchLeftovers(dir, pi, since));
    }
    return reasons;
  }

  /**
   * O-9 A′: what of a launch directory being made (`.preparing-<id>`) keeps conversation `id` from
   * being recovered (see `launchesLeft`). Its owner is whole only as `pi-adapter.ts` writes it:
   * `v` 1, a pid, a start time and a conversation.
   */
  function preparingLeft(dir: string, id: string): string[] {
    let owner: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8'));
      owner = isRecord(parsed) ? parsed : null;
    } catch {
      owner = null;
    }
    if (
      owner !== null &&
      owner.v === 1 &&
      typeof owner.pid === 'number' &&
      typeof owner.start === 'string' &&
      typeof owner.piSessionId === 'string'
    ) {
      if (owner.piSessionId !== id || !stillRuns(owner.pid, owner.start)) return [];
      return [
        `launch ${dir} is being made by Switch process ${String(owner.pid)}, which still runs or cannot be told gone`,
      ];
    }
    const pi = processesWith([`SWITCH_PI_BRIDGE=${path.join(dir, 'config.json')}`], null);
    if (pi.found.length > 0 || pi.unreadable > 0)
      return [
        `launch ${dir} is being made, has no whole owner Switch can read, and ${pi.found.length > 0 ? `its Pi still runs (process ${pi.found.join(', ')})` : 'its processes cannot be seen'}`,
      ];
    return [];
  }

  /** D-18: a shell's label, as the bridge makes it (`pi-bash.ts` `LABEL`): 128 random bits or more, hex. */
  const LABEL = /^[0-9a-f]{32,128}$/;

  /**
   * D-18 (R5P-01): without procfs, the live processes whose command line (`ps -A -ww -o
   * pid=,stat=,args=`) holds one of `labels` as a word, as `./pi-bash.ts` `readPiPsLabelled` reads
   * them (this function has no imports); null when `ps` did not give a whole table.
   */
  function labelledProcesses(labels: readonly string[]): number[] | null {
    if (labels.length === 0) return [];
    let out: string | null;
    try {
      out = runPs(['-A', '-ww', '-o', 'pid=,stat=,args=']);
    } catch {
      return null;
    }
    if (out === null) return null;
    const found: number[] = [];
    let rows = 0;
    for (const line of out.split('\n')) {
      if (line.trim() === '') continue;
      const row = /^\s*(\d{1,10})\s+(\S+)(?:\s(.*))?$/.exec(line);
      if (!row || !PS_STATE.test(row[2] as string)) return null;
      rows += 1;
      if ((row[2] as string).startsWith('Z') || (row[2] as string).startsWith('X')) continue;
      const words = (row[3] ?? '').split(/\s+/);
      if (labels.some((label) => words.includes(label))) found.push(Number(row[1]));
    }
    return rows > 0 ? found : null;
  }

  /**
   * O-2 B (FAP-06, R5P-02): whether the number of a shell's group now names another process: its
   * leader (the process whose PID is the group's) lives, is no zombie, and has a known start other
   * than the one recorded for the shell, read the same way (procfs: `stat` field 22, `ps`: its
   * `lstart`). The kernel gives a PID again only once nothing has it as a process, group or session,
   * so that group is empty. Anything else (no leader, a zombie, a start not recorded, read the
   * other way, or one that cannot be read; the same second on `ps`) is not that: the group counts.
   */
  function groupReused(shell: { pgid: number; starttime?: string; lstart?: string }): boolean {
    let leader: PiProcessStart | null;
    try {
      leader = processStart(shell.pgid);
    } catch {
      return false;
    }
    if (leader === null || leader.zombie) return false;
    const recorded = leader.start.startsWith('ps:')
      ? shell.lstart === undefined
        ? undefined
        : `ps:${shell.lstart}`
      : shell.starttime;
    if (recorded === undefined) return false;
    if (recorded.startsWith('ps:') ? !validStart(recorded) : !/^\d+$/.test(recorded)) return false;
    return leader.start !== recorded;
  }

  /**
   * What of launch `dir` may still live (R2-B, R4-A): its Pi (`pi`, already scanned), the groups of
   * its registry, the shells it recorded by their markers (procfs) or their labels (D-18, without
   * procfs); and what cannot be seen. Empty when nothing of it lives. O-2 B: a group counts per
   * shell recorded, and not once its number names another process (`groupReused`); another shell
   * with the same group number still counts by its own record.
   */
  function launchLeftovers(
    dir: string,
    pi: { found: string[]; unreadable: number },
    since: string | null
  ): string[] {
    const reasons: string[] = [];
    if (pi.found.length > 0)
      reasons.push(`the Pi of launch ${dir} still runs (process ${pi.found.join(', ')})`);
    else if (pi.unreadable > 0) reasons.push(`whether the Pi of launch ${dir} runs cannot be seen`);
    let text = '';
    try {
      text = fs.readFileSync(path.join(dir, 'processes.jsonl'), 'utf8');
    } catch (error) {
      if (code(error) !== 'ENOENT') {
        reasons.push(`the registry of launch ${dir} cannot be read (${code(error)})`);
        return reasons;
      }
    }
    /** O-2 B: each shell (`instance`, `toolCallId`) with its group and the starts recorded for it. */
    const shells = new Map<
      string,
      { pgid: number; starttime?: string; lstart?: string; lstarts: number }
    >();
    const markers = new Set<string>();
    const labels = new Set<string>();
    let unlabelled = false;
    for (const line of text.split('\n')) {
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        // A line cut off by a crash: the shell's `intent`, written before it, names its marker.
        continue;
      }
      if (!isRecord(record)) continue;
      if (typeof record.marker === 'string' && record.marker) {
        markers.add(record.marker);
        // D-18: without procfs a shell is found by its label; one without cannot be seen there.
        if (typeof record.label === 'string' && LABEL.test(record.label)) labels.add(record.label);
        else unlabelled = true;
      }
      const key = `${String(record.instance)}\n${String(record.toolCallId)}`;
      if (record.event === 'spawn' && typeof record.pgid === 'number') {
        const lstart =
          typeof record.lstart === 'string' ? record.lstart.trim().replace(/\s+/g, ' ') : '';
        shells.set(key, {
          pgid: record.pgid,
          ...(typeof record.starttime === 'string' ? { starttime: record.starttime } : {}),
          ...(LSTART.test(lstart) ? { lstart } : {}),
          lstarts: lstart ? 1 : 0,
        });
      } else if (record.event === 'lstart') {
        const shell = shells.get(key);
        const lstart =
          typeof record.lstart === 'string' ? record.lstart.trim().replace(/\s+/g, ' ') : '';
        if (!shell) continue;
        shell.lstarts += 1;
        // One start per shell, in `ps`'s format (R11-A): a second or a broken one is none.
        if (shell.lstarts === 1 && LSTART.test(lstart)) shell.lstart = lstart;
        else delete shell.lstart;
      }
    }
    if (shells.size > 0) {
      const table = liveGroups();
      if (!table) reasons.push(`the process groups of launch ${dir} cannot be seen`);
      else {
        const live = new Set<number>();
        for (const shell of shells.values())
          if ((table.get(shell.pgid) ?? 0) > 0 && !groupReused(shell)) live.add(shell.pgid);
        if (live.size > 0)
          reasons.push(`process group(s) ${[...live].join(', ')} of launch ${dir} still run`);
      }
    }
    let source: string;
    try {
      source = processSource();
    } catch {
      // No rule: `processesWith` below cannot see either.
      source = 'unknown';
    }
    if (markers.size > 0 && source === 'ps') {
      // D-18: without procfs no environment can be read; the shells carry their labels.
      const labelled = unlabelled ? null : labelledProcesses([...labels]);
      if (labelled === null)
        reasons.push(`whether the commands of launch ${dir} run cannot be seen`);
      else if (labelled.length > 0)
        reasons.push(`command(s) of launch ${dir} still run (process ${labelled.join(', ')})`);
      return reasons;
    }
    const marked = processesWith(
      [...markers].map((marker) => `SWITCH_PI_TC=${marker}`),
      since
    );
    if (marked.found.length > 0)
      reasons.push(`command(s) of launch ${dir} still run (process ${marked.found.join(', ')})`);
    else if (marked.unreadable > 0)
      reasons.push(`whether the commands of launch ${dir} run cannot be seen`);
    return reasons;
  }

  // ---------------------------------------------------------------------------------------------
  // Durable writes

  function fsyncDir(dir: string): void {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Writes `file` whole or not at all: a new file beside it, fsynced, renamed over it, the directory fsynced. */
  function writeDurably(file: string, data: string | Uint8Array): void {
    const dir = path.dirname(file);
    const tmp = path.join(
      dir,
      `.${path.basename(file)}.${crypto.randomBytes(6).toString('hex')}.tmp`
    );
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      try {
        fs.writeFileSync(fd, data);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
    } catch (error) {
      // Nothing of a write that failed before the rename is left beside the file.
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // The error of the write says more.
      }
      throw error;
    }
    fsyncDir(dir);
  }

  function removeDurably(file: string): void {
    fs.rmSync(file, { force: true });
    fsyncDir(path.dirname(file));
  }

  // ---------------------------------------------------------------------------------------------
  // The lock

  function lockEntries(dir: string): number[] {
    const found: number[] = [];
    for (const name of fs.readdirSync(dir)) {
      const match = /^(\d+)\.owner$/.exec(name);
      if (match) found.push(Number(match[1]));
    }
    return found;
  }

  function readOwner(dir: string, n: number): Record<string, unknown> | null {
    try {
      const owner: unknown = JSON.parse(fs.readFileSync(path.join(dir, `${n}.owner`), 'utf8'));
      return isRecord(owner) ? owner : null;
    } catch {
      return null;
    }
  }

  /** Free: released, or its holder is gone. An entry that cannot be read is never free. */
  function lockFree(dir: string, n: number): boolean {
    if (fs.existsSync(path.join(dir, `${n}.released`))) return true;
    const owner = readOwner(dir, n);
    if (!owner || owner.v !== 1 || typeof owner.start !== 'string') return false;
    return !stillRuns(owner.pid, owner.start);
  }

  /**
   * R6-C: lets lock entry `<n>` go. Released only once `<n>.released` is durably there
   * (`writeDurably`): a write that fails throws and leaves the release to be tried again, by
   * whoever holds this function (the adapter keeps it until it succeeds). Once done, done.
   */
  function releaser(dir: string, n: number): () => void {
    let released = false;
    return () => {
      if (released) return;
      writeDurably(path.join(dir, `${n}.released`), '');
      released = true;
    };
  }

  /**
   * R7-B (D-19): the release of lock entry `<n>` when its link answered an error and whether it
   * was made could not be told. The entry is this process's exactly when it is the temporary file
   * `tmp` under its second name (one file: the same device and inode); only then is it released.
   * No `<n>.owner`: the link was not made, nothing is this process's. Another file: another taker
   * made `<n>` (also this process, for another session of the conversation), never released here.
   * The temporary file goes once that is told. A read that fails throws: the duty is tried again
   * (the adapter keeps this function until it succeeds). Once done, done.
   */
  function settler(dir: string, n: number, tmp: string): () => void {
    const release = releaser(dir, n);
    let settled = false;
    return () => {
      if (settled) return;
      let entry: NodeFs.Stats;
      try {
        entry = fs.statSync(path.join(dir, `${n}.owner`));
      } catch (error) {
        if (code(error) !== 'ENOENT') throw error;
        removeQuietly(tmp);
        settled = true;
        return;
      }
      const mine = fs.statSync(tmp);
      if (mine.dev === entry.dev && mine.ino === entry.ino) release();
      removeQuietly(tmp);
      settled = true;
    };
  }

  /** Removes what is only litter (a temporary file, an entry below the lock); never throws. */
  function removeQuietly(file: string): void {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // Litter: no lock entry, nothing reads it.
    }
  }

  /**
   * Takes conversation `id` for this process alone (ER-07, EQ-04: while it is checked, while it
   * is used, while it is recovered). `busy` when someone else holds it (also this process).
   *
   * D16-C1: once `<n>.owner` is linked, the entry is this process's, and its release is handed
   * out whatever happens next: the steps after the link either cannot change who holds the lock
   * (the temporary file, the entries below `<n>`: litter, removed when they can be) or, when the
   * check that `<n>` is the top cannot be read, the lock is returned as `failed` with its release.
   */
  function lock(sessionDir: string, id: string): PiConversationLock {
    const dir = path.join(sessionDir, `${id}.lock`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const me = ownIdentity();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const top = Math.max(0, ...lockEntries(dir));
      if (top > 0 && !lockFree(dir, top)) {
        const owner = readOwner(dir, top);
        return { busy: `held by process ${String(owner?.pid ?? 'unknown')} (${dir})` };
      }
      const n = top + 1;
      const tmp = path.join(dir, `.${n}.${crypto.randomBytes(6).toString('hex')}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(me), { mode: 0o600, flag: 'wx' });
      try {
        // Exclusive: fails when `<n>.owner` exists, so of two that saw `<top>` free only one gets `<n>`.
        fs.linkSync(tmp, path.join(dir, `${n}.owner`));
      } catch (error) {
        // D16-C1: a link that was made and still answered with an error (the reply lost) is this
        // process's entry all the same: the temporary file has a second name then.
        let linked: boolean | undefined;
        try {
          linked = fs.statSync(tmp).nlink > 1;
        } catch {
          linked = undefined;
        }
        // R7-B (D-19): whether the link was made cannot be told now. The lock is handed out as
        // `failed` with a release that settles it first (`settler`): the temporary file is kept,
        // the evidence of which entry would be this process's.
        if (linked === undefined && code(error) !== 'EEXIST')
          return {
            failed: `the link of ${dir} answered ${code(error)}, and whether it was made cannot be told yet`,
            release: settler(dir, n, tmp),
          };
        removeQuietly(tmp);
        if (linked)
          return {
            failed: `the link of ${dir} answered ${code(error)}`,
            release: releaser(dir, n),
          };
        if (code(error) !== 'EEXIST') throw error;
        continue;
      }
      // D16-C1: `<n>.owner` is this process's from here.
      const release = releaser(dir, n);
      removeQuietly(tmp);
      let latest: number;
      try {
        latest = Math.max(0, ...lockEntries(dir));
      } catch (error) {
        return { failed: `cannot list ${dir} after taking it (${code(error)})`, release };
      }
      if (latest !== n) {
        // Another entry is above `<n>`: it holds the lock, and `<n>` counts for nothing.
        try {
          release();
        } catch {
          // Below the top, the next taker removes it.
        }
        return { busy: `taken meanwhile (${dir})` };
      }
      // What came before `<n>` is no one's now (litter when it cannot be removed: below the top).
      let names: string[] = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        names = [];
      }
      for (const name of names) {
        const match = /^(\d+)\.(owner|released)$/.exec(name);
        if (match && Number(match[1]) < n) removeQuietly(path.join(dir, name));
      }
      return { owner: me, release };
    }
    return { busy: `contended (${dir})` };
  }

  // ---------------------------------------------------------------------------------------------
  // Which file is the conversation

  function transcriptName(name: string, id: string): boolean {
    const suffix = `_${id}.jsonl`;
    return (
      !name.includes('/') &&
      name.endsWith(suffix) &&
      TRANSCRIPT_TIME.test(name.slice(0, -suffix.length))
    );
  }

  /**
   * The transcript of conversation `id`: the file `<X>.map.json` names, else the one file Pi named
   * `<time>_<X>.jsonl`. None means Pi never wrote the conversation (it writes the file with the
   * first message, P-04); several unmapped mean Switch cannot tell which one is the conversation.
   */
  function transcript(sessionDir: string, id: string): PiTranscriptLocation {
    const map = path.join(sessionDir, `${id}.map.json`);
    let text: string | null = null;
    try {
      text = fs.readFileSync(map, 'utf8');
    } catch (error) {
      if (code(error) !== 'ENOENT')
        return { problem: `Switch cannot read its record ${map} (${code(error)})` };
    }
    if (text !== null) {
      let mapped: unknown;
      try {
        mapped = JSON.parse(text);
      } catch {
        mapped = null;
      }
      if (
        !isRecord(mapped) ||
        mapped.v !== 1 ||
        typeof mapped.file !== 'string' ||
        !transcriptName(mapped.file, id)
      )
        return { problem: `its record ${map} is not one Switch wrote` };
      const file = path.join(sessionDir, mapped.file);
      if (!fs.existsSync(file))
        return { problem: `its record ${map} names ${file}, which is not there` };
      return { file, mapped: true };
    }
    let names: string[];
    try {
      names = fs.readdirSync(sessionDir);
    } catch (error) {
      if (code(error) === 'ENOENT') return { none: true };
      return { problem: `Switch cannot list ${sessionDir} (${code(error)})` };
    }
    const found = names.filter((name) => transcriptName(name, id)).sort();
    if (found.length === 0) return { none: true };
    if (found.length > 1)
      return {
        problem: `${sessionDir} holds ${found.length} transcripts of it (${found.join(', ')}) and Switch does not choose one`,
      };
    return { file: path.join(sessionDir, found[0] as string), mapped: false };
  }

  /**
   * Checks a transcript's text (ER-07, EQ-04; P-04: Pi rejects nothing itself but a missing
   * directory). Not empty, ends with a newline (a cut-off last line is refused, Q2 A′; `cutOff`),
   * every line a JSON object; the first is the header: `type: "session"`, `version` 3, `id` = the
   * conversation's id, `cwd` = one of `expected.cwd` (any, when null). Every other entry has a
   * unique string `id` and a `parentId` that is null or another entry's; the chain from the last
   * entry back to null has no cycle; `firstKeptEntryId` of a compaction and `targetId` of a
   * context edit name entries in the file (`session-manager.js:201-272`). Branches (entries with
   * the same parent) are Pi's own and allowed.
   */
  function checkText(
    text: string,
    expected: { id: string; cwd: readonly string[] | null }
  ): PiTranscriptCheck {
    const refuse = (reason: string, cutOff = false): PiTranscriptCheck => ({
      ok: false,
      reason,
      cutOff,
    });
    if (text.length === 0) return refuse('is empty (Pi would start a new conversation in it)');
    if (!text.endsWith('\n'))
      return refuse('ends in a cut-off line (the process writing it stopped mid-line)', true);
    const entries: Record<string, unknown>[] = [];
    for (const [index, line] of text.slice(0, -1).split('\n').entries()) {
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        return refuse(`has a line that is not JSON (line ${index + 1})`);
      }
      if (!isRecord(entry)) return refuse(`has a line that is not an entry (line ${index + 1})`);
      entries.push(entry);
    }
    const [header, ...rest] = entries;
    if (!header || header.type !== 'session') return refuse('does not start with a session header');
    if (header.version !== PI_SESSION_VERSION)
      return refuse(`is in format version ${String(header.version)}, not ${PI_SESSION_VERSION}`);
    if (header.id !== expected.id)
      return refuse(`belongs to conversation ${JSON.stringify(header.id)}, not ${expected.id}`);
    if (
      typeof header.cwd !== 'string' ||
      (expected.cwd !== null && !expected.cwd.includes(header.cwd))
    )
      return refuse(`was started in ${JSON.stringify(header.cwd)}, not in this agent’s directory`);
    const byId = new Map<string, Record<string, unknown>>();
    for (const [index, entry] of rest.entries()) {
      if (entry.type === 'session')
        return refuse(`has a second session header (line ${index + 2})`);
      if (typeof entry.id !== 'string' || entry.id === '')
        return refuse(`has an entry without an id (line ${index + 2})`);
      if (byId.has(entry.id)) return refuse(`has entry ${entry.id} twice`);
      byId.set(entry.id, entry);
    }
    for (const entry of rest) {
      const parent = entry.parentId;
      if (parent !== null && (typeof parent !== 'string' || !byId.has(parent)))
        return refuse(`has entry ${String(entry.id)} whose parent is not in the file`);
      if (
        entry.type === 'compaction' &&
        entry.firstKeptEntryId !== undefined &&
        (typeof entry.firstKeptEntryId !== 'string' || !byId.has(entry.firstKeptEntryId))
      )
        return refuse(
          `has compaction ${String(entry.id)} keeping an entry that is not in the file`
        );
      if (
        entry.type === 'context_edit' &&
        (typeof entry.targetId !== 'string' || !byId.has(entry.targetId))
      )
        return refuse(`has context edit ${String(entry.id)} of an entry that is not in the file`);
    }
    const seen = new Set<string>();
    let current: Record<string, unknown> | undefined = rest.at(-1);
    while (current) {
      const id = current.id as string;
      if (seen.has(id)) return refuse(`has a conversation that loops at entry ${id}`);
      seen.add(id);
      current = current.parentId === null ? undefined : byId.get(current.parentId as string);
    }
    return { ok: true };
  }

  // ---------------------------------------------------------------------------------------------
  // Cleanup Switch could not confirm (ER-06, R1-E)

  function cleanupFile(sessionDir: string, id: string): string {
    return path.join(sessionDir, `${id}.cleanup.json`);
  }

  /** The launches of `id` left unconfirmed; `problem` when the record cannot be read (nothing starts then). */
  function readCleanup(
    sessionDir: string,
    id: string
  ): { launches: PiPendingLaunch[] } | { problem: string } {
    const file = cleanupFile(sessionDir, id);
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (code(error) === 'ENOENT') return { launches: [] };
      return { problem: `Switch cannot read ${file} (${code(error)})` };
    }
    try {
      const record: unknown = JSON.parse(text);
      if (isRecord(record) && record.v === 1 && Array.isArray(record.launches)) {
        const launches = record.launches.filter(
          (launch): launch is PiPendingLaunch =>
            isRecord(launch) &&
            typeof launch.runDir === 'string' &&
            typeof launch.registry === 'string' &&
            typeof launch.bridgeConfig === 'string' &&
            // R5-B: the identity and the confirmation are optional, never of another shape.
            (launch.owner === undefined ||
              (isRecord(launch.owner) &&
                typeof launch.owner.pid === 'number' &&
                typeof launch.owner.start === 'string')) &&
            (launch.ended === undefined || launch.ended === true) &&
            // O-1 A: the proof of Pi's exit is `true` or absent; anything else is no record.
            (launch.piExited === undefined || launch.piExited === true)
        );
        if (launches.length === record.launches.length) return { launches };
      }
    } catch {
      // below
    }
    return { problem: `${file} is not a record Switch wrote` };
  }

  /**
   * Adds launches to the record of `id`, durably, before the conversation is let go. O-1 A: a
   * launch the record lists already (the same `runDir`, `registry` and `bridgeConfig`) is merged,
   * never replaced: what it says ended or what Pi exited stays said (`ended`, `piExited`), whatever
   * order the writes come in, and a later write adds what it says. One that contradicts the entry
   * (another registry or bridge config under the same directory) changes nothing of it.
   */
  function addCleanup(sessionDir: string, id: string, launches: PiPendingLaunch[]): void {
    const earlier = readCleanup(sessionDir, id);
    const known = 'launches' in earlier ? earlier.launches : [];
    const all = [...known];
    for (const launch of launches) {
      const at = all.findIndex((item) => item.runDir === launch.runDir);
      if (at === -1) {
        all.push(launch);
        continue;
      }
      const item = all[at] as PiPendingLaunch;
      if (item.registry !== launch.registry || item.bridgeConfig !== launch.bridgeConfig) continue;
      all[at] = {
        ...item,
        ...(item.owner === undefined && launch.owner !== undefined ? { owner: launch.owner } : {}),
        ...(item.ended === true || launch.ended === true ? { ended: true as const } : {}),
        ...(item.piExited === true || launch.piExited === true ? { piExited: true as const } : {}),
      };
    }
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    writeDurably(cleanupFile(sessionDir, id), `${JSON.stringify({ v: 1, launches: all })}\n`);
  }

  function clearCleanup(sessionDir: string, id: string): void {
    removeDurably(cleanupFile(sessionDir, id));
  }

  /**
   * R5-B: settles the entry of launch `runDir` in the record of `id`: `ended` writes, durably,
   * that every process of it was confirmed gone (before its directory is removed: a missing
   * directory is never taken for that); `drop` removes the entry once its directory is gone (the
   * record with it when it was the last). False when the record does not list the launch. Throws
   * when the record cannot be read or written: the caller keeps the launch then.
   */
  function settleCleanup(
    sessionDir: string,
    id: string,
    runDir: string,
    step: 'ended' | 'drop'
  ): boolean {
    const earlier = readCleanup(sessionDir, id);
    if (!('launches' in earlier)) throw new Error(earlier.problem);
    if (!earlier.launches.some((launch) => launch.runDir === runDir)) return false;
    const rest =
      step === 'drop'
        ? earlier.launches.filter((launch) => launch.runDir !== runDir)
        : earlier.launches.map((launch) =>
            launch.runDir === runDir ? { ...launch, ended: true as const } : launch
          );
    if (rest.length === 0) removeDurably(cleanupFile(sessionDir, id));
    else writeDurably(cleanupFile(sessionDir, id), `${JSON.stringify({ v: 1, launches: rest })}\n`);
    return true;
  }

  // ---------------------------------------------------------------------------------------------
  // "Recover a conversation" (SC26, Q2 A′)

  function timeName(date: Date): string {
    return date.toISOString().replace(/[:.]/g, '-');
  }

  /**
   * Recovers conversation `id` whose transcript ends in a cut-off line: a new transcript of the
   * same conversation with the bytes up to the last newline (every entry, every branch, as Pi
   * wrote them), then the record `<X>.map.json` switched to it. Without `confirm` it only shows
   * what it would do (`preview`, with the `digest` of the transcript as read); with the digest of
   * that preview it does it, if the transcript is still the one shown. It refuses when the
   * conversation is open (its lock), when a stop left its processes unconfirmed (Pi may still
   * write), when a Switch that is gone left a launch of it that may still run (`launchesLeft`,
   * R2-B), and when anything but the last line is wrong: only a cut-off tail is removed.
   *
   * Order, each step durable (fsync of the file and of the directory) before the next: the record
   * names the transcript in use now (if there was none), the new transcript, the record switched.
   * Killed anywhere before the switch, the record still names the old file, which a resume
   * refuses, and the procedure can be run again. The old file is kept and never resumed.
   *
   * R6-C, D16-C1: the lock it took is let go whatever the recovery did, and a release that fails
   * is said (`lockKept`), never thrown over what the recovery did; a lock it took and could not
   * finish taking (`failed`) is let go too.
   */
  function recover(sessionDir: string, id: string, confirm?: string): PiRecoverResult {
    const kept = { error: '' };
    let result: PiRecoverResult;
    try {
      result = recoverHeld(sessionDir, id, confirm, kept);
    } catch (error) {
      // What failed is thrown; that the lock stays too is said on it.
      if (kept.error && error instanceof Error) Object.assign(error, { lockKept: kept.error });
      throw error;
    }
    return kept.error ? { ...result, lockKept: kept.error } : result;
  }

  function recoverHeld(
    sessionDir: string,
    id: string,
    confirm: string | undefined,
    kept: { error: string }
  ): PiRecoverResult {
    const refused = (reason: string): PiRecoverResult => ({ status: 'refused', reason });
    if (!SESSION_ID.test(id)) return refused(`${JSON.stringify(id)} is not a Pi conversation id`);
    if (!fs.existsSync(sessionDir)) return refused(`there is no ${sessionDir}`);
    const held = lock(sessionDir, id);
    if ('busy' in held)
      return refused(
        `the conversation is open in Switch or being recovered (${held.busy}); stop its session first`
      );
    if (!('owner' in held)) {
      try {
        held.release();
      } catch (error) {
        kept.error = code(error);
      }
      return refused(`Switch could not take the conversation’s lock (${held.failed})`);
    }
    try {
      const pending = readCleanup(sessionDir, id);
      // R5-B: a launch the record says ended (every process of it confirmed gone) writes nothing.
      // O-1 A: nor does the Pi of one whose Pi's exit the record keeps (`piExited`); its commands
      // are checked below, as those of a launch a dead Switch left.
      if (
        !('launches' in pending) ||
        pending.launches.some((launch) => launch.ended !== true && launch.piExited !== true)
      )
        return refused(
          'Switch could not confirm that the processes of its last session are gone, so Pi may still write the transcript; resume the conversation in Switch once (it tries again and refuses while they are not)'
        );
      // O-1 A (R5P-01): the proof of Pi's exit spares only the search for that Pi; its groups, its
      // intended shells and its marked or labelled ones are checked as for any launch, by the
      // record's identity of the Switch that made it, and a launch whose directory is gone (its
      // registry with it) cannot be told over.
      const exited = pending.launches.filter(
        (launch) => launch.ended !== true && launch.piExited === true
      );
      const commands: string[] = [];
      for (const launch of exited) {
        if (!fs.existsSync(launch.runDir)) {
          commands.push(
            `launch ${launch.runDir} is gone and the record does not say its commands ended`
          );
          continue;
        }
        commands.push(
          ...launchLeftovers(
            launch.runDir,
            { found: [], unreadable: 0 },
            launch.owner?.start ?? null
          )
        );
      }
      if (commands.length > 0)
        return refused(
          `Switch could not confirm that the commands of its last session are gone (${commands.join('; ')}); resume the conversation in Switch once (it tries again and refuses while they are not) or end those processes, then run this again`
        );
      // R2-B: a Switch killed (SIGKILL, power loss) leaves no record, only its launches; the lock
      // it held is free, but its Pi may still write the transcript.
      const left = launchesLeft(
        sessionDir,
        id,
        new Set(exited.map((launch) => path.resolve(launch.runDir)))
      );
      if (left.length > 0)
        return refused(
          `Switch cannot confirm that every Pi of the conversation is gone, so Pi may still write the transcript (${left.join('; ')}); resume the conversation in Switch once (it stops what a Switch that is gone left) or end those processes, then run this again`
        );
      const found = transcript(sessionDir, id);
      if ('none' in found) return refused(`Pi has no saved conversation ${id} in ${sessionDir}`);
      if ('problem' in found) return refused(found.problem);
      const info = fs.lstatSync(found.file);
      if (info.isSymbolicLink() || !info.isFile())
        return refused(`${found.file} is not a regular file`);
      const bytes = fs.readFileSync(found.file);
      const digest = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
      const newline = bytes.lastIndexOf(0x0a);
      if (newline === bytes.length - 1) {
        const whole = checkText(bytes.toString('utf8'), { id, cwd: null });
        if (whole.ok) return { status: 'whole', file: found.file };
        return refused(
          `${found.file} ${whole.reason}; Switch recovers only a transcript whose last line is cut off`
        );
      }
      if (newline < 0) return refused(`${found.file} has no whole line to keep`);
      const kept = bytes.subarray(0, newline + 1);
      const removed = bytes.subarray(newline + 1);
      const check = checkText(kept.toString('utf8'), { id, cwd: null });
      if (!check.ok)
        return refused(
          `without its cut-off last line ${found.file} still ${check.reason}; Switch recovers only a transcript whose last line is cut off`
        );
      const lines = kept.toString('utf8').slice(0, -1).split('\n');
      const children = new Map<string, number>();
      for (const line of lines.slice(1)) {
        const parent = (JSON.parse(line) as { parentId?: unknown }).parentId;
        if (typeof parent === 'string') children.set(parent, (children.get(parent) ?? 0) + 1);
      }
      let date = now();
      let name = `${timeName(date)}_${id}.jsonl`;
      while (fs.existsSync(path.join(sessionDir, name))) {
        date = new Date(date.getTime() + 1);
        name = `${timeName(date)}_${id}.jsonl`;
      }
      const result = {
        from: found.file,
        to: path.join(sessionDir, name),
        keptBytes: kept.length,
        keptEntries: lines.length - 1,
        branches: [...children.values()].filter((count) => count > 1).length,
        removedBytes: removed.length,
        removedStart: removed.subarray(0, 80).toString('utf8'),
        digest,
      };
      if (confirm === undefined) return { status: 'preview', ...result };
      if (confirm !== digest)
        return refused(
          'the transcript is not the one the preview showed (it changed, or the confirmation is another preview’s); look at it again'
        );
      const map = path.join(sessionDir, `${id}.map.json`);
      if (!found.mapped)
        writeDurably(map, `${JSON.stringify({ v: 1, file: path.basename(found.file) })}\n`);
      writeDurably(result.to, kept);
      writeDurably(
        map,
        `${JSON.stringify({ v: 1, file: name, recoveredFrom: path.basename(found.file), at: now().toISOString() })}\n`
      );
      return { status: 'recovered', ...result };
    } finally {
      try {
        held.release();
      } catch (error) {
        kept.error = code(error);
      }
    }
  }

  /** `node pi-recover.mjs <sessionDir> <id> [--confirm <digest>]`; the exit code. */
  function cli(argv: string[], self: string): number {
    const out = (text: string) => process.stdout.write(`${text}\n`);
    const [sessionDir, id, flag, digest] = argv;
    if (!sessionDir || !id || (flag !== undefined && (flag !== '--confirm' || !digest))) {
      process.stderr.write(
        `usage: node ${self} <session directory> <conversation id> [--confirm <digest>]\n`
      );
      return 2;
    }
    const result = recover(sessionDir, id, flag === '--confirm' ? digest : undefined);
    if (result.lockKept)
      process.stderr.write(
        `Switch could not let go of the lock of Pi conversation ${id} (${result.lockKept}); it is free once this procedure has ended.\n`
      );
    const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
    switch (result.status) {
      case 'refused':
        process.stderr.write(`Switch will not recover Pi conversation ${id}: ${result.reason}.\n`);
        return 1;
      case 'whole':
        out(`Pi conversation ${id} needs no recovery: ${result.file} is whole.`);
        return 0;
      case 'preview':
      case 'recovered':
        out(`Pi conversation ${id}`);
        out(`  transcript now:   ${result.from} (kept as it is)`);
        out(
          `  new transcript:   ${result.to}${result.status === 'preview' ? ' (named by the time it is written)' : ''}`
        );
        out(
          `  kept:             ${result.keptEntries} entries, ${result.keptBytes} bytes, ${result.branches} branch point(s)`
        );
        out(
          `  removed:          the cut-off last line, ${result.removedBytes} bytes: ${JSON.stringify(result.removedStart)}`
        );
        if (result.status === 'recovered') {
          out(
            `Recovered: Switch resumes the conversation from ${result.to}; ${result.from} is not resumed again.`
          );
          return 0;
        }
        out('To recover it, run:');
        out(`  node ${quote(self)} ${quote(sessionDir)} ${quote(id)} --confirm ${result.digest}`);
        return 0;
    }
  }

  return {
    processStart,
    stillRuns,
    ownIdentity,
    lock,
    transcript,
    checkText,
    readCleanup,
    addCleanup,
    clearCleanup,
    settleCleanup,
    writeDurably,
    launchesLeft,
    /** R4-A: what of launch directory `dir` may still live, without signalling anything; empty: nothing. */
    launchLeft: (dir: string, since: string | null): string[] =>
      launchLeftovers(
        dir,
        processesWith([`SWITCH_PI_BRIDGE=${path.join(dir, 'config.json')}`], since),
        since
      ),
    recover,
    cli,
  };
}

/** File name of the procedure, written into Switch's Pi state directory (`piStateDir`). */
export const PI_RECOVER_SCRIPT = 'pi-recover.mjs';

/** Source of `pi-recover.mjs`: `node pi-recover.mjs <session directory> <id> [--confirm <digest>]`. */
export function piRecoverSource(): string {
  return [
    '// Generated by Switch (@switch-console/agent-providers, src/pi/pi-conversation.ts). Do not edit.',
    '// Recovers a Pi conversation whose transcript ends in a cut-off line (SC26). Run without',
    '// --confirm first: it shows what it would do and the command that does it.',
    // R7-C: the rule of where processes are read, the very function of `./pi-bash.ts`.
    `const piProcSource = ${piProcSource.toString()};`,
    `const piConversationStore = ${piConversationStore.toString()};`,
    'process.exitCode = piConversationStore({ procSource: piProcSource }).cli(process.argv.slice(2), process.argv[1]);',
    '',
  ].join('\n');
}

import { constants } from 'node:fs';
import { type FileHandle, mkdir, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { boxLimitFromEnv, readUsage, requestMemoryStop } from '@switch-console/agent-providers-box';
import { z } from 'zod';
import type { Logger } from './log';
import {
  listProcesses,
  type MarkerProof,
  type ProcessEntry,
  processesOf,
  type ProcOptions,
  ProcReader,
  signalProven,
} from './owner-marker';
import { OWNER_RECORDS, recordedPid, writeAtomic } from './runtime';

/**
 * The per-agent memory guard: what it measures and how it judges.
 *
 * The secure sandbox gives no per-agent memory limit the box's own user can
 * set, so one agent running away used to take the whole box down with it.
 * Every 2 s the guard sums what each agent's processes hold, proven by their
 * owner marker (`owner-marker.ts`), escaped orphans included, and stops the
 * one agent past its share of the box, or the largest when the box itself is
 * about to fill. Stopping is done elsewhere; this decides.
 */

const KIB = 1024;

/**
 * The anonymous memory a process holds, from its `/proc/<pid>/smaps`: the sum
 * of every mapping's `Anonymous` line. Inside gVisor there is no
 * `smaps_rollup`, `Pss` equals `Rss`, and `VmRSS` counts shared code once per
 * process (over 2x high on box A, 27 Oct); `Anonymous` summed reads about
 * 15-20% above the box's own AnonPages, an upper estimate.
 */
export function anonymousBytes(smaps: string): number {
  let total = 0;
  for (const match of smaps.matchAll(/^Anonymous:\s+(\d+) kB$/gm)) total += Number(match[1]) * KIB;
  return total;
}

/**
 * The most of a `smaps` the guard reads. It grows with a process's mappings,
 * so a runaway (or a process making thousands of small mappings on purpose)
 * can pass it; that process is then measured from its `status` instead.
 */
export const SMAPS_MAX = 16 * 1024 * 1024;

/**
 * `anonymousBytes` of a `smaps` file, read a chunk at a time through `reader`,
 * never whole. Past `maxBytes`, `complete` is false and `bytes` is what was
 * read before it.
 */
export async function anonymousBytesIn(
  reader: ProcReader,
  path: string,
  maxBytes = SMAPS_MAX
): Promise<{ bytes: number; complete: boolean }> {
  let bytes = 0;
  const add = (line: Buffer, start: number, end: number) => {
    const kib = anonymousKiB(line, start, end);
    if (kib !== null) bytes += kib * KIB;
  };
  try {
    await reader.eachLineBytes(path, add, maxBytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EFBIG') return { bytes, complete: false };
    throw error;
  }
  return { bytes, complete: true };
}

const ANONYMOUS_KEY = Buffer.from('Anonymous:', 'latin1');
const KB_SUFFIX = Buffer.from(' kB', 'latin1');
const SPACE = 0x20;
const TAB = 0x09;
const DIGIT_0 = 0x30;
const DIGIT_9 = 0x39;

/**
 * The kB of an `Anonymous:` line (`Anonymous:` and spaces, digits, ` kB`), read
 * from its bytes without a string, or null for any other line.
 */
export function anonymousKiB(line: Buffer, start: number, end: number): number | null {
  if (end - start < ANONYMOUS_KEY.length + 1 + KB_SUFFIX.length) return null;
  if (
    line.compare(ANONYMOUS_KEY, 0, ANONYMOUS_KEY.length, start, start + ANONYMOUS_KEY.length) !== 0
  )
    return null;
  let at = start + ANONYMOUS_KEY.length;
  const spaced = at;
  while (at < end && (line[at] === SPACE || line[at] === TAB)) at++;
  if (at === spaced) return null;
  let kib = 0;
  const digits = at;
  while (at < end && line[at]! >= DIGIT_0 && line[at]! <= DIGIT_9) {
    kib = kib * 10 + (line[at]! - DIGIT_0);
    at++;
  }
  if (at === digits || end - at !== KB_SUFFIX.length) return null;
  return line.compare(KB_SUFFIX, 0, KB_SUFFIX.length, at, end) === 0 ? kib : null;
}

/**
 * A process's `VmRSS` from its `status`, in bytes, or 0. For a process whose
 * `smaps` is past the cap: it reads high in gVisor (shared code counted per
 * process), which is the safe way to err when choosing whom to stop.
 * `RssAnon` would be the closer measure, but gVisor reports it as 0.
 */
export function vmRssBytes(status: string): number {
  const match = /^VmRSS:\s+(\d+) kB$/m.exec(status);
  return match ? Number(match[1]) * KIB : 0;
}

/** The fields of `/proc/meminfo` the guard reads, in bytes; null when one is missing. */
export function boxMemoryFromMeminfo(
  meminfo: string
): { anon: number; shmem: number; total: number } | null {
  const field = (name: string): number | null => {
    const match = new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm').exec(meminfo);
    return match ? Number(match[1]) * KIB : null;
  };
  const anon = field('AnonPages');
  const shmem = field('Shmem');
  const total = field('MemTotal');
  if (anon === null || shmem === null || total === null) return null;
  return { anon, shmem, total };
}

/** What one agent's proven processes hold, and which they are. */
export interface AgentMemory {
  bytes: number;
  processes: ProcessEntry[];
}

/**
 * Each of `agentIds`'s memory, from the processes their markers prove. A
 * process that ends mid-read counts as nothing. A process with no proof is
 * no agent's: it still shows in the box's total, never in an agent's.
 */
export async function readAgentMemory(
  markers: MarkerProof,
  agentIds: Iterable<string>,
  options: ProcOptions & { smapsMax?: number } = {},
  reader: ProcReader = new ProcReader()
): Promise<Map<string, AgentMemory>> {
  const procRoot = options.procRoot ?? '/proc';
  const byAgent = new Map<string, AgentMemory>();
  for (const agentId of agentIds) byAgent.set(agentId, { bytes: 0, processes: [] });
  for (const entry of await listProcesses(markers, byAgent.keys(), options, reader)) {
    if (entry.owner === null) continue;
    const agent = byAgent.get(entry.owner);
    if (!agent) continue;
    let bytes = 0;
    try {
      const dir = join(procRoot, String(entry.pid));
      const smaps = await anonymousBytesIn(reader, join(dir, 'smaps'), options.smapsMax);
      bytes = smaps.bytes;
      if (!smaps.complete) {
        // Never skipped for it: an agent cannot hide from its share by
        // inflating its own smaps.
        bytes = Math.max(bytes, vmRssBytes(await reader.text(join(dir, 'status'))));
        options.onTooLarge?.(entry.pid, 'smaps', entry.owner);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ESRCH' || code === 'EACCES') continue;
      throw error;
    }
    agent.bytes += bytes;
    agent.processes.push(entry);
  }
  return byAgent;
}

/**
 * Why the box is high when no agent explains it, for the status report:
 * `unexplained` (high, and no agent's processes explain it, so no one was
 * stopped) or `sustained` (above the backstop for a while; the largest agent is
 * stopped if it stays). The box's reading and its shared-memory part, in bytes.
 */
export type BoxNote = {
  code: 'unexplained' | 'sustained';
  boxBytes: number;
  shmemBytes: number | null;
};

export interface GuardLimits {
  /**
   * The limit the guard works to, in bytes: the box's memory limit
   * (`SWITCH_BOX_MEMORY_LIMIT_BYTES`) less the controller's reserve, if any.
   */
  boxLimit: number;
  /** The box's own memory limit, for the log and the live status; `boxLimit` where there is no reserve. */
  podLimit?: number;
  /** The controller's reserve under the box's limit (`SWITCH_CONTROLLER_RESERVE_BYTES`); 0 or absent for none. */
  reserve?: number;
  /** One agent's share of the box, as a fraction of `boxLimit`. */
  share: number;
  /** The box level, as a fraction of `boxLimit`, past which the largest agent is stopped at once. */
  backstop: number;
  /**
   * The least share of the box the largest agent must hold for the backstop
   * to stop it: under that, no agent explains the box being full (memory in
   * `/dev/shm`, or held by processes with no proof), and stopping one would
   * not help.
   */
  explains: number;
  /** How many samples in a row an agent must be over its share before it is stopped. */
  confirm: number;
  /** Samples in a row above the backstop level, flat or falling, before the box is noted. */
  sustainNote: number;
  /** How long the box may stay above the backstop level before the largest agent is stopped. */
  sustainMs: number;
}

/**
 * How long the box valve's shedding may hold the slow-leak clock: at most this
 * much in one shedding episode, and in total in any `SHED_PAUSE_WINDOW_MS`, even
 * if the valve never says it has finished. Only that clock pauses: an agent
 * over its share, or the box past the backstop and rising, is stopped as ever.
 */
export const SHED_PAUSE_MAX_MS = 75_000;
export const SHED_PAUSE_WINDOW_MS = 5 * 60_000;

export const DEFAULT_LIMITS: Omit<GuardLimits, 'boxLimit'> = {
  share: 0.6,
  backstop: 0.92,
  explains: 0.25,
  confirm: 2,
  sustainNote: 3,
  sustainMs: 60_000,
};

/** One reading: the box's total, and each agent's. */
export interface GuardSample {
  box: number;
  /** The agents that may be stopped now, and what each holds. */
  agents: ReadonlyMap<string, number>;
  /** When it was taken, in ms: how long the box has stayed high is measured with it. */
  at?: number;
  /**
   * A stop is under way: its agent's memory is still being freed, so the
   * box staying high says nothing yet, and no one is stopped for that.
   */
  stopping?: boolean;
}

export type GuardDecision =
  | { kind: 'none' }
  | {
      kind: 'stop';
      agentId: string;
      trigger: 'share' | 'backstop' | 'sustained';
      bytes: number;
      /** Its share in bytes, or for the backstop the box level that set it off. */
      limit: number;
      /** The limit as a whole percentage of the box. */
      percent: number;
    }
  | {
      kind: 'unexplained';
      box: number;
      largest: { agentId: string; bytes: number } | null;
      /** How long the box has stayed above the backstop level, when it is flat or falling; absent while rising. */
      sustainedMs?: number;
    };

/**
 * Judges each sample against the limits, remembering what it needs across
 * samples: how long each agent has been over its share, and the box's last
 * level, to tell rising from falling. One stop at a time: the caller holds
 * further samples back while a stopped agent's memory is being freed.
 */
export class GuardJudge {
  private readonly over = new Map<string, number>();
  private lastBox: number | null = null;
  private lastAgents = new Map<string, number>();
  /**
   * Samples in a row above the backstop level, when the first was taken, and
   * how much of that time the valve's shedding held the clock.
   */
  private high: { samples: number; since: number; pausedMs: number } | null = null;
  /** The valve is shedding: how much this episode has held the clock, and whether its pause is spent. */
  private shed: { usedMs: number; spent: boolean } | null = null;
  /** The clock's pauses, for the rolling window: when each slice ended, and how long it was. */
  private pauses: { at: number; ms: number }[] = [];
  private lastAt: number | null = null;
  /** This episode used up its pause, or the window's: true once, then reset by the next episode. */
  private pauseSpent = false;

  constructor(private readonly limits: GuardLimits) {}

  judge(sample: GuardSample): GuardDecision {
    const decision = this.decide(sample);
    // Any stop starts the slow-leak clock again: no agent is stopped twice
    // for the same minute above the line.
    if (decision.kind === 'stop' && this.high)
      this.high = { samples: 0, since: sample.at ?? 0, pausedMs: 0 };
    return decision;
  }

  /**
   * The box valve is shedding (`on`) or has finished. While it sheds, the
   * slow-leak clock is held, within `SHED_PAUSE_MAX_MS` an episode and in any
   * `SHED_PAUSE_WINDOW_MS`; a new episode starts only after it has finished.
   */
  setShedding(on: boolean): void {
    if (on && !this.shed) {
      this.shed = { usedMs: 0, spent: false };
      this.pauseSpent = false;
    } else if (!on) this.shed = null;
  }

  /** The pause ran out while the valve still shed: true once per episode, for the guard's log. */
  takePauseSpent(): boolean {
    const spent = this.pauseSpent;
    this.pauseSpent = false;
    return spent;
  }

  /** Holds the slow-leak clock for the time since the last sample, as far as the limits allow. */
  private holdClock(at: number): void {
    const elapsed = this.lastAt === null ? 0 : Math.max(0, at - this.lastAt);
    this.lastAt = at;
    while (this.pauses.length > 0 && this.pauses[0]!.at <= at - SHED_PAUSE_WINDOW_MS)
      this.pauses.shift();
    if (!this.shed || this.shed.spent || !this.high) return;
    // Only time the box has been above the line can be held.
    const wanted = Math.min(elapsed, at - this.high.since);
    if (wanted <= 0) return;
    const inWindow = this.pauses.reduce((sum, pause) => sum + pause.ms, 0);
    const allowed = Math.max(
      0,
      Math.min(wanted, SHED_PAUSE_MAX_MS - this.shed.usedMs, SHED_PAUSE_MAX_MS - inWindow)
    );
    if (allowed > 0) {
      this.shed.usedMs += allowed;
      this.high.pausedMs += allowed;
      this.pauses.push({ at, ms: allowed });
    }
    if (allowed < wanted) {
      // Spent: the clock runs again until this episode ends and a new one starts.
      this.shed.spent = true;
      this.pauseSpent = true;
    }
  }

  private decide(sample: GuardSample): GuardDecision {
    const { boxLimit, backstop, explains } = this.limits;
    const boxRise = this.lastBox === null ? 0 : sample.box - this.lastBox;
    const rising = this.lastBox !== null && boxRise > 0;
    const before = this.lastAgents;
    const at = sample.at ?? 0;
    if (sample.box > boxLimit * backstop)
      this.high = {
        samples: (this.high?.samples ?? 0) + 1,
        since: this.high?.since ?? at,
        pausedMs: this.high?.pausedMs ?? 0,
      };
    else this.high = null;
    this.holdClock(at);
    this.lastBox = sample.box;
    this.lastAgents = new Map(sample.agents);
    let largest: { agentId: string; bytes: number } | null = null;
    for (const [agentId, bytes] of sample.agents)
      if (!largest || bytes > largest.bytes) largest = { agentId, bytes };
    for (const agentId of this.over.keys())
      if (!sample.agents.has(agentId)) this.over.delete(agentId);

    if (sample.box > boxLimit * backstop && rising) {
      // Blame only an agent that can be what is filling the box: the one whose
      // own memory rose most, carrying at least half the box's latest rise,
      // and holding enough of the box to matter. A rise held by agents being
      // stopped or held, by memory no marker proves, or spread evenly over
      // many, is reported instead.
      let riser: { agentId: string; bytes: number; rise: number } | null = null;
      for (const [agentId, bytes] of sample.agents) {
        const rise = bytes - (before.get(agentId) ?? bytes);
        if (rise > 0 && (!riser || rise > riser.rise)) riser = { agentId, bytes, rise };
      }
      if (riser && riser.rise * 2 >= boxRise && riser.bytes >= boxLimit * explains) {
        this.over.clear();
        return {
          kind: 'stop',
          agentId: riser.agentId,
          trigger: 'backstop',
          bytes: riser.bytes,
          limit: Math.floor(boxLimit * backstop),
          percent: Math.round(backstop * 100),
        };
      }
      // No one to blame for the rise: an agent over its own share is still
      // stopped as usual; only when none is is the box reported.
      const byShare = this.overShare(sample);
      return byShare ?? { kind: 'unexplained', box: sample.box, largest };
    }

    return this.overShare(sample) ?? this.sustained(sample, at, largest) ?? { kind: 'none' };
  }

  /**
   * A box that stays above the backstop level without rising (a slow leak,
   * or a plateau just short of the limit): noted after `sustainNote` samples,
   * and after `sustainMs` the largest agent is stopped, if it holds enough of
   * the box to matter. Its clock starts again after a stop.
   */
  private sustained(
    sample: GuardSample,
    at: number,
    largest: { agentId: string; bytes: number } | null
  ): GuardDecision | null {
    const { boxLimit, backstop, explains, sustainNote, sustainMs } = this.limits;
    if (sample.stopping || !this.high || this.high.samples < sustainNote) return null;
    // Time the valve's shedding held the clock (bounded) does not count.
    const sustainedMs = at - this.high.since - this.high.pausedMs;
    if (sustainedMs >= sustainMs && largest && largest.bytes >= boxLimit * explains) {
      this.high = { samples: 0, since: at, pausedMs: 0 };
      this.over.clear();
      return {
        kind: 'stop',
        agentId: largest.agentId,
        trigger: 'sustained',
        bytes: largest.bytes,
        limit: Math.floor(boxLimit * backstop),
        percent: Math.round(backstop * 100),
      };
    }
    return { kind: 'unexplained', box: sample.box, largest, sustainedMs };
  }

  /** The agent over its share for `confirm` samples in a row, the largest if several; null for none. */
  private overShare(sample: GuardSample): Extract<GuardDecision, { kind: 'stop' }> | null {
    const { boxLimit, share, confirm } = this.limits;

    const limit = Math.floor(boxLimit * share);
    let chosen: { agentId: string; bytes: number } | null = null;
    for (const [agentId, bytes] of sample.agents) {
      if (bytes <= limit) {
        this.over.delete(agentId);
        continue;
      }
      const count = (this.over.get(agentId) ?? 0) + 1;
      this.over.set(agentId, count);
      if (count >= confirm && (!chosen || bytes > chosen.bytes)) chosen = { agentId, bytes };
    }
    if (!chosen) return null;
    this.over.delete(chosen.agentId);
    return {
      kind: 'stop',
      agentId: chosen.agentId,
      trigger: 'share',
      bytes: chosen.bytes,
      limit,
      percent: Math.round(share * 100),
    };
  }

  /**
   * A stop has finished and its memory has gone: the minute above the line
   * is counted again from now, so a second agent is stopped only if the box
   * stays high without the first.
   */
  restartClock(at: number): void {
    if (this.high) this.high = { samples: 0, since: at, pausedMs: 0 };
  }

  /** Forgets an agent's count: it was stopped, or rests. */
  forget(agentId: string): void {
    this.over.delete(agentId);
  }
}

/** Bytes as the status detail shows them: GiB with one decimal. */
export function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/** The status detail for a guard stop, one plain sentence. */
export function stopDetail(decision: Extract<GuardDecision, { kind: 'stop' }>): string {
  if (decision.trigger === 'share')
    return `Stopped by the memory guard at ${gib(decision.bytes)} (its limit is ${gib(decision.limit)}).`;
  if (decision.trigger === 'sustained')
    return `Stopped by the memory guard at ${gib(decision.bytes)}, the largest agent when the box stayed above ${decision.percent}% of its memory for a minute.`;
  return `Stopped by the memory guard at ${gib(decision.bytes)}, the largest agent when the box reached ${decision.percent}% of its memory.`;
}

/** A guard stop as recorded beside the agent, so a controller restart keeps it. */
export interface GuardStopRecord {
  /** Every guard stop of this agent so far: the report's `oom_kills`. */
  count: number;
  /** Still held stopped until its next message: kept across a controller restart. */
  held: boolean;
  last: {
    at: string;
    bytes: number;
    limit: number;
    percent: number;
    trigger: 'share' | 'backstop' | 'sustained';
  };
}

const GUARD_STOP_FILE = 'guard-stop.json';
const GUARD_STOP_LIMIT_BYTES = 4096;
const MAX_BYTES = 2 ** 50;

/**
 * The file sits in a folder the agent's own processes can write (one user per
 * box), so it is read as untrusted: a regular file (a symlink is not
 * followed), small, and holding nothing but numbers in range, a time and a
 * trigger. Anything else is no record.
 */
const guardStopSchema = z.strictObject({
  count: z.number().int().min(0).max(1_000_000),
  held: z.boolean().default(false),
  last: z.strictObject({
    at: z.string().datetime(),
    bytes: z.number().int().min(0).max(MAX_BYTES),
    limit: z.number().int().min(0).max(MAX_BYTES),
    percent: z.number().int().min(1).max(100),
    trigger: z.enum(['share', 'backstop', 'sustained']),
  }),
});

export async function readGuardStop(agentDir: string): Promise<GuardStopRecord | null> {
  let file: FileHandle | undefined;
  try {
    // Opened without following a link, and checked on the open file, so it
    // cannot be swapped between the check and the read.
    file = await open(
      join(agentDir, GUARD_STOP_FILE),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    );
    const info = await file.stat();
    if (!info.isFile() || info.size > GUARD_STOP_LIMIT_BYTES) return null;
    const parsed = guardStopSchema.safeParse(JSON.parse(await file.readFile('utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  } finally {
    await file?.close();
  }
}

/** Writes the record; a failure is said and does not stop anything. */
async function writeGuardStop(
  agentDir: string,
  record: GuardStopRecord,
  log: Pick<Logger, 'error'>
): Promise<void> {
  try {
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    await writeAtomic(join(agentDir, GUARD_STOP_FILE), JSON.stringify(record));
  } catch (error) {
    log.error('Memory guard could not record a stop; going on with it', {
      error: (error as NodeJS.ErrnoException).code ?? 'unknown',
    });
  }
}

/**
 * Marks the agent no longer held, once its next message has woken it. With
 * `stoppedAt`, only the stop recorded at that time is released: a newer stop
 * written in between is left held.
 */
export async function releaseGuardStop(
  agentDir: string,
  log: Pick<Logger, 'error'>,
  stoppedAt?: string
): Promise<GuardStopRecord | null> {
  const record = await readGuardStop(agentDir);
  if (!record?.held) return record;
  if (stoppedAt !== undefined && record.last.at !== stoppedAt) return record;
  const released = { ...record, held: false };
  await writeGuardStop(agentDir, released, log);
  return released;
}

/** What the guard needs from `AgentRest`: one wake path for resting and guard stops. */
export interface GuardRest {
  /** Held stopped: reconcile skips it and the hub keeps its events. */
  suspend(agentId: string, kind: 'out_of_memory'): void | Promise<void>;
  /** The stop is done: an event that arrived meanwhile wakes it now. */
  stopped(agentId: string): void;
  /** The stop failed: it is not held. */
  clear(agentId: string): void;
}

export interface GuardStopDeps {
  markers: MarkerProof;
  rest: GuardRest;
  /** Turns the agent host off without waiting: the guard ends the rest itself. */
  stopHost: (agentId: string) => Promise<void>;
  /**
   * Asks the agent's host to tell its rooms it is being stopped, before it is:
   * how many rooms it told. Absent, or failing (a host too old, or itself the
   * runaway), the line is skipped and logged; the stop goes on.
   */
  announce?: (agentId: string) => Promise<number>;
  /**
   * The agent host's own processes (its supervisor and worker), left awake
   * when the rest are frozen so it can tell its rooms. Empty when the host
   * runs inside the controller.
   */
  hostPids?: (agentId: string) => Promise<number[]>;
  agentDir: (agentId: string) => string;
  log: Logger;
  now: () => number;
  /** How long a stop is asked for before it is forced. */
  forceAfterMs?: number;
  proc?: ProcOptions & { smapsMax?: number };
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  /**
   * On a split box (the controller as its own user): the agents' processes belong to
   * another user, so the guard measures and acts through the launcher, not
   * `/proc`. Its box reading stays its own, so a launcher that under-reports
   * can shift blame between agents but never hide the total.
   */
  remote?: GuardRemote;
}

export interface GuardRemote {
  /**
   * Each agent's bytes from the launcher's latest `measure`, or null when there
   * is none fresh. `undisputed` leaves out marker-only processes (C8): those
   * count to the box but never alone get an agent stopped.
   */
  read: (
    agentIds: readonly string[]
  ) => Map<string, { undisputed: number; processes: number }> | null;
  /** SIGSTOP the agent's processes but its host, by first sight. */
  freeze: (agentId: string) => Promise<void>;
  thaw: (agentId: string) => Promise<void>;
  /** Stop then kill everything first sight says is the agent's, in rounds (C8a). */
  end: (agentId: string) => Promise<{ forced: number; notProven: number; left: number }>;
}

export interface GuardStopResult {
  record: GuardStopRecord;
  /** Rooms the agent's host told; 0 when it could not. */
  told: number;
  asked: number;
  forced: number;
  notProven: number;
}

/** How long the host has to tell its rooms before the stop goes on without the line. */
const ANNOUNCE_TIMEOUT_MS = 3_000;

async function announceStop(deps: GuardStopDeps, agentId: string): Promise<number> {
  if (!deps.announce) return 0;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      deps.announce(agentId),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('the agent host did not answer in time')),
          ANNOUNCE_TIMEOUT_MS
        );
      }),
    ]);
  } catch (error) {
    deps.log.warn('Memory guard could not have the agent tell its rooms; stopping it anyway', {
      agentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Freezes (SIGSTOP) every process `agentId`'s marker proves except its host's
 * own, the moment it is chosen: whatever is running away stops growing while
 * the stop waits its turn and the host tells its rooms. Resolves to how many
 * were frozen.
 */
export async function freezeRunaway(deps: GuardStopDeps, agentId: string): Promise<Set<number>> {
  if (deps.remote) {
    // The launcher froze them; the stop's end will kill them, frozen or not.
    await deps.remote.freeze(agentId);
    return new Set<number>();
  }
  const proc = deps.proc ?? {};
  const host = new Set(deps.hostPids ? await deps.hostPids(agentId).catch(() => []) : []);
  const frozen = new Set<number>();
  for (const entry of await processesOf(deps.markers, agentId, proc)) {
    if (host.has(entry.pid)) continue;
    if (
      (await signalProven(entry, 'SIGSTOP', deps.markers, { ...proc, kill: deps.kill })) ===
      'signalled'
    )
      frozen.add(entry.pid);
  }
  return frozen;
}

/** Lets every process `agentId`'s marker proves go on (SIGCONT): a stop that did not happen. */
export async function thawAgent(deps: GuardStopDeps, agentId: string): Promise<void> {
  if (deps.remote) {
    await deps.remote.thaw(agentId).catch(() => {});
    return;
  }
  const proc = deps.proc ?? {};
  for (const entry of await processesOf(deps.markers, agentId, proc).catch(() => []))
    await signalProven(entry, 'SIGCONT', deps.markers, { ...proc, kill: deps.kill }).catch(
      () => {}
    );
}

/** How many freeze-and-kill rounds `endProven` runs before it gives up and says what is left. */
const END_ROUNDS = 5;

/**
 * Ends every process `agentId`'s marker proves, so none can fork or be
 * restarted out of reach between a scan and a signal: each round freezes all
 * of them (SIGSTOP), scans again to catch any started before the freeze,
 * freezes those, then kills every one (SIGKILL); rounds repeat until a scan
 * finds none, at most `END_ROUNDS`. Each signal goes to one pid whose proof
 * and start time are read again just before; one whose proof is gone is
 * counted, never signalled.
 */
export async function endProven(
  markers: MarkerProof,
  agentId: string,
  options: ProcOptions & {
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    sleep?: (ms: number) => Promise<void>;
    /** Asked before each round and each kill: false (the agent woke meanwhile) ends it there. */
    still?: () => boolean;
  } = {}
): Promise<{ forced: number; notProven: number; left: number }> {
  const sleep = options.sleep ?? delay;
  const still = options.still ?? (() => true);
  let forced = 0;
  let notProven = 0;
  for (let round = 0; round < END_ROUNDS; round++) {
    if (!still()) return { forced, notProven, left: 0 };
    const found = await processesOf(markers, agentId, options);
    if (found.length === 0) return { forced, notProven, left: 0 };
    const frozen = new Map<number, ProcessEntry>();
    for (const scan of [found, await processesOf(markers, agentId, options)])
      for (const entry of scan) {
        if (frozen.has(entry.pid)) continue;
        if ((await signalProven(entry, 'SIGSTOP', markers, options)) === 'signalled')
          frozen.set(entry.pid, entry);
      }
    for (const entry of await processesOf(markers, agentId, options))
      if (!frozen.has(entry.pid)) frozen.set(entry.pid, entry);
    for (const entry of frozen.values()) {
      if (!still()) {
        // Woken meanwhile: what was frozen goes on, rather than stay stopped.
        for (const left of frozen.values()) await signalProven(left, 'SIGCONT', markers, options);
        return { forced, notProven, left: 0 };
      }
      const result = await signalProven(entry, 'SIGKILL', markers, options);
      if (result === 'signalled') forced++;
      if (result === 'not_proven') notProven++;
    }
    await sleep(100);
  }
  return { forced, notProven, left: (await processesOf(markers, agentId, options)).length };
}

/**
 * Stops one agent for memory. The guard has already frozen its work
 * (`freezeRunaway`, SIGSTOP on every proven process but the host's). Then:
 * checked again (skipped and let go on if it changed while queued), held,
 * recorded, its host asked to tell its rooms (`announce`, at most 3 s), then
 * turned off. The host, left awake, is asked to end (SIGTERM) and given
 * `forceAfterMs` (5 s); frozen work gets no ask it could not act on. Then
 * everything still proven is frozen and killed in rounds (`endProven`). A
 * process whose proof fails is left running and logged, never forced. Single
 * pids only, never a group. A stop that fails lets frozen work go on and puts
 * the old record back.
 */
/** The end of a stop, by `/proc` or through the launcher: logged once, and the agent marked stopped. */
function finishStop(
  deps: GuardStopDeps,
  decision: Extract<GuardDecision, { kind: 'stop' }>,
  record: GuardStopRecord,
  told: number,
  frozen: number,
  asked: number,
  ended: { forced: number; notProven: number; left: number }
): GuardStopResult {
  const { agentId } = decision;
  if (ended.left > 0)
    deps.log.error('Memory guard could not end all of an agent’s processes', {
      agentId,
      left: ended.left,
    });
  deps.log.warn('Memory guard stopped an agent', {
    agentId,
    trigger: decision.trigger,
    peakBytes: decision.bytes,
    limitBytes: decision.limit,
    stops: record.count,
    roomsTold: told,
    frozen,
    asked,
    forced: ended.forced,
    notProvenLeftRunning: ended.notProven,
  });
  deps.rest.stopped(agentId);
  return { record, told, asked, forced: ended.forced, notProven: ended.notProven };
}

export async function stopForMemory(
  deps: GuardStopDeps,
  decision: Extract<GuardDecision, { kind: 'stop' }>,
  options: {
    /** Processes `freezeRunaway` froze: they go straight to the kill, as SIGTERM would wait. */
    frozen?: ReadonlySet<number>;
    /** Asked first: false (restarted or stopped by its owner while queued) skips the stop. */
    stillWanted?: () => boolean;
  } = {}
): Promise<GuardStopResult | null> {
  const { agentId } = decision;
  const proc = deps.proc ?? {};
  const kill = deps.kill;
  const sleep = deps.sleep ?? delay;
  const forceAfterMs = deps.forceAfterMs ?? 5_000;
  const frozen = options.frozen ?? new Set<number>();
  if (options.stillWanted && !options.stillWanted()) {
    await thawAgent(deps, agentId);
    deps.log.info('Memory guard stop skipped: the agent changed while it waited', { agentId });
    return null;
  }
  const agentDir = deps.agentDir(agentId);
  const before = await readGuardStop(agentDir);
  const record: GuardStopRecord = {
    count: (before?.count ?? 0) + 1,
    held: true,
    last: {
      at: new Date(deps.now()).toISOString(),
      bytes: decision.bytes,
      limit: decision.limit,
      percent: decision.percent,
      trigger: decision.trigger,
    },
  };
  let suspended = false;
  try {
    await deps.rest.suspend(agentId, 'out_of_memory');
    suspended = true;
    await writeGuardStop(agentDir, record, deps.log);
    const told = await announceStop(deps, agentId);
    await deps.stopHost(agentId);
    // The host, awake to post, is asked to end; frozen work cannot act on
    // an ask until it is let go, so it is left for the kill below.
    let asked = 0;
    let notProven = 0;
    if (deps.remote) {
      // Through the launcher: its host was just asked to stop; what's left goes in rounds.
      const ended = await deps.remote.end(agentId);
      return finishStop(deps, decision, record, told, frozen.size, 0, ended);
    }
    for (const entry of await processesOf(deps.markers, agentId, proc)) {
      if (frozen.has(entry.pid)) continue;
      const result = await signalProven(entry, 'SIGTERM', deps.markers, { ...proc, kill });
      if (result === 'signalled') asked++;
      if (result === 'not_proven') notProven++;
    }
    const deadline = deps.now() + forceAfterMs;
    const waiting = async () =>
      (await processesOf(deps.markers, agentId, proc)).filter((entry) => !frozen.has(entry.pid));
    let left = await waiting();
    while (left.length > 0 && deps.now() < deadline) {
      await sleep(200);
      left = await waiting();
    }
    const ended = await endProven(deps.markers, agentId, { ...proc, kill, sleep });
    return finishStop(deps, decision, record, told, frozen.size, asked, {
      ...ended,
      notProven: notProven + ended.notProven,
    });
  } catch (error) {
    if (suspended) deps.rest.clear(agentId);
    // Not a stop after all: what was frozen goes on, and the count goes back.
    await thawAgent(deps, agentId);
    if (suspended) {
      if (before) await writeGuardStop(agentDir, { ...before, held: false }, deps.log);
      else await rm(join(agentDir, GUARD_STOP_FILE), { force: true }).catch(() => {});
    }
    throw error;
  }
}

/**
 * The box's memory as the guard judges it: gVisor's AnonPages plus Shmem
 * (memory held as files in RAM, `/dev/shm` among them, which no process's
 * `Anonymous` shows), or the cgroup reading the box-full gate uses when that
 * is higher. Null when neither can be read.
 */
export async function readBoxMemory(
  options: { procRoot?: string; cgroupUsage?: () => Promise<number | null> } = {}
): Promise<BoxReading | null> {
  let fromMeminfo: { anon: number; shmem: number } | null = null;
  let used: number | null = null;
  try {
    const meminfo = await readFile(join(options.procRoot ?? '/proc', 'meminfo'), 'utf8');
    fromMeminfo = boxMemoryFromMeminfo(meminfo);
    // A meminfo without AnonPages or Shmem still says what is in use; under
    // gVisor it is the only reading that sees the whole pod.
    if (fromMeminfo === null) used = usedFromMeminfo(meminfo);
  } catch {
    // Read from the cgroup alone.
  }
  const fromCgroup = (await (options.cgroupUsage ?? readUsage)()) ?? null;
  if (fromMeminfo === null) {
    if (used !== null) {
      const cgroupWins = fromCgroup !== null && fromCgroup > used;
      return {
        bytes: cgroupWins ? fromCgroup : used,
        shmem: null,
        source: cgroupWins ? 'cgroup' : 'meminfo_used',
      };
    }
    return fromCgroup === null ? null : { bytes: fromCgroup, shmem: null, source: 'cgroup' };
  }
  const inside = fromMeminfo.anon + fromMeminfo.shmem;
  const cgroupWins = fromCgroup !== null && fromCgroup > inside;
  return {
    bytes: cgroupWins ? fromCgroup : inside,
    shmem: fromMeminfo.shmem,
    source: cgroupWins ? 'cgroup' : 'meminfo',
  };
}

/** `MemTotal − MemAvailable` from `/proc/meminfo`, in bytes, or null when either is missing. */
export function usedFromMeminfo(meminfo: string): number | null {
  const field = (name: string): number | null => {
    const match = new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm').exec(meminfo);
    return match ? Number(match[1]) * KIB : null;
  };
  const total = field('MemTotal');
  const available = field('MemAvailable');
  if (total === null || available === null) return null;
  return Math.max(0, total - available);
}

/** The box's reading, and the part of it held as files in RAM, when known. */
export interface BoxReading {
  bytes: number;
  shmem: number | null;
  /**
   * Which reading won: `meminfo` (AnonPages + Shmem), `meminfo_used`
   * (MemTotal − MemAvailable, when those two are missing) or `cgroup`. Under
   * gVisor only a meminfo source sees the whole pod.
   */
  source?: 'meminfo' | 'meminfo_used' | 'cgroup';
}

export const GUARD_INTERVAL_MS = 2_000;
/** How often the guard says, per agent, that it is still ending a stopped agent's leftovers. */
const LEFTOVER_LOG_MS = 60_000;

export interface MemoryGuardDeps extends GuardStopDeps {
  limits: GuardLimits;
  /** The agents the guard measures: assigned and not stopped by their owner, held ones included. */
  watched: () => string[];
  /**
   * Why an agent may not be stopped now: held after a guard stop
   * (`out_of_memory`) or resting (`resting`); null when it may.
   */
  held: (agentId: string) => 'out_of_memory' | 'resting' | null;
  /** The controller's serial queue: a stop never races a reconcile or a rest. */
  run: <T>(task: () => Promise<T>) => Promise<T>;
  /** Told after each stop, for the status report. */
  onStopped: (decision: Extract<GuardDecision, { kind: 'stop' }>, result: GuardStopResult) => void;
  readBox?: () => Promise<BoxReading | null>;
  /** A clock for how long a tick takes, in ms; `performance.now` unless a test gives one. */
  elapsed?: () => number;
  /** Kept in step each sample: an agent woken since its stop is released on disk. */
  status?: GuardStatus;
}

/**
 * Samples every `GUARD_INTERVAL_MS` and judges. A stop runs beside the
 * sampling, never instead of it: the box is still watched while one agent is
 * being stopped, and only that agent is left out of the decision. An agent
 * held after a stop is still measured, and any process its marker still
 * proves is ended each sample. A box high with no agent explaining it is
 * logged once per episode, noted for the report, and no one is stopped.
 */
export class MemoryGuard {
  private readonly judge: GuardJudge;
  private timer: NodeJS.Timeout | null = null;
  private sampling = false;
  private readonly stopping = new Map<string, Promise<void>>();
  private unexplainedNote: BoxNote | null = null;
  /** Which box-high notes this episode has logged; cleared once the box is back under the line. */
  private readonly loggedHigh = new Set<'rising' | 'sustained'>();
  private readonly leftoverLogged = new Map<string, number>();
  /** The 2 s scan's `/proc` reader, kept across ticks (they never overlap) so its buffer is made once. */
  private readonly reader = new ProcReader();
  /** Processes whose `/proc` file past its cap has been logged, by pid and file: each said once. */
  private readonly tooLargeLogged = new Set<string>();
  /** A run of ticks longer than the interval has been logged; cleared by the next tick inside it. */
  private slowLogged = false;

  constructor(private readonly deps: MemoryGuardDeps) {
    this.judge = new GuardJudge(deps.limits);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), GUARD_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private noteTooLarge(pid: number, file: string, agentId: string | undefined): void {
    const key = `${pid}:${file}`;
    if (this.tooLargeLogged.has(key)) return;
    if (this.tooLargeLogged.size >= 1024) this.tooLargeLogged.clear();
    this.tooLargeLogged.add(key);
    if (file === 'smaps')
      this.deps.log.warn(
        'Memory guard measured a process from its status: its smaps is over the cap',
        {
          agentId,
          pid,
        }
      );
    else
      this.deps.log.warn('Memory guard could not prove a process: a /proc file is over the cap', {
        pid,
        file,
      });
  }

  /**
   * The box valve is shedding sessions (`on`) or has finished. Meanwhile the
   * slow-leak clock is held, never more than `SHED_PAUSE_MAX_MS` an episode or
   * in any `SHED_PAUSE_WINDOW_MS`; the share rule and the backstop are not.
   */
  valveShedding(on: boolean): void {
    this.judge.setShedding(on);
  }

  /** For the status report's machine: why the box is high when no agent explains it, or null. */
  boxNote(): BoxNote | null {
    return this.unexplainedNote;
  }

  /** Every stop under way has finished; for tests and shutdown. */
  async settled(): Promise<void> {
    await Promise.all(this.stopping.values());
  }

  /** One sample and its decision; the timer calls it, and tests call it directly. */
  async tick(): Promise<GuardDecision> {
    if (this.sampling) return { kind: 'none' };
    this.sampling = true;
    const elapsed = this.deps.elapsed ?? (() => performance.now());
    const began = elapsed();
    try {
      const box = await (
        this.deps.readBox ?? (() => readBoxMemory({ procRoot: this.deps.proc?.procRoot }))
      )();
      if (box === null) return { kind: 'none' };
      const watched = this.deps.watched();
      if (this.deps.status)
        for (const agentId of watched)
          if (!this.stopping.has(agentId)) await this.deps.status.sync(agentId, this.deps.log);
      const memory = await this.readAgents(watched);
      const agents = new Map<string, number>();
      for (const [agentId, { bytes, processes }] of memory) {
        const held = this.deps.held(agentId);
        if (this.stopping.has(agentId) || held !== null) {
          if (held === 'out_of_memory' && !this.stopping.has(agentId) && processes > 0)
            await this.endLeftovers(agentId, processes);
          continue;
        }
        agents.set(agentId, bytes);
      }
      const decision = this.judge.judge({
        box: box.bytes,
        agents,
        at: this.deps.now(),
        stopping: this.stopping.size > 0,
      });
      if (this.judge.takePauseSpent())
        this.deps.log.info(
          'Memory guard runs its slow-leak clock again: the shedding pause limit is reached',
          {
            limitMs: SHED_PAUSE_MAX_MS,
            windowMs: SHED_PAUSE_WINDOW_MS,
          }
        );
      const { boxLimit, backstop } = this.deps.limits;
      if (decision.kind === 'unexplained') {
        // Once per kind in an episode: the box first rising past the line with
        // no one to blame, and then staying there, are each said once.
        const kind = decision.sustainedMs === undefined ? 'rising' : 'sustained';
        if (!this.loggedHigh.has(kind)) {
          this.loggedHigh.add(kind);
          const fields = {
            boxBytes: decision.box,
            limitBytes: boxLimit,
            shmemBytes: box.shmem,
            largestAgent: decision.largest?.agentId ?? null,
            largestBytes: decision.largest?.bytes ?? 0,
          };
          if (kind === 'rising')
            this.deps.log.warn(
              'Box memory is high, but no agent’s processes explain it; nothing stopped',
              fields
            );
          else
            this.deps.log.warn(
              'Box memory has stayed above the backstop level; the largest agent is stopped if it stays',
              fields
            );
        }
        // A code and figures, never text: Console words it.
        this.unexplainedNote = {
          code: decision.sustainedMs === undefined ? 'unexplained' : 'sustained',
          boxBytes: Math.max(0, Math.round(decision.box)),
          shmemBytes: box.shmem === null ? null : Math.max(0, Math.round(box.shmem)),
        };
        return decision;
      }
      if (box.bytes <= boxLimit * backstop) {
        this.unexplainedNote = null;
        this.loggedHigh.clear();
      }
      if (decision.kind === 'stop') this.begin(decision);
      return decision;
    } catch (error) {
      this.deps.log.error('Memory guard sample failed', { error: String(error) });
      return { kind: 'none' };
    } finally {
      this.noteDuration(elapsed() - began);
      this.reader.settle();
      this.sampling = false;
    }
  }

  /**
   * Once a run of ticks: one that took longer than the interval, with how
   * long and the pid of the largest file it read (an agent can slow the
   * guard with a huge `smaps`). Ids and times only, never a path.
   */
  private noteDuration(ms: number): void {
    if (ms <= GUARD_INTERVAL_MS) {
      this.slowLogged = false;
      return;
    }
    if (this.slowLogged) return;
    this.slowLogged = true;
    this.deps.log.warn('Memory guard sample took longer than its interval', {
      durationMs: Math.round(ms),
      pid: this.reader.largestPid,
    });
  }

  private begin(decision: Extract<GuardDecision, { kind: 'stop' }>): void {
    const { agentId } = decision;
    this.judge.forget(agentId);
    const done = freezeRunaway(this.deps, agentId)
      .catch(() => new Set<number>())
      .then((frozen) =>
        this.deps.run(() =>
          stopForMemory(this.deps, decision, {
            frozen,
            stillWanted: () =>
              this.deps.watched().includes(agentId) && this.deps.held(agentId) === null,
          })
        )
      )
      .then(
        (result) => {
          if (result) this.deps.onStopped(decision, result);
        },
        async (error: unknown) => {
          // The queue itself failed: nothing of the agent may stay frozen.
          await thawAgent(this.deps, agentId);
          this.deps.log.error('Memory guard could not stop an agent', {
            agentId,
            error: error instanceof Error ? error.name : 'unknown',
          });
        }
      )
      .finally(() => {
        this.stopping.delete(agentId);
        this.judge.restartClock(this.deps.now());
      });
    this.stopping.set(agentId, done);
  }

  /**
   * Each watched agent's bytes and process count: from `/proc` by its markers,
   * or on split boxes from the launcher's latest `measure` (undisputed bytes;
   * none fresh means no agent to blame, and the box is judged alone).
   */
  private async readAgents(
    watched: string[]
  ): Promise<Map<string, { bytes: number; processes: number }>> {
    if (this.deps.remote) {
      const read = this.deps.remote.read(watched);
      const out = new Map<string, { bytes: number; processes: number }>();
      for (const agentId of watched) {
        const entry = read?.get(agentId);
        if (entry) out.set(agentId, { bytes: entry.undisputed, processes: entry.processes });
      }
      return out;
    }
    const memory = await readAgentMemory(
      this.deps.markers,
      watched,
      {
        ...this.deps.proc,
        onTooLarge: (pid, file, agentId) => this.noteTooLarge(pid, file, agentId),
      },
      this.reader
    );
    return new Map(
      [...memory].map(([agentId, { bytes, processes }]) => [
        agentId,
        { bytes, processes: processes.length },
      ])
    );
  }

  /** Something of an agent held after a stop is still running: it is ended, with proof. */
  private async endLeftovers(agentId: string, count: number): Promise<void> {
    const ended = this.deps.remote
      ? await this.deps.remote.end(agentId)
      : await endProven(this.deps.markers, agentId, {
          ...this.deps.proc,
          kill: this.deps.kill,
          sleep: this.deps.sleep,
          still: () => this.deps.held(agentId) === 'out_of_memory' && !this.stopping.has(agentId),
        });
    const last = this.leftoverLogged.get(agentId) ?? Number.NEGATIVE_INFINITY;
    if (this.deps.now() - last < LEFTOVER_LOG_MS) return;
    this.leftoverLogged.set(agentId, this.deps.now());
    this.deps.log.warn('Memory guard ended processes left running by an agent it stopped', {
      agentId,
      found: count,
      forced: ended.forced,
      notProvenLeftRunning: ended.notProven,
      left: ended.left,
    });
  }
}

/** The highest `guard_stops` goes: Core takes no count above this. */
export const MAX_GUARD_STOP_COUNT = 1_000_000;

/**
 * What the status report reads from the guard: the detail while it holds an
 * agent stopped, and how often it has stopped each. `held` is asked whether
 * the agent is still held (`AgentRest.state(id)?.kind === 'out_of_memory'`),
 * so the next message clears the stop in one place.
 */
export class GuardStatus {
  private readonly records = new Map<string, GuardStopRecord>();
  private stopCount = 0;

  constructor(
    private readonly deps: {
      agentDir: (agentId: string) => string;
      stillHeld: (agentId: string) => boolean;
    }
  ) {}

  /** Reads an agent's record from disk once, so the count survives a controller restart. */
  async load(agentId: string): Promise<void> {
    if (this.records.has(agentId)) return;
    const record = await readGuardStop(this.deps.agentDir(agentId));
    if (record) this.records.set(agentId, record);
  }

  /** A stop just finished: its record, and one more stop since the controller started. */
  remember(agentId: string, record: GuardStopRecord): void {
    this.records.set(agentId, record);
    this.stopCount = Math.min(this.stopCount + 1, MAX_GUARD_STOP_COUNT);
  }

  /**
   * Agents the guard has stopped since the controller started, box-wide and
   * capped, for the status report's `guard_stops`. Unlike `oomKills`, it
   * doesn't fall when an agent is removed, and it starts at 0 on a restart.
   */
  stops(): number {
    return this.stopCount;
  }

  held(agentId: string): string | null {
    const record = this.records.get(agentId);
    if (!record || !this.deps.stillHeld(agentId)) return null;
    const { bytes, limit, percent, trigger } = record.last;
    return stopDetail({ kind: 'stop', agentId, trigger, bytes, limit, percent });
  }

  oomKills(agentId: string): number {
    return this.records.get(agentId)?.count ?? 0;
  }

  /**
   * After a controller restart: the agents a guard stop still holds (their
   * next message has not come) are held again, before the first reconcile
   * could start them. Resolves to the agents held.
   */
  async restore(
    agentIds: Iterable<string>,
    rest: GuardRest,
    log: Pick<Logger, 'error'>,
    /** Agents whose owner has stopped them: their hold is let go, not restored. */
    ownerStopped: Iterable<string> = []
  ): Promise<string[]> {
    for (const agentId of ownerStopped) {
      await this.load(agentId);
      if (this.records.get(agentId)?.held) await this.release(agentId, log);
    }
    const restored: string[] = [];
    for (const agentId of agentIds) {
      await this.load(agentId);
      if (!this.records.get(agentId)?.held) continue;
      await rest.suspend(agentId, 'out_of_memory');
      rest.stopped(agentId);
      restored.push(agentId);
    }
    return restored;
  }

  /**
   * The agent's next message woke it (called from the wake itself): it is no
   * longer held, on disk too, so a restart does not hold it again.
   */
  async release(agentId: string, log: Pick<Logger, 'error'>): Promise<void> {
    const record = this.records.get(agentId);
    if (record && !record.held) return;
    // The stop this wake ends; a newer one recorded meanwhile stays held.
    const stoppedAt = record?.last.at;
    const released = await releaseGuardStop(this.deps.agentDir(agentId), log, stoppedAt);
    if (released && this.records.get(agentId)?.last.at === released.last.at)
      this.records.set(agentId, released);
  }

  /** The fallback for a missed wake: polled each sample. */
  async sync(agentId: string, log: Pick<Logger, 'error'>): Promise<void> {
    const record = this.records.get(agentId);
    if (!record?.held || this.deps.stillHeld(agentId)) return;
    await this.release(agentId, log);
  }
}

/**
 * The guard's limits from the environment, or null when it stays off: only a
 * box whose memory limit the pod spec sets (`SWITCH_BOX_MEMORY_LIMIT_BYTES`,
 * the F1 valve's switch) runs it, so laptops are unchanged.
 * `SWITCH_AGENT_MEMORY_SHARE` (a fraction, 0.1-0.9) changes the share.
 */
export function guardLimitsFromEnv(
  env: NodeJS.ProcessEnv,
  log: Pick<Logger, 'warn'>,
  /** The controller's reserve (`controllerReserveFromEnv`): the guard works to the box limit less it. */
  reserve = 0
): GuardLimits | null {
  // The shared reading refuses a value under 256 MiB (a unit mistake: 6144
  // meant as MiB), saying so in the controller's log, and the guard stays off.
  const boxLimit = boxLimitFromEnv(env, { warn: (message: string) => log.warn(message) });
  if (boxLimit === null) return null;
  const raw = env.SWITCH_AGENT_MEMORY_SHARE?.trim();
  let share = DEFAULT_LIMITS.share;
  if (raw) {
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0.1 && value <= 0.9) share = value;
    else
      log.warn('SWITCH_AGENT_MEMORY_SHARE is not a fraction from 0.1 to 0.9; using the default', {
        value: raw,
        share,
      });
  }
  return { ...DEFAULT_LIMITS, boxLimit: boxLimit - reserve, podLimit: boxLimit, reserve, share };
}

/** The agent host's own pids from its owner records in `root` (`DetachedRuntime`'s watcher root). */
export async function hostPidsFromRoot(root: string): Promise<number[]> {
  const pids: number[] = [];
  for (const record of OWNER_RECORDS) {
    const pid = await recordedPid(join(root, record)).catch(() => null);
    if (pid !== null) pids.push(pid);
  }
  return pids;
}

/**
 * How the guard asks an agent's host to tell its rooms: the request is
 * written in the agent's state root first, then the host is asked, since a
 * host posts only with a fresh request (`memory-stop.ts`). Undefined where
 * the runtime has no way to ask (agents run as users of their own).
 */
export function hostAnnouncer(
  runtime: object,
  stateRoot: (agentId: string) => string,
  /** False on split boxes: the host's state root is on the agents' disk, and the launcher writes the request. */
  local = true
): ((agentId: string) => Promise<number>) | undefined {
  const asking = runtime as { stopForMemory?: (agentId: string) => Promise<number> };
  if (typeof asking.stopForMemory !== 'function') return undefined;
  const stopForMemory = asking.stopForMemory.bind(runtime);
  return async (agentId) => {
    if (local) await requestMemoryStop(stateRoot(agentId));
    return stopForMemory(agentId);
  };
}

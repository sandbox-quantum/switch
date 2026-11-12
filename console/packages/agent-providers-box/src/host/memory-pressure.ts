import { open, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Park under pressure. Each awake session (a session host and its provider
 * CLI) holds about 250 MiB; a parked one about 1 MiB. On a box with a fixed
 * memory limit, enough awake sessions kill the whole box with no work running
 * (in load tests, about 25 sessions in 6 GiB). So when the box passes
 * `startAt` of its limit, the quietest idle sessions are parked early until it
 * is back under `stopAt`; a session mid-turn is never parked. If parking
 * cannot bring it under `refuseAt`, a new session is refused rather than
 * started, and the room is told.
 *
 * Off unless the box's limit is known: `SWITCH_BOX_MEMORY_LIMIT_BYTES`, set by
 * the pod spec from its own memory limit, so nothing an agent runs can change
 * it. A machine nobody configured behaves as it always has.
 */

export type BoxMemory = { usage: number; limit: number };

/** Where the kernel (or gVisor) reports what the box uses: cgroup v1, then v2. */
const USAGE_FILES = [
  '/sys/fs/cgroup/memory/memory.usage_in_bytes',
  '/sys/fs/cgroup/memory.current',
];

/**
 * What a start is counted as before its session is up: a session host and its
 * provider CLI reach roughly this between being admitted and connecting, so
 * the starts already admitted are added to the reading the ceiling decides on.
 * Set by `SWITCH_SESSION_START_RESERVE_BYTES`; 512 MiB otherwise.
 */
export function startReserveFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  log: Pick<Console, 'warn'> = console
): number {
  return positiveFromEnv(env, 'SWITCH_SESSION_START_RESERVE_BYTES', 512 * 1024 * 1024, log);
}

/**
 * A positive whole number from `name`, or `fallback`. A value that is set but
 * is not one (0, negative, a typo) never means "no limit": it falls back, and
 * says so, so the mistake shows in the box's log.
 */
function positiveFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  log: Pick<Console, 'warn'>
): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (Number.isSafeInteger(value) && value > 0) return value;
  log.warn(`${name} is set to "${raw}", which is not a positive whole number; using ${fallback}.`);
  return fallback;
}

/**
 * At most this many sessions awake in the box at once (up, or starting),
 * whatever the memory reading says: a backstop while a session's real size
 * is not yet known. Parked sessions never count. Set by
 * `SWITCH_BOX_MAX_AWAKE_SESSIONS`; 15 otherwise.
 */
export function maxAwakeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  log: Pick<Console, 'warn'> = console
): number {
  return positiveFromEnv(env, 'SWITCH_BOX_MAX_AWAKE_SESSIONS', 15, log);
}

/** Thrown by a start the box has no room for: its room is told rather than the box killed. */
export class BoxFullError extends Error {
  constructor(message = 'The box is full: no session started.') {
    super(message);
    this.name = 'BoxFullError';
  }
}

/** The least box limit believed: anything smaller is a unit mistake (6144 meant as MiB). */
export const MIN_BOX_LIMIT_BYTES = 256 * 1024 * 1024;

/**
 * The box's memory limit in bytes (`SWITCH_BOX_MEMORY_LIMIT_BYTES`), or null
 * when it is unset or can't be right, which leaves the valve off as on a
 * laptop. A set value that is not a whole number of bytes, or is under
 * 256 MiB, is refused with a warning, so the mistake shows in the box's log
 * rather than refusing every session.
 */
export function boxLimitFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  log: Pick<Console, 'warn'> = console
): number | null {
  const raw = env.SWITCH_BOX_MEMORY_LIMIT_BYTES?.trim();
  if (!raw) return null;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value <= 0) {
    log.warn(
      `SWITCH_BOX_MEMORY_LIMIT_BYTES is set to "${raw}", which is not a positive whole number of bytes; the box-full check stays off.`
    );
    return null;
  }
  if (value < MIN_BOX_LIMIT_BYTES) {
    log.warn(
      `SWITCH_BOX_MEMORY_LIMIT_BYTES is set to ${value}, which is under 256 MiB, so it cannot be bytes; the box-full check stays off.`
    );
    return null;
  }
  return value;
}

/**
 * The box's use on the memory guard's scale (`readBoxMemory`): the larger of
 * anonymous memory plus shmem from `/proc/meminfo` and the cgroup's figure,
 * so a host's fallback reads what the guard and the box valve read. The
 * meminfo read is bounded (64 KiB, one buffer).
 */
export async function readBoxScaleUsage(procRoot = '/proc'): Promise<number | null> {
  let inside: number | null = null;
  try {
    const handle = await open(`${procRoot}/meminfo`, 'r');
    try {
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const text = buffer.toString('utf8', 0, bytesRead);
      const field = (name: string): number | null => {
        const match = new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm').exec(text);
        return match ? Number(match[1]) * 1024 : null;
      };
      const anon = field('AnonPages');
      const shmem = field('Shmem');
      if (anon !== null && shmem !== null) inside = anon + shmem;
    } finally {
      await handle.close();
    }
  } catch {
    // The cgroup alone.
  }
  const cgroup = await readUsage();
  if (inside === null) return cgroup;
  return cgroup === null ? inside : Math.max(inside, cgroup);
}

export async function readUsage(files: string[] = USAGE_FILES): Promise<number | null> {
  return (await readUsageFrom(files))?.usage ?? null;
}

/** The box's memory use and the file it came from: the first of `files` that reads. */
export async function readUsageFrom(
  files: string[] = USAGE_FILES
): Promise<{ usage: number; source: string } | null> {
  for (const file of files) {
    try {
      const raw = (await readFile(file, 'utf8')).trim();
      const value = Number(raw);
      if (raw !== '' && Number.isFinite(value) && value >= 0) return { usage: value, source: file };
    } catch {
      // The next file, or none.
    }
  }
  return null;
}

/** One session that could be parked now: idle, not mid-turn, not being started. */
export type ParkCandidate = {
  sessionId: string;
  /** When it last finished something, in ms; the oldest goes first. */
  idleSinceMs: number;
  /** Another session of the same agent is awake: one agent in two rooms counts twice. */
  duplicate: boolean;
  /** Asks the session to park; resolves to whether it agreed. */
  park: () => Promise<boolean>;
};

export type ParkSource = () => ParkCandidate[];

export type ValveOptions = {
  limit: number | null;
  readUsage: () => Promise<number | null>;
  /** Counted per start admitted and not yet settled (see `startReserveFromEnv`). */
  startReserve?: number;
  /** The most sessions awake at once (see `maxAwakeFromEnv`); only on a box. */
  maxAwake?: number;
  /** Where `readUsage` reads from, for the start-up line. */
  source?: string;
  startAt?: number;
  stopAt?: number;
  refuseAt?: number;
  /** How long to wait after a park for the memory reading to fall. */
  settleMs?: number;
  log?: Pick<Console, 'info' | 'warn'>;
};

/** Duplicates first, then the longest idle. */
export function parkOrder<T extends Pick<ParkCandidate, 'duplicate' | 'idleSinceMs'>>(
  candidates: T[]
): T[] {
  return [...candidates].sort(
    (a, b) => Number(b.duplicate) - Number(a.duplicate) || a.idleSinceMs - b.idleSinceMs
  );
}

export class PressureValve {
  private readonly sources = new Set<ParkSource>();
  private readonly awakeSources = new Set<() => number>();
  private shedding: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private announced = false;
  /** Starts admitted and not yet settled: each counts as `startReserve` on top of the reading. */
  private inFlight = 0;
  /** Why the last start was refused, in plain words, for the log. */
  lastRefusal = '';
  private warnedUnreadable = false;
  readonly startAt: number;
  readonly stopAt: number;
  readonly refuseAt: number;

  constructor(private readonly options: ValveOptions) {
    this.startAt = options.startAt ?? 0.8;
    this.stopAt = options.stopAt ?? 0.65;
    this.refuseAt = options.refuseAt ?? 0.9;
  }

  get enabled(): boolean {
    return this.options.limit !== null;
  }

  /** Each agent host offers its parkable sessions; the returned function withdraws them. */
  register(source: ParkSource): () => void {
    this.sources.add(source);
    return () => this.sources.delete(source);
  }

  /** Each agent host counts its own sessions that are up; the returned function withdraws it. */
  registerAwake(count: () => number): () => void {
    this.awakeSources.add(count);
    return () => this.awakeSources.delete(count);
  }

  /** Sessions up across every agent host in this process (starts in flight not included). */
  get awake(): number {
    let total = 0;
    for (const count of this.awakeSources) total += count();
    return total;
  }

  /** Watches every `intervalMs` while enabled. */
  watch(intervalMs = 5000): () => void {
    void this.announce();
    if (!this.enabled || this.timer) return () => {};
    this.timer = setInterval(() => void this.check(), intervalMs);
    this.timer.unref?.();
    return () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    };
  }

  async memory(): Promise<BoxMemory | null> {
    if (this.options.limit === null) return null;
    const usage = await this.options.readUsage();
    if (usage === null) {
      // Failing open: without a reading nothing is parked or refused. Said once, loudly.
      if (!this.warnedUnreadable)
        this.options.log?.warn(
          `Park under pressure can't read this box's memory use${
            this.options.source ? ` (from ${this.options.source})` : ''
          }, so it is NOT protecting the box: no session is parked early and none is refused.`
        );
      this.warnedUnreadable = true;
      return null;
    }
    return { usage, limit: this.options.limit };
  }

  /** Says once, at start, whether the valve is on, what it reads, and against what limit. */
  async announce(): Promise<void> {
    if (this.announced) return;
    this.announced = true;
    const limit = this.options.limit;
    if (limit === null) {
      this.options.log?.info(
        'Park under pressure is off: SWITCH_BOX_MEMORY_LIMIT_BYTES is not set.'
      );
      return;
    }
    const memory = await this.memory();
    if (!memory) return;
    this.options.log?.info(
      `Park under pressure is on: reading ${this.options.source ?? 'the box memory use'}, limit ${limit} bytes; now at ${percent(memory)}. Parks idle sessions from ${Math.round(this.startAt * 100)}% down to ${Math.round(this.stopAt * 100)}%, refuses new ones at ${Math.round(this.refuseAt * 100)}%.`
    );
  }

  /** Parks sessions if the box is past `startAt`. */
  async check(): Promise<void> {
    const memory = await this.memory();
    if (memory && memory.usage >= this.startAt * memory.limit) await this.shed();
  }

  /**
   * Whether a new session may start now, counting every start already
   * admitted and not yet up (`startReserve` each) on top of the reading: a
   * burst of parallel starts each grows after it is admitted, so the bare
   * reading is out of date by the time it matters (in a load test, 21 sessions
   * up in 26 s, and the box gone before any refusal). Below `refuseAt` it is let
   * in; otherwise only if parking brings the box back below it. The ceiling:
   * when every awake session is busy, a new one is refused rather than allowed
   * to kill the box. A start let in must be `settle`d once it is up or has
   * failed.
   */
  async admit(): Promise<boolean> {
    // The backstop first: one more awake than the cap parks an idle one to make room, or is refused.
    if (this.enabled && this.awake + this.inFlight + 1 > this.cap) {
      await this.parkForRoom();
      if (this.awake + this.inFlight + 1 > this.cap) {
        this.lastRefusal = `the box is at its limit of ${this.cap} awake sessions (${this.awake} up, ${this.inFlight} starting)`;
        this.options.log?.warn(`Refusing a session start: ${this.lastRefusal}.`);
        return false;
      }
    }
    const fits = (memory: BoxMemory | null) =>
      !memory || memory.usage + (this.inFlight + 1) * this.reserve < this.refuseAt * memory.limit;
    let ok = fits(await this.memory());
    if (!ok) {
      await this.shed();
      ok = fits(await this.memory());
    }
    if (ok) this.inFlight++;
    else {
      this.lastRefusal = `the box is near its memory limit with ${this.inFlight} start(s) already under way`;
      this.options.log?.warn(`Refusing a session start: ${this.lastRefusal}.`);
    }
    return ok;
  }

  /** A start let in by `admit` is up, or failed: it no longer counts as in flight. */
  settle(): void {
    if (this.inFlight > 0) this.inFlight--;
  }

  /** How many admitted starts are not yet settled (for tests and logs). */
  get starting(): number {
    return this.inFlight;
  }

  private capValue: number | null = null;
  private get cap(): number {
    if (this.options.limit === null) return Number.POSITIVE_INFINITY;
    this.capValue ??=
      this.options.maxAwake ?? maxAwakeFromEnv(process.env, this.options.log ?? console);
    return this.capValue;
  }

  /** Parks the quietest idle session to make room under the cap, and waits for it to go. */
  private async parkForRoom(): Promise<void> {
    const before = this.awake;
    for (const candidate of parkOrder([...this.sources].flatMap((source) => source()))) {
      if (!(await candidate.park().catch(() => false))) continue;
      this.options.log?.info(
        `Parking session ${candidate.sessionId} early: the box is at its cap of ${this.cap} awake sessions.`
      );
      // Its host exits once it has parked; give it a moment to go.
      for (let waited = 0; waited < 5000 && this.awake >= before; waited += 100) await delay(100);
      return;
    }
  }

  private reserveValue: number | null = null;
  private get reserve(): number {
    if (this.options.limit === null) return 0;
    this.reserveValue ??=
      this.options.startReserve ?? startReserveFromEnv(process.env, this.options.log ?? console);
    return this.reserveValue;
  }

  /** One shed at a time: concurrent callers wait for the same one. */
  private shed(): Promise<void> {
    this.shedding ??= this.shedNow().finally(() => {
      this.shedding = null;
    });
    return this.shedding;
  }

  private async shedNow(): Promise<void> {
    const tried = new Set<string>();
    for (;;) {
      const memory = await this.memory();
      if (!memory || memory.usage < this.stopAt * memory.limit) return;
      const next = parkOrder(
        [...this.sources].flatMap((source) => source()).filter((c) => !tried.has(c.sessionId))
      )[0];
      if (!next) {
        this.options.log?.warn(
          `The box is at ${percent(memory)} of its memory with no idle session left to park.`
        );
        return;
      }
      tried.add(next.sessionId);
      const parked = await next.park().catch(() => false);
      if (parked) {
        this.options.log?.info(
          `Parking session ${next.sessionId} early: the box is at ${percent(memory)} of its memory.`
        );
        await delay(this.options.settleMs ?? 1500);
      }
    }
  }
}

function percent(memory: BoxMemory): string {
  return `${Math.round((memory.usage / memory.limit) * 100)}%`;
}

/** The one valve every agent host in this process shares: a controller runs them all. */
let usageSource: string | undefined;
export const pressureValve = new PressureValve({
  limit: boxLimitFromEnv(),
  readUsage: async () => {
    const read = await readUsageFrom();
    usageSource = read?.source ?? usageSource;
    return read?.usage ?? null;
  },
  get source() {
    return usageSource ?? USAGE_FILES.join(' or ');
  },
  log: console,
});

/** What a room is told when a new session is refused. */
export const BOX_FULL_MESSAGE =
  "I can't start yet. Your other agents are using all the room in your Switch cloud right now. Send this again in a minute, or once one of them has finished.";

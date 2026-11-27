/**
 * "Wait for room": a room message that needs a new session while the box is
 * full waits here instead of being let go, and starts by itself once there is
 * room.
 *
 * One list for every agent host in this process, as the box-full gate it
 * waits on (`pressureValve`) is: the oldest waiting message goes first,
 * whichever agent it is for, and the limits are counted across them all.
 * Bounded both ways: at most `max` messages wait, and
 * none longer than `maxWaitMs`. Past either, it is let go with a line.
 */

/** Messages waiting at once, across every agent here (one box is one user). */
export const WAIT_FOR_ROOM_MAX = 20;
/** How long one message may wait before it is let go. */
export const WAIT_FOR_ROOM_MS = 10 * 60 * 1000;
/** How often the waiting messages try the box-full gate again. */
export const WAIT_FOR_ROOM_RETRY_MS = 5_000;

/** Posted once to a message's room when it starts waiting (agreed wording). */
export const WAITING_FOR_ROOM_MESSAGE =
  "Your other agents are using all the room in your Switch cloud right now. I'll start on this as soon as there's room, so there's no need to send it again.";
/** Posted when a message is let go for waiting too long, or the list being full. */
export const STOPPED_WAITING_MESSAGE =
  "I couldn't get room in time, so I've stopped waiting. Send this again once your other agents have finished.";
/** Posted when the session a message waits for is reset (`!reset`) meanwhile. */
export const RESET_WHILE_WAITING_MESSAGE =
  "This message was waiting for room, but I've been reset since, so I won't start on it. Send it again if you still need it.";

/** Why a waiting message was let go. */
export type GiveUpReason = 'timed out' | 'list full';

/**
 * What a message waits for: `room` in a full box (the gate refused its
 * start), or a `start` its session failed and was told it is kept for (no
 * login, a setup error). Both share the limits; only `room` waits show as
 * "Waiting for room", and only they wait their turn oldest first.
 */
export type WaitKind = 'room' | 'start';

/** How often a session that failed to start is tried again while its messages are kept. */
export const START_RETRY_MS = 30_000;
/**
 * The slow fallback for a failure only a person can fix (no login, a setup
 * error): what fixes it restarts or redefines the host, which retries at once
 * (`hurry`), so a retry on the clock is only a backstop.
 */
export const SLOW_START_RETRY_MS = 120_000;

export type RoomWaiter = {
  /** The agent it is for, for that agent's status. */
  agentId: string;
  /** The session it waits to start; one start serves every message waiting for it. */
  sessionId: string;
  /** Which run of the agent's host added it, so only that run takes it off when it stops. */
  host?: string;
  roomId: string;
  messageId: string;
  /** When it first found the box full, in ms; kept across restarts by the journal. */
  sinceMs: number;
  /** What it waits for; `room` unless said. */
  kind?: WaitKind;
  /** For a `start` wait: how often to retry it, instead of the list's `startRetryMs`. */
  retryEveryMs?: number;
  /**
   * Tries to start its session now. True once it started (every message
   * waiting for that session leaves the list), false while there is still no
   * room. A throw counts as no room, and is logged.
   */
  retry: () => Promise<boolean>;
  /** Lets it go: it waited too long. Its room is told. */
  giveUp: (reason: GiveUpReason) => Promise<void>;
};

export type WaitingCount = { count: number; oldestSince: string | null };

export type RoomWaitListOptions = {
  max?: number;
  maxWaitMs?: number;
  retryMs?: number;
  /** How often a `start` wait is retried (`START_RETRY_MS`). */
  startRetryMs?: number;
  now?: () => number;
  log?: Pick<Console, 'info' | 'warn'>;
};

const keyOf = (waiter: { agentId: string; roomId: string; messageId: string }) =>
  JSON.stringify([waiter.agentId, waiter.roomId, waiter.messageId]);

export class RoomWaitList {
  private readonly waiters = new Map<string, RoomWaiter>();
  private readonly listeners = new Set<(agentId: string) => void>();
  private readonly removals = new Set<(waiter: RoomWaiter) => void>();
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  readonly max: number;
  readonly maxWaitMs: number;
  readonly retryMs: number;
  readonly startRetryMs: number;
  /** When each session with `start` waits was last tried. */
  private readonly startTried = new Map<string, number>();
  private readonly now: () => number;
  private readonly log: Pick<Console, 'info' | 'warn'>;

  constructor(options: RoomWaitListOptions = {}) {
    this.max = options.max ?? WAIT_FOR_ROOM_MAX;
    this.maxWaitMs = options.maxWaitMs ?? WAIT_FOR_ROOM_MS;
    this.retryMs = options.retryMs ?? WAIT_FOR_ROOM_RETRY_MS;
    this.startRetryMs = options.startRetryMs ?? START_RETRY_MS;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? console;
  }

  /** Messages waiting now, across every agent, for either reason (the limit counts them all). */
  get size(): number {
    return this.waiters.size;
  }

  /** Messages waiting for room now, across every agent: the queue a new start goes behind. */
  get waitingForRoom(): number {
    let count = 0;
    for (const waiter of this.waiters.values()) if ((waiter.kind ?? 'room') === 'room') count++;
    return count;
  }

  has(agentId: string, roomId: string, messageId: string): boolean {
    return this.waiters.has(keyOf({ agentId, roomId, messageId }));
  }

  /** Whether any message waits to start this session. */
  waitingFor(sessionId: string): boolean {
    for (const waiter of this.waiters.values()) if (waiter.sessionId === sessionId) return true;
    return false;
  }

  /** The sessions of one agent that have messages waiting. */
  sessionsOf(agentId: string): string[] {
    return [
      ...new Set(
        [...this.waiters.values()]
          .filter((waiter) => waiter.agentId === agentId)
          .map((waiter) => waiter.sessionId)
      ),
    ];
  }

  /**
   * Adds a message. `full` when `max` already wait (the caller lets it go
   * with the stopped-waiting line), `expired` when it has already waited its
   * limit (after a restart), `already` when it is waiting.
   */
  add(waiter: RoomWaiter): 'waiting' | 'already' | 'full' | 'expired' {
    const key = keyOf(waiter);
    if (this.waiters.has(key)) return 'already';
    if (this.now() - waiter.sinceMs >= this.maxWaitMs) return 'expired';
    if (this.waiters.size >= this.max) return 'full';
    this.waiters.set(key, waiter);
    this.changed(waiter.agentId);
    this.arm();
    return 'waiting';
  }

  /** Takes messages off the list without a line (delivered, reset, forgotten, or its host stopped). */
  removeWhere(match: (waiter: RoomWaiter) => boolean): RoomWaiter[] {
    const removed: RoomWaiter[] = [];
    for (const [key, waiter] of this.waiters)
      if (match(waiter)) {
        this.waiters.delete(key);
        removed.push(waiter);
      }
    for (const sessionId of new Set(removed.map((waiter) => waiter.sessionId)))
      if (![...this.waiters.values()].some((waiter) => waiter.sessionId === sessionId))
        this.startTried.delete(sessionId);
    for (const agentId of new Set(removed.map((waiter) => waiter.agentId))) this.changed(agentId);
    for (const waiter of removed)
      for (const listener of this.removals) {
        try {
          listener(waiter);
        } catch (error) {
          this.log.warn(`A wait-for-room listener failed: ${String(error)}`);
        }
      }
    if (!this.waiters.size) this.disarm();
    return removed;
  }

  /** The waiting messages that match, oldest first (a copy). */
  list(match: (waiter: RoomWaiter) => boolean = () => true): RoomWaiter[] {
    return [...this.waiters.values()].filter(match).sort((a, b) => a.sinceMs - b.sinceMs);
  }

  /** Called with each message taken off the list, for whatever reason; the returned function stops it. */
  onRemoved(listener: (waiter: RoomWaiter) => void): () => void {
    this.removals.add(listener);
    return () => this.removals.delete(listener);
  }

  /**
   * The box valve has room for this session now: its room waits are
   * tried at once, ahead of the next round, and leave the list if it started.
   */
  startNow(sessionId: string): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      const waiter = [...this.waiters.values()].find(
        (w) => w.sessionId === sessionId && (w.kind ?? 'room') === 'room'
      );
      if (!waiter) return false;
      let started = false;
      try {
        started = await waiter.retry();
      } catch (error) {
        this.log.warn(
          `Session ${sessionId} could not be started for its waiting message(s): ${error instanceof Error ? error.message : String(error)}`
        );
        return false;
      }
      if (started)
        this.removeWhere(
          (other) => other.sessionId === sessionId && (other.kind ?? 'room') === 'room'
        );
      return started;
    };
    // After any round under way; a round starting meanwhile may try it too,
    // which the host's own start de-duplicates.
    return (this.ticking ?? Promise.resolve()).then(run, run);
  }

  /** What one agent's status reports: how many wait, and since when the oldest. */
  count(agentId: string, kind: WaitKind = 'room'): WaitingCount {
    let count = 0;
    let oldest: number | null = null;
    for (const waiter of this.waiters.values()) {
      if (waiter.agentId !== agentId || (waiter.kind ?? 'room') !== kind) continue;
      count++;
      if (oldest === null || waiter.sinceMs < oldest) oldest = waiter.sinceMs;
    }
    return { count, oldestSince: oldest === null ? null : new Date(oldest).toISOString() };
  }

  /**
   * Retries the matching `start` waits now rather than on their clock:
   * something that may have fixed them happened (the agent's definition or
   * login was replaced).
   */
  hurry(match: (waiter: RoomWaiter) => boolean): Promise<void> {
    let any = false;
    for (const waiter of this.waiters.values())
      if (waiter.kind === 'start' && match(waiter)) {
        this.startTried.set(waiter.sessionId, Number.NEGATIVE_INFINITY);
        any = true;
      }
    return any ? this.tick() : Promise.resolve();
  }

  /** Called with the agent whose waiting count may have changed; the returned function stops it. */
  onChange(listener: (agentId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * One round: lets go of every message past its limit, then tries the
   * waiting sessions oldest first, stopping at the first that still finds no
   * room, so a younger message never starts ahead of an older one. A session
   * whose start fails for another reason (a throw) is stepped over, so one
   * broken session never holds up the rest; it is tried again next round and
   * let go at its limit like any other. One round at a time; a caller during
   * one waits for it.
   */
  tick(): Promise<void> {
    this.ticking ??= this.round().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async round(): Promise<void> {
    const now = this.now();
    const expired = this.removeWhere((waiter) => now - waiter.sinceMs >= this.maxWaitMs);
    for (const waiter of expired) {
      this.log.warn(
        `Room ${waiter.roomId}'s message ${waiter.messageId} waited ${Math.round((now - waiter.sinceMs) / 1000)} s for ${(waiter.kind ?? 'room') === 'room' ? 'room in the box' : 'its session to start'}; letting it go.`
      );
      await waiter
        .giveUp('timed out')
        .catch((error: unknown) =>
          this.log.warn(
            `Could not let go of message ${waiter.messageId} after its wait: ${error instanceof Error ? error.message : String(error)}`
          )
        );
    }
    // Sessions that failed to start, every `startRetryMs` each. Whatever
    // happens they never hold up anything else: what is wrong is theirs.
    for (const waiter of [...this.waiters.values()].filter((w) => w.kind === 'start')) {
      const last = this.startTried.get(waiter.sessionId);
      // It has only just failed: its first retry is a full interval on.
      if (last === undefined) {
        this.startTried.set(waiter.sessionId, this.now());
        continue;
      }
      if (this.now() - last < (waiter.retryEveryMs ?? this.startRetryMs)) continue;
      if (!this.waiters.has(keyOf(waiter))) continue;
      this.startTried.set(waiter.sessionId, this.now());
      let started = false;
      try {
        started = await waiter.retry();
      } catch (error) {
        this.log.warn(
          `Session ${waiter.sessionId} still could not be started for its kept message(s): ${error instanceof Error ? error.message : String(error)}`
        );
      }
      if (!started) continue;
      this.startTried.delete(waiter.sessionId);
      this.removeWhere((other) => other.sessionId === waiter.sessionId && other.kind === 'start');
    }
    const tried = new Set<string>();
    const order = [...this.waiters.values()]
      .filter((waiter) => (waiter.kind ?? 'room') === 'room')
      .sort((a, b) => a.sinceMs - b.sinceMs);
    for (const waiter of order) {
      if (tried.has(waiter.sessionId)) continue;
      tried.add(waiter.sessionId);
      // Taken off meanwhile (delivered by another path, reset, or its host stopped).
      if (!this.waiters.has(keyOf(waiter))) continue;
      let started: boolean;
      try {
        started = await waiter.retry();
      } catch (error) {
        // Not "no room": something else is wrong with this session. The box
        // may well have room, so the ones behind it are tried.
        this.log.warn(
          `Session ${waiter.sessionId} could not be started for its waiting message(s), so the next one is tried: ${error instanceof Error ? error.message : String(error)}`
        );
        continue;
      }
      if (!started) break;
      const left = this.removeWhere(
        (other) => other.sessionId === waiter.sessionId && (other.kind ?? 'room') === 'room'
      );
      this.log.info(
        `Session ${waiter.sessionId} started after waiting ${Math.round((this.now() - waiter.sinceMs) / 1000)} s for room; ${left.length} waiting message(s) go to it.`
      );
    }
  }

  private changed(agentId: string): void {
    for (const listener of this.listeners) {
      try {
        listener(agentId);
      } catch (error) {
        this.log.warn(`A wait-for-room listener failed: ${String(error)}`);
      }
    }
  }

  private arm(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.retryMs);
    this.timer.unref?.();
  }

  private disarm(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

/** The list every agent host in this process shares, beside `pressureValve`. */
export const roomWaits = new RoomWaitList();

/**
 * The process that is a multi-room agent.
 *
 * Everything else in this package is a mechanism — a scope the protocol
 * accepts, an operation that takes a room, an audience label, a schedule. This
 * is the thing that holds a `multi` connection open and stays up, which is what
 * turns those mechanisms into an agent reachable on several surfaces at once.
 *
 * **It does not drive a model.** `onTurn` is injected. What is left here is the
 * part with rules, and it is small enough to be worth getting exactly right:
 *
 * - **Turns do not overlap.** There is one context window. Two turns in flight
 *   interleave two conversations inside it, and the agent answers each with
 *   half of the other. Everything queues behind the turn already running,
 *   including a scheduled wake-up, which is a turn in the same context rather
 *   than a second thread of thought.
 * - **A turn carries the room that woke it**, because a reply has to reach the
 *   surface the request came from and nothing else can say which that was.
 * - **The room set belongs to the server.** A `single`-scope session can claim
 *   a room out from under this connection; when it does, the server stops
 *   delivering that room and this stops acting in it — including for scheduled
 *   work already aimed there.
 *
 * The clock is injected too, so a host under test never waits on a real timer
 * and a host in production uses `setTimeout` without this module knowing.
 */

import {
  due,
  nextDelayMs,
  parseWakeups,
  reschedule,
  serialiseWakeups,
  type Wakeup,
} from './schedule';
import type { AgentBridgeEvent } from './types';

export interface Clock {
  now(): number;
  /** Arm a one-shot timer; returns a function that cancels it. */
  setTimer(delayMs: number, fire: () => void): () => void;
}

export interface HostLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** One thing for the agent to do, and where. */
export type Turn = {
  /** The room to act in, or undefined for a wake-up that named none. */
  roomId?: string;
  /**
   * Set when events were dropped before this turn and cannot be replayed.
   *
   * Attached to the next turn rather than surfaced as one of its own: the only
   * response is to re-read context, and the agent cannot know whether anything
   * it cared about was lost, so waking it for a gap spends a turn on a maybe.
   */
  gap?: string;
} & ({ kind: 'event'; event: AgentBridgeEvent } | { kind: 'wakeup'; wakeup: Wakeup });

export interface MultiRoomHostDeps {
  /** The rooms this agent works in, as declared at open. */
  rooms: string[];
  onTurn(turn: Turn): Promise<void>;
  /** Read the persisted schedule — the agent's room document. */
  loadSchedule(): Promise<string>;
  saveSchedule(text: string): Promise<void>;
  clock: Clock;
  log: HostLogger;
}

export class MultiRoomHost {
  private readonly deps: MultiRoomHostDeps;
  private roomSet: string[];
  private wakeups: Wakeup[] = [];
  private cancelTimer: (() => void) | null = null;
  /** The turn in flight, so the next one can wait behind it rather than beside
   * it. This single promise is the whole of the serialisation. */
  private tail: Promise<void> = Promise.resolve();
  private pendingGap: string | null = null;
  private running = false;
  /** Serialises `saveSchedule`. `fire`, `schedule` and `cancel` all write, and
   * two in flight can land out of order — leaving the stored document behind
   * the schedule, so a retired one-shot returns on restart and fires again. */
  private persistTail: Promise<void> = Promise.resolve();

  constructor(deps: MultiRoomHostDeps) {
    this.deps = deps;
    this.roomSet = [...deps.rooms];
  }

  get rooms(): string[] {
    return [...this.roomSet];
  }

  async start(): Promise<void> {
    this.running = true;
    this.wakeups = parseWakeups(await this.deps.loadSchedule());
    this.arm();
  }

  /**
   * Stop taking work, and let the turn in flight finish.
   *
   * Cutting a turn off mid-thought leaves the room with a half-answer and no
   * explanation, which is worse than the extra moment spent waiting.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.disarm();
    await this.settled();
  }

  /**
   * Resolve once the chain has stopped moving.
   *
   * Awaiting the tail *once* is not enough: a turn can queue another, and the
   * wake-up cycle awaits a write before queueing the turns it found due — so a
   * single await returns through that window, and those turns then run against
   * a transport the caller believed drained.
   *
   * On a *running* host with traffic arriving this may never settle — that is
   * what "stopped moving" means. `stop` calls it after refusing new work, which
   * is the case it is written for.
   */
  async settled(): Promise<void> {
    for (let seen = this.tail; ; seen = this.tail) {
      await seen;
      if (this.tail === seen) return;
    }
  }

  /**
   * Another stream took this connection over.
   *
   * Not a shutdown: nothing was finished and nothing asked for this. The agent
   * has stopped receiving and no longer holds any room, so it must stop acting
   * as though it does — otherwise scheduled work keeps firing into rooms it was
   * evicted from while the process looks healthy.
   */
  evicted(reason: string): void {
    this.deps.log.error('MultiRoomHost: evicted, no longer acting in any room', { reason });
    this.running = false;
    this.disarm();
    this.roomSet = [];
  }

  /**
   * What the event stream calls.
   *
   * **Do not call this from inside `onTurn`.** It chains behind the turn
   * currently running, so awaiting it from within that turn waits on a promise
   * only that turn can resolve — a deadlock, which `stop` then waits behind.
   */
  async deliver(event: AgentBridgeEvent): Promise<void> {
    if (!this.running) return;
    if (!this.roomSet.includes(event.room_id)) {
      // Already gone from our set — either the server stopped covering it or a
      // sibling connection claimed it while this was queued.
      this.deps.log.debug('MultiRoomHost: dropped an event for a room we no longer hold', {
        roomId: event.room_id,
      });
      return;
    }
    await this.run({ kind: 'event', event, roomId: event.room_id });
  }

  /** Adopt the server's room list; it is the authority on what we cover. */
  acceptRooms(rooms: string[]): void {
    const lost = this.roomSet.filter((room) => !rooms.includes(room));
    this.roomSet = [...rooms];
    if (rooms.length === 0) {
      // A malformed `connection_state` frame also lands here, since the stream
      // filters non-strings out of the list. Either way the agent now silently
      // drops every event while looking healthy, which is worth an error.
      this.deps.log.error('MultiRoomHost: the server says we cover no rooms at all');
    } else if (lost.length > 0) {
      this.deps.log.warn('MultiRoomHost: rooms taken from this connection', { lost });
    }
  }

  /**
   * Record that events were dropped, keeping the **earliest** report.
   *
   * Gaps arrive in order, so the first pending one carries the lowest sequence
   * — and re-reading from there covers everything a later one would have.
   * Overwriting narrows the window the agent is told about, silently, which is
   * the opposite of what a gap is for.
   */
  noteGap(reason: string): void {
    this.pendingGap ??= reason;
  }

  /** Add or replace a wake-up, and persist so a restart keeps it. */
  async schedule(wakeup: Wakeup): Promise<void> {
    this.wakeups = [...this.wakeups.filter((w) => w.id !== wakeup.id), wakeup];
    await this.persist();
    this.arm();
  }

  async cancel(id: string): Promise<void> {
    this.wakeups = this.wakeups.filter((w) => w.id !== id);
    await this.persist();
    this.arm();
  }

  // ── Serialising ────────────────────────────────────────────────────────────

  /**
   * Put work on the chain, isolated so it cannot poison what follows.
   *
   * Everything that must not overlap goes through here — turns and the wake-up
   * cycle alike. The returned promise never rejects: a failure is logged and
   * the next piece of work still runs, because one bad turn must not silence
   * the agent for the rest of the session.
   */
  private append(work: () => Promise<void>): Promise<void> {
    const next = this.tail.then(async () => {
      try {
        await work();
      } catch (error) {
        this.logSafely('MultiRoomHost: queued work failed', error);
      }
    });
    this.tail = next;
    return next;
  }

  /**
   * Log without letting the logger take the host down.
   *
   * This is the only statement inside the chain that is not already guarded, so
   * a logger that throws would reject the tail and every `.then` after it would
   * short-circuit — the host silent for good, and `stop` rejecting.
   */
  private logSafely(message: string, error: unknown): void {
    try {
      this.deps.log.error(message, {
        error: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // Nothing useful left to do; losing the line is better than the process.
    }
  }

  private run(turn: Turn): Promise<void> {
    return this.append(async () => {
      // Re-checked here, not only where the turn was accepted. A turn waits
      // behind whatever is running, and the room can be claimed by a session
      // during that wait — replying into a room the agent has lost is not
      // something it can be owed, unlike finishing a turn accepted before a
      // stop.
      if (turn.roomId !== undefined && !this.roomSet.includes(turn.roomId)) {
        this.deps.log.warn('MultiRoomHost: dropped a queued turn for a room we no longer hold', {
          roomId: turn.roomId,
        });
        return;
      }

      // No `running` check. Whether to accept work is decided when it arrives —
      // `deliver` refuses after stop, and `stop` disarms the timer — so
      // anything reaching this point was accepted while running and is owed
      // completion.
      const gap = this.pendingGap;
      if (gap !== null) this.pendingGap = null;
      try {
        await this.deps.onTurn(gap !== null ? { ...turn, gap } : turn);
      } catch (error) {
        // Put the gap back. It says the agent is missing events, and losing it
        // because the turn that would have carried it failed leaves the agent
        // answering from a stale picture with nothing saying so — and a failing
        // turn and a gap have the same causes, so they arrive together.
        // Unconditional: it beats a gap that arrived during the failure,
        // being the earlier of the two.
        if (gap !== null) this.pendingGap = gap;
        this.logSafely('MultiRoomHost: a turn failed', error);
      }
    });
  }

  // ── Waking up ──────────────────────────────────────────────────────────────

  private disarm(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  private arm(): void {
    this.disarm();
    if (!this.running) return;
    const delay = nextDelayMs(this.wakeups, this.deps.clock.now());
    if (delay === null) return;
    // On the chain, not beside it: `fire` awaits a write before queueing its
    // turns, and off-chain that window is one `stop` can return through.
    this.cancelTimer = this.deps.clock.setTimer(delay, () => {
      void this.append(() => this.fire());
    });
  }

  private async fire(): Promise<void> {
    const now = this.deps.clock.now();
    const ready = due(this.wakeups, now);

    // The schedule moves on whether or not each wake-up ends up running: a
    // recurrence aimed at a room we have lost is still due again next week.
    if (ready.length > 0) {
      this.wakeups = reschedule(this.wakeups, ready, now);
      await this.persist();
    }
    this.arm();

    for (const wakeup of ready) {
      if (wakeup.roomId !== undefined && !this.roomSet.includes(wakeup.roomId)) {
        // Posting where the agent has no seat either fails somewhere nobody
        // reads or lands in a room it was evicted from. Neither is better than
        // skipping this occurrence and saying so.
        this.deps.log.warn('MultiRoomHost: skipped a wake-up for a room we no longer hold', {
          id: wakeup.id,
          roomId: wakeup.roomId,
        });
        continue;
      }
      void this.run({ kind: 'wakeup', wakeup, roomId: wakeup.roomId });
    }
  }

  private persist(): Promise<void> {
    // Snapshotted here and written in turn, so the text reflects the schedule
    // as it was when the change happened and the writes land in that order.
    const text = serialiseWakeups(this.wakeups);
    const next = this.persistTail.then(async () => {
      try {
        await this.deps.saveSchedule(text);
      } catch (error) {
        // Loud, and not fatal. The schedule is still correct in memory; what is
        // lost is its survival of a restart, and stopping the agent over that
        // would trade a degraded feature for no agent at all.
        this.logSafely('MultiRoomHost: could not persist the schedule', error);
      }
    });
    this.persistTail = next;
    return next;
  }
}

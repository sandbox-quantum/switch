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
    await this.tail;
  }

  /** What the event stream calls. */
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
    this.roomSet = [...rooms];
  }

  noteGap(reason: string): void {
    this.pendingGap = reason;
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
   * Queue one turn behind whatever is running.
   *
   * The returned promise resolves when *this* turn is done, so a caller can
   * await its own work — but the chain is what enforces the ordering, and it
   * never rejects: a turn that throws is logged and the next one still runs.
   * One bad turn must not silence the agent for the rest of the session.
   */
  private run(turn: Turn): Promise<void> {
    const next = this.tail.then(async () => {
      // No `running` check here. Whether to accept work is decided when it
      // arrives — `deliver` refuses after stop, and `stop` disarms the timer —
      // so anything that reaches this point was accepted while running and is
      // owed completion. Checking here instead discards a turn that had been
      // accepted but had not yet had a chance to start.
      const gap = this.pendingGap;
      if (gap !== null) this.pendingGap = null;
      try {
        await this.deps.onTurn(gap !== null ? { ...turn, gap } : turn);
      } catch (error) {
        this.deps.log.error('MultiRoomHost: a turn failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    this.tail = next;
    return next;
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
    this.cancelTimer = this.deps.clock.setTimer(delay, () => {
      void this.fire();
    });
  }

  private async fire(): Promise<void> {
    const now = this.deps.clock.now();
    const ready = due(this.wakeups, now);

    // The schedule moves on whether or not each wake-up ends up running: a
    // recurrence aimed at a room we have lost is still due again next week.
    this.wakeups = reschedule(this.wakeups, ready, now);
    await this.persist();
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

  private async persist(): Promise<void> {
    try {
      await this.deps.saveSchedule(serialiseWakeups(this.wakeups));
    } catch (error) {
      // Loud, and not fatal. The schedule is still correct in memory; what is
      // lost is its survival of a restart, and stopping the agent over that
      // would trade a degraded feature for no agent at all.
      this.deps.log.error('MultiRoomHost: could not persist the schedule', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

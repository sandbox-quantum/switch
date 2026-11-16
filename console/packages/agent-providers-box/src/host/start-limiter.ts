import { setTimeout as delay } from 'node:timers/promises';

/**
 * How many sessions may be starting at once in this process. Each start runs a
 * session host and its provider CLI, which take most of a CPU for a second or
 * two. On a machine with few CPUs, a dozen starting together all crawl, and
 * the first reply comes no sooner than the last (in a load test, 20 at once
 * on 2 CPUs, a median of 38 s). Letting a few start at a time answers the
 * first rooms in seconds and the last no later than before.
 *
 * Unlimited unless `SWITCH_SESSION_START_CONCURRENCY` is a positive whole
 * number, so a machine nobody configured behaves as it always has.
 */
export function startConcurrencyFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SWITCH_SESSION_START_CONCURRENCY?.trim();
  if (!raw || !/^\d+$/.test(raw)) return Number.POSITIVE_INFINITY;
  const value = Number(raw);
  return value >= 1 ? value : Number.POSITIVE_INFINITY;
}

/** A counting semaphore: at most `capacity` runs at once, the rest in arrival order. */
export class StartLimiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(readonly capacity: number) {
    if (!(capacity >= 1)) throw new Error('A start limiter needs a capacity of at least 1.');
  }

  /** Runs now, or once a slot is free; the slot is given back however `run` ends. */
  async run<T>(run: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await run();
    } finally {
      this.release();
    }
  }

  /** How many runs hold a slot, and how many wait for one. */
  get load(): { active: number; waiting: number } {
    return { active: this.active, waiting: this.waiting.length };
  }

  private acquire(): Promise<void> {
    if (this.active < this.capacity) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    // The slot passes straight to the next in line, so `active` stays put.
    if (next) next();
    else this.active--;
  }
}

/** The one limiter every agent host in this process shares: a controller runs them all. */
export const sessionStarts = new StartLimiter(startConcurrencyFromEnv());

/** How long a start holds its slot at most, waiting for its session host to answer. */
export const START_SETTLE_MS = 30_000;

/**
 * Resolves once `ready()` is true or `ms` has passed, whichever is first. A
 * start is "done" for the limiter when its session host has connected, not
 * when the process was spawned, since connecting is the expensive part.
 */
export async function untilReady(
  ready: () => boolean,
  ms = START_SETTLE_MS,
  step = 100
): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (ready()) return true;
    if (Date.now() >= deadline) return false;
    await delay(Math.min(step, Math.max(1, deadline - Date.now())));
  }
}

/**
 * The barrier between the heartbeat and the socket it is beating for.
 *
 * Every attach makes a new incarnation of the connection server-side — the
 * first one and every reopen alike — and a beat naming an older incarnation is
 * refused as a takeover, which is terminal. A client must therefore never send
 * a beat carrying an incarnation its own reopen has already superseded, and
 * never act on a refusal that its own reopen provoked.
 *
 * Two things are needed for that, and a plain flag is only the first:
 *
 * - No beat is admitted between an open and the frame that names it.
 * - A beat already in flight when the open begins does not have its answer
 *   believed, because that answer was decided against the incarnation before
 *   the open.
 *
 * The second is what `tick` and the settle wait in `detaching` are for. The
 * wait is bounded: a reopen is what restores delivery, and holding it behind a
 * request that may never answer trades a stopped client for a deaf one. Inside
 * the bound an answer is still believed, so a real takeover arriving while the
 * socket happens to be reopening is not lost; past it the answer is discarded
 * as undecidable, which is what it is.
 */

/** A beat's answer, and whether it still describes the incarnation we are on. */
export interface Tick<T> {
  value: T;
  /** False when a reattach began while this beat was in flight. */
  current: boolean;
}

export class ReattachFence {
  private live = false;
  private open: () => void = () => {};
  private gate: Promise<void> = new Promise((resolve) => {
    this.open = resolve;
  });
  private era = 0;
  private inFlight: Promise<void> | null = null;

  /** Resolves once the stream is attached; already resolved while it is. */
  get reached(): Promise<void> {
    return this.gate;
  }

  /** The server has said which incarnation this socket is. */
  attached(): void {
    this.live = true;
    this.open();
  }

  /** Stop admitting beats. For a stream that is stopping rather than reopening. */
  closeAdmission(): void {
    if (!this.live) return;
    this.live = false;
    this.gate = new Promise((resolve) => {
      this.open = resolve;
    });
  }

  /**
   * A socket is about to be opened, which will make a new incarnation.
   *
   * Closes the gate first, so nothing new goes out, then gives a beat already
   * in flight `settleWithinMs` to come back and be believed. Whatever is still
   * outstanding after that is disowned rather than waited for.
   */
  async detaching(settleWithinMs: number): Promise<void> {
    this.closeAdmission();
    const settling = this.inFlight;
    if (settling) await within(settling, settleWithinMs);
    this.era += 1;
  }

  /**
   * Send one beat and report whether its answer still applies.
   *
   * The caller must have passed `reached` immediately before calling this,
   * with no await in between: that is what makes the recorded era the one the
   * beat is actually sent under.
   */
  async tick<T>(send: () => Promise<T>): Promise<Tick<T>> {
    const era = this.era;
    let settled: () => void = () => {};
    const flight = new Promise<void>((resolve) => {
      settled = resolve;
    });
    this.inFlight = flight;
    try {
      const value = await send();
      return { value, current: era === this.era };
    } finally {
      if (this.inFlight === flight) this.inFlight = null;
      settled();
    }
  }
}

/** Wait for `work`, but not longer than `ms`. Rejections are the caller's. */
async function within(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

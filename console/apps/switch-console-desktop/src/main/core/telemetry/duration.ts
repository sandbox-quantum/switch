import type { TelemetryDurationMs } from './events';

/**
 * Start timing an operation that reports how long it took.
 *
 * `performance.now()` rather than `Date.now()`: it is monotonic, so an NTP step
 * or a machine waking mid-install cannot yield a negative duration or an hour
 * that never passed. `Date.now()` can do both, and a negative number reaching a
 * payload is worse than no number — it is data nobody can tell from real data.
 * Because the clock only moves forwards, the result needs no clamping.
 *
 * Whole milliseconds. Sub-millisecond precision says nothing about an operation
 * that shells out to a package manager, and it keeps the value a plain integer
 * at the far end. See `TelemetryDurationMs` for what bounds the value and how to
 * read the result.
 *
 * Call it before the work and call the returned function at the point the
 * outcome is known — not after the event is built, and not around the send,
 * which is fire-and-forget and has nothing to do with what the user waited for.
 */
export function startTimer(): () => TelemetryDurationMs {
  const start = performance.now();
  return () => Math.round(performance.now() - start);
}

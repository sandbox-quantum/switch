import { describe, expect, it } from 'vitest';
import {
  advance,
  due,
  MAX_TIMER_MS,
  nextDelayMs,
  parseWakeups,
  reschedule,
  serialiseWakeups,
  type Wakeup,
} from './schedule';

/**
 * When an agent acts without being spoken to.
 *
 * Everything else in Switch is a response: an event arrives and the agent
 * answers. A weekly digest, a nudge about something overdue, a brief the
 * evening before a review — none of those are answers, and nothing exists to
 * wake an agent up for them.
 *
 * Deliberately client-side. A wake-up delivered when no client is connected has
 * nobody to wake, so server-side durability buys nothing the long-lived host
 * does not already need: the schedule lives in the agent's own room document
 * alongside the rest of its working state, and is re-armed on restart.
 *
 * The two things that make this more than `setTimeout`:
 *
 * - **A missed recurrence fires once, not once per period missed.** An agent
 *   off for a month owes one digest, not four, and an agent that catches up by
 *   posting four is worse than one that posted none.
 * - **A timer cannot be armed for an arbitrary delay.** Node stores it in a
 *   32-bit int, and anything above ~24.8 days fires *immediately* rather than
 *   late — so a monthly wake-up naively armed goes off at once, every time,
 *   forever.
 */

const NOW = Date.UTC(2027, 0, 6, 9, 0, 0); // a Wednesday, 09:00
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

function wakeup(overrides: Partial<Wakeup> = {}): Wakeup {
  return { id: 'w1', atMs: NOW, note: 'post the digest', ...overrides };
}

// ── What is due ──────────────────────────────────────────────────────────────

describe('due', () => {
  it('returns a wake-up whose moment has arrived', () => {
    expect(due([wakeup({ atMs: NOW })], NOW)).toHaveLength(1);
  });

  it('does not return one still in the future', () => {
    expect(due([wakeup({ atMs: NOW + MINUTE })], NOW)).toEqual([]);
  });

  it('returns an overdue one rather than skipping it', () => {
    /** The agent was off. The work still needs doing. */
    expect(due([wakeup({ atMs: NOW - WEEK })], NOW)).toHaveLength(1);
  });

  it('returns several in the order they came due', () => {
    const list = [
      wakeup({ id: 'later', atMs: NOW - MINUTE }),
      wakeup({ id: 'earlier', atMs: NOW - HOUR }),
    ];

    expect(due(list, NOW).map((w) => w.id)).toEqual(['earlier', 'later']);
  });
});

// ── What happens after one fires ─────────────────────────────────────────────

describe('advance', () => {
  it('retires a one-shot wake-up', () => {
    expect(advance(wakeup({ atMs: NOW }), NOW)).toBeNull();
  });

  it('moves a recurring one to its next turn', () => {
    const next = advance(wakeup({ atMs: NOW, everyMs: WEEK }), NOW);

    expect(next?.atMs).toBe(NOW + WEEK);
  });

  it('fires a long-missed recurrence once, not once per period missed', () => {
    /**
     * The whole reason this is not `atMs += everyMs`. An agent off for a month
     * owes one weekly digest, and an agent that catches up by posting four is
     * worse than one that posted none.
     */
    const missedForAMonth = wakeup({ atMs: NOW - 4 * WEEK, everyMs: WEEK });

    const next = advance(missedForAMonth, NOW);

    expect(next).not.toBeNull();
    expect(next!.atMs).toBeGreaterThan(NOW);
    expect(next!.atMs).toBeLessThanOrEqual(NOW + WEEK);
  });

  it('keeps a recurrence on its original cadence rather than drifting', () => {
    /**
     * Firing late must not move the schedule. A digest due Wednesday 09:00 that
     * ran at 09:04 is still due the following Wednesday at 09:00 — otherwise
     * every late run walks the slot forward until it lands at an odd hour.
     */
    const late = NOW + 4 * MINUTE;

    const next = advance(wakeup({ atMs: NOW, everyMs: WEEK }), late);

    expect(next?.atMs).toBe(NOW + WEEK);
  });

  it('treats an interval too small to move the moment as one-shot', () => {
    /**
     * Zero and negative are the obvious cases, and not the dangerous ones.
     * Below roughly 2.4e-4 ms the increment is smaller than the gap between
     * representable epoch values, so the next moment lands on `nowMs` itself —
     * `due` fires it, `advance` returns the same moment, and it spins. Only
     * reachable from a hand-edited document, which is precisely the input
     * `parseWakeups` exists to survive.
     */
    expect(advance(wakeup({ atMs: NOW, everyMs: 0 }), NOW)).toBeNull();
    expect(advance(wakeup({ atMs: NOW, everyMs: -WEEK }), NOW)).toBeNull();
    expect(advance(wakeup({ atMs: NOW - WEEK, everyMs: 1e-4 }), NOW)).toBeNull();
    expect(advance(wakeup({ atMs: NOW - WEEK, everyMs: 5e-324 }), NOW)).toBeNull();
  });

  it('never returns a moment that is not strictly ahead', () => {
    /** The invariant the caller depends on: whatever comes back, `due` must not
     * immediately fire it again. */
    for (const everyMs of [1, 1000, WEEK, Number.MAX_VALUE]) {
      const next = advance(wakeup({ atMs: NOW - 4 * WEEK, everyMs }), NOW);
      if (next !== null) expect(next.atMs).toBeGreaterThan(NOW);
    }
  });
});

describe('reschedule', () => {
  it('drops the one-shots that fired and keeps everything else', () => {
    const list = [wakeup({ id: 'fired' }), wakeup({ id: 'pending', atMs: NOW + DAY })];

    const remaining = reschedule(list, [list[0]], NOW);

    expect(remaining.map((w) => w.id)).toEqual(['pending']);
  });

  it('puts a recurring one back with its next moment', () => {
    const weekly = wakeup({ id: 'weekly', everyMs: WEEK });

    const [next] = reschedule([weekly], [weekly], NOW);

    expect(next.id).toBe('weekly');
    expect(next.atMs).toBe(NOW + WEEK);
  });

  it('leaves a wake-up that did not fire exactly as it was', () => {
    const pending = wakeup({ id: 'pending', atMs: NOW + DAY });

    expect(reschedule([pending], [], NOW)).toEqual([pending]);
  });
});

// ── Arming the timer ─────────────────────────────────────────────────────────

describe('nextDelayMs', () => {
  it('is null when there is nothing to wait for', () => {
    expect(nextDelayMs([], NOW)).toBeNull();
  });

  it('is the gap to the soonest wake-up', () => {
    const list = [wakeup({ id: 'a', atMs: NOW + HOUR }), wakeup({ id: 'b', atMs: NOW + MINUTE })];

    expect(nextDelayMs(list, NOW)).toBe(MINUTE);
  });

  it('is zero rather than negative for something already due', () => {
    /** A negative delay is a `setTimeout` that fires immediately anyway, but it
     * also reads as a bug in every log line that prints it. */
    expect(nextDelayMs([wakeup({ atMs: NOW - WEEK })], NOW)).toBe(0);
  });

  it('never exceeds what a timer can actually hold', () => {
    /**
     * Node stores the delay in a 32-bit int. Above ~24.8 days it overflows and
     * the timer fires *immediately* — so a monthly wake-up armed naively goes
     * off at once, reschedules, and goes off at once again, forever.
     */
    const inTwoMonths = NOW + 60 * DAY;

    const delay = nextDelayMs([wakeup({ atMs: inTwoMonths })], NOW);

    expect(delay).toBe(MAX_TIMER_MS);
    expect(MAX_TIMER_MS).toBeLessThanOrEqual(2 ** 31 - 1);
  });
});

// ── Surviving a restart ──────────────────────────────────────────────────────

describe('persistence', () => {
  it('round-trips through the document it is stored in', () => {
    const list = [
      wakeup({ id: 'weekly', everyMs: WEEK, roomId: '!room:switch.local' }),
      wakeup({ id: 'once', atMs: NOW + DAY, note: 'brief before the review' }),
    ];

    expect(parseWakeups(serialiseWakeups(list))).toEqual(list);
  });

  it('reads a hand-edited document without taking the agent down', () => {
    /**
     * The schedule lives in a room document, which is a thing a human can open
     * and edit. A stray character there must cost the schedule, loudly — not
     * the agent's ability to start.
     */
    expect(parseWakeups('{ not json at all')).toEqual([]);
    expect(parseWakeups('')).toEqual([]);
    expect(parseWakeups('null')).toEqual([]);
    expect(parseWakeups('"a string"')).toEqual([]);
  });

  it('drops an entry that is missing what a wake-up needs', () => {
    /** Half an entry is worse than none: a wake-up with no moment either never
     * fires or fires constantly, and neither says why. */
    const mixed = JSON.stringify([
      { id: 'good', atMs: NOW, note: 'fine' },
      { id: 'no-time', note: 'when?' },
      { atMs: NOW, note: 'who?' },
      'not an object',
      null,
    ]);

    expect(parseWakeups(mixed).map((w) => w.id)).toEqual(['good']);
  });

  it('drops an entry whose moment is not a real number', () => {
    /** JSON has no literal for Infinity or NaN — `JSON.stringify` writes `null`
     * — so these arrive as a string and a null. Both are caught, but note that
     * means a non-finite number can never actually reach `parseWakeups`. */
    const bad = JSON.stringify([
      { id: 'nan', atMs: 'soon', note: 'x' },
      { id: 'inf', atMs: Number.POSITIVE_INFINITY, note: 'x' },
    ]);

    expect(parseWakeups(bad)).toEqual([]);
  });

  it('drops a recurrence too small for a timer to honour', () => {
    /** The document is hand-editable, so this is where a spinning wake-up would
     * come from. Refused at the door rather than relied on `advance` to catch. */
    const parsed = parseWakeups(
      JSON.stringify([{ id: 'w1', atMs: NOW, note: 'x', everyMs: 1e-4 }])
    );

    expect(parsed[0].everyMs).toBeUndefined();
  });

  it('survives a schedule far larger than a timer call can spread', () => {
    /** `Math.min(...xs)` throws above ~100k arguments, and the throw would
     * escape into the arming loop and stop the agent waking at all. */
    const many = Array.from({ length: 200_000 }, (_, i) => wakeup({ id: `w${i}`, atMs: NOW + i }));

    expect(nextDelayMs(many, NOW)).toBe(0);
  });

  it('keeps the newest entry when a document names one id twice', () => {
    /** Two wake-ups with one id cannot both be cancelled, and whichever the
     * agent meant, it meant one of them. */
    const duplicated = JSON.stringify([
      { id: 'w1', atMs: NOW, note: 'old' },
      { id: 'w1', atMs: NOW + DAY, note: 'new' },
    ]);

    const parsed = parseWakeups(duplicated);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].note).toBe('new');
  });
});

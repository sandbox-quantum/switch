import { aDurationMs } from '@tooling/utils/telemetry-duration';
import { describe, expect, it, vi } from 'vitest';
import { startTimer } from './duration';

const SLEEP_MS = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('timing an operation', () => {
  it('reports whole milliseconds, never a fraction', async () => {
    // The emitter refuses a non-finite number and the far end averages what it
    // gets, so the contract worth pinning is that this is a plain integer.
    const elapsed = startTimer();
    await sleep(SLEEP_MS);

    const ms = elapsed();

    expect(Number.isInteger(ms)).toBe(true);
    expect(ms).toBeGreaterThan(0);
  });

  it('accumulates across reads rather than restarting at each one', async () => {
    // Asserting only that the second read is >= the first would pass against a
    // timer that resets on every read: both reads would return one sleep's
    // worth. The second read has to cover BOTH sleeps for that bug to show.
    const elapsed = startTimer();
    await sleep(SLEEP_MS);
    const first = elapsed();
    await sleep(SLEEP_MS);

    expect(first).toBeGreaterThanOrEqual(SLEEP_MS - 5);
    expect(elapsed()).toBeGreaterThanOrEqual(first + SLEEP_MS - 5);
  });

  it('is the span, not the time of day', ({ onTestFinished }) => {
    // The one property every assertion elsewhere is blind to. `aDurationMs`
    // accepts any non-negative integer, so `Math.round(performance.now())` —
    // milliseconds since the process started, which is a large number that only
    // grows — satisfies every other test in this file and every call-site
    // assertion in the suite. Only a clock held still says what is subtracted
    // from what.
    const now = vi.spyOn(performance, 'now');
    onTestFinished(() => now.mockRestore());

    now.mockReturnValue(1_000_000.4);
    const elapsed = startTimer();
    now.mockReturnValue(1_004_200.6);

    expect(elapsed()).toBe(4200);
  });
});

/**
 * The matcher the call-site assertions use, because `expect.any(Number)` is not
 * an assertion about a duration.
 *
 * It is satisfied by `NaN` and by `Infinity` — both of which the emitter throws
 * on, so an event carrying one is dropped with a log line and never arrives.
 * Written that way, every duration assertion in the suite would pass against a
 * payload that cannot be sent.
 */
describe('the duration matcher', () => {
  it.each([0, 1, 4200])('accepts a whole number of milliseconds: %s', (value) => {
    expect({ duration_ms: value }).toEqual({ duration_ms: aDurationMs });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 12.5, '12', null])(
    'rejects what a timer cannot produce: %s',
    (value) => {
      expect({ duration_ms: value }).not.toEqual({ duration_ms: aDurationMs });
    }
  );

  it('rejects the values expect.any(Number) would have let through', () => {
    // The specific regression: these two pass `expect.any(Number)`.
    expect(aDurationMs.asymmetricMatch(Number.NaN)).toBe(false);
    expect(aDurationMs.asymmetricMatch(Number.POSITIVE_INFINITY)).toBe(false);
    expect(expect.any(Number).asymmetricMatch(Number.NaN)).toBe(true);
  });

  it('is what a real timer produces', async () => {
    const elapsed = startTimer();
    await sleep(1);

    expect({ duration_ms: elapsed() }).toEqual({ duration_ms: aDurationMs });
  });

  it('accepts a zero-length operation', ({ onTestFinished }) => {
    // A fast operation legitimately rounds to 0, so the matcher must not
    // require a positive number.
    //
    // Restored through the hook rather than after the assertion: a failing
    // expectation throws, and a frozen clock left behind would be inherited by
    // whatever ran next in this file.
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    onTestFinished(() => now.mockRestore());

    const elapsed = startTimer();

    // Both halves: that the timer really produces 0 for a span of no time, and
    // that the matcher takes it. Asserting only the second would pass against a
    // timer that returned the clock reading instead of the span.
    expect(elapsed()).toBe(0);
    expect({ duration_ms: elapsed() }).toEqual({ duration_ms: aDurationMs });
  });
});

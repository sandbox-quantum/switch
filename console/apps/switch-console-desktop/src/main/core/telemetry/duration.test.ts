import { describe, expect, it } from 'vitest';
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
});

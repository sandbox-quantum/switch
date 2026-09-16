import { describe, expect, it } from 'vitest';
import { startTimer } from './duration';

describe('timing an operation', () => {
  it('reports whole milliseconds, never a fraction', async () => {
    // The emitter refuses a non-finite number and the far end averages what it
    // gets, so the contract worth pinning is that this is a plain integer.
    const elapsed = startTimer();
    await new Promise((resolve) => setTimeout(resolve, 5));

    const ms = elapsed();

    expect(Number.isInteger(ms)).toBe(true);
    expect(ms).toBeGreaterThan(0);
  });

  it('reports zero rather than a negative for an operation too fast to measure', async () => {
    // A negative duration in a payload is indistinguishable from real data at
    // the far end, which is worse than no data.
    expect(startTimer()()).toBeGreaterThanOrEqual(0);
  });

  it('can be read more than once, and does not restart', async () => {
    const elapsed = startTimer();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const first = elapsed();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(elapsed()).toBeGreaterThanOrEqual(first);
  });
});

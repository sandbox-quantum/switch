import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { StartLimiter, startConcurrencyFromEnv, untilReady } from './start-limiter';

describe('session start limiter', () => {
  it('lets at most `capacity` run at once, the rest in arrival order', async () => {
    const limiter = new StartLimiter(2);
    let running = 0;
    let most = 0;
    const order: number[] = [];
    const job = (n: number) =>
      limiter.run(async () => {
        running++;
        most = Math.max(most, running);
        order.push(n);
        await delay(20);
        running--;
      });
    await Promise.all([1, 2, 3, 4, 5].map(job));
    expect(most).toBe(2);
    expect(order).toEqual([1, 2, 3, 4, 5]);
    expect(limiter.load).toEqual({ active: 0, waiting: 0 });
  });

  it('gives the slot back when a run fails', async () => {
    const limiter = new StartLimiter(1);
    await expect(
      limiter.run(async () => Promise.reject(new Error('start failed')))
    ).rejects.toThrow('start failed');
    await expect(limiter.run(async () => 'next')).resolves.toBe('next');
    expect(limiter.load).toEqual({ active: 0, waiting: 0 });
  });

  it('is unlimited unless the setting is a positive whole number', () => {
    expect(startConcurrencyFromEnv({})).toBe(Number.POSITIVE_INFINITY);
    expect(startConcurrencyFromEnv({ SWITCH_SESSION_START_CONCURRENCY: '2' })).toBe(2);
    for (const bad of ['0', '-1', 'two', '1.5', ''])
      expect(startConcurrencyFromEnv({ SWITCH_SESSION_START_CONCURRENCY: bad })).toBe(
        Number.POSITIVE_INFINITY
      );
  });

  it('waits for the session host to be ready, or gives up at the limit', async () => {
    let ready = false;
    setTimeout(() => (ready = true), 30);
    await expect(untilReady(() => ready, 1000, 5)).resolves.toBe(true);
    await expect(untilReady(() => false, 30, 5)).resolves.toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recheckDocker } from './docker-recheck';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('recheckDocker', () => {
  it('asks again a while after each check finishes', async () => {
    const check = vi.fn(() => Promise.resolve());
    const stop = recheckDocker(check, new EventTarget(), 3000);

    await vi.advanceTimersByTimeAsync(2999);
    expect(check).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(check).toHaveBeenCalledTimes(2);
    stop();
  });

  it('waits for a slow check instead of starting another', async () => {
    let finish: () => void = () => {};
    const check = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const target = new EventTarget();
    const stop = recheckDocker(check, target, 3000);

    await vi.advanceTimersByTimeAsync(3000);
    target.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(check).toHaveBeenCalledTimes(1);

    finish();
    await vi.advanceTimersByTimeAsync(3000);
    expect(check).toHaveBeenCalledTimes(2);
    stop();
  });

  it('checks at once when the window regains focus', async () => {
    const check = vi.fn(() => Promise.resolve());
    const target = new EventTarget();
    const stop = recheckDocker(check, target, 3000);

    target.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalledTimes(1);
    stop();
  });

  it('does nothing more once stopped, even when a check finishes later', async () => {
    let finish: () => void = () => {};
    const check = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const target = new EventTarget();
    const stop = recheckDocker(check, target, 3000);

    await vi.advanceTimersByTimeAsync(3000);
    stop();
    finish();
    target.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(check).toHaveBeenCalledTimes(1);
  });
});

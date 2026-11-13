import { describe, expect, it, vi } from 'vitest';
import { ReattachFence } from './reattach-fence';

/** A promise plus the handles to settle it, so a test can hold a beat open. */
function held<T>() {
  let release: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Whether `p` has settled, without waiting on it. */
async function settled(p: Promise<unknown>): Promise<boolean> {
  const pending = Symbol('pending');
  return (await Promise.race([p, Promise.resolve(pending)])) !== pending;
}

describe('the gate', () => {
  it('is shut until the server names the incarnation', async () => {
    const fence = new ReattachFence();

    expect(await settled(fence.reached)).toBe(false);
    fence.attached();
    expect(await settled(fence.reached)).toBe(true);
  });

  it('shuts again for the next open, rather than staying open for good', async () => {
    const fence = new ReattachFence();
    fence.attached();

    await fence.detaching(0);

    // The bug this replaces: one latch resolved by the first frame of the
    // object's life, so every later reopen beat straight through the window.
    expect(await settled(fence.reached)).toBe(false);
  });

  it('is one gate per open, not one per call', async () => {
    const fence = new ReattachFence();
    fence.attached();
    await fence.detaching(0);
    const waiting = fence.reached;

    await fence.detaching(0);
    fence.attached();

    // A beat that took the gate before the second detach must be released by
    // the attach that eventually comes, not left holding a discarded promise.
    expect(await settled(waiting)).toBe(true);
  });
});

describe('a beat in flight when the open begins', () => {
  it('holds the open until it settles', async () => {
    const fence = new ReattachFence();
    fence.attached();
    const beat = held<string>();
    const tick = fence.tick(() => beat.promise);
    await Promise.resolve();

    const opening = fence.detaching(60_000);
    expect(await settled(opening)).toBe(false);

    beat.release('answered');
    await expect(tick).resolves.toEqual({ value: 'answered', current: true });
    await opening;
  });

  it('is believed when it answers inside the bound', async () => {
    const fence = new ReattachFence();
    fence.attached();
    const beat = held<string>();
    const tick = fence.tick(() => beat.promise);
    await Promise.resolve();

    const opening = fence.detaching(60_000);
    beat.release('taken_over');
    await opening;

    // The window it answered in was still its own, so a real takeover arriving
    // while the socket happens to be reopening is not thrown away.
    expect((await tick).current).toBe(true);
  });

  it('is disowned when it does not', async () => {
    vi.useFakeTimers();
    try {
      const fence = new ReattachFence();
      fence.attached();
      const beat = held<string>();
      const tick = fence.tick(() => beat.promise);
      await Promise.resolve();

      const opening = fence.detaching(1000);
      await vi.advanceTimersByTimeAsync(1000);
      await opening;

      // The open went ahead without it — a reopen is what restores delivery,
      // and a request that may never answer must not hold it up.
      beat.release('taken_over');
      expect((await tick).current).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not hold the open open when there is no beat at all', async () => {
    const fence = new ReattachFence();
    fence.attached();

    await expect(fence.detaching(60_000)).resolves.toBeUndefined();
  });

  it('is disowned by an open that began before it answered, not by a later one', async () => {
    const fence = new ReattachFence();
    fence.attached();
    const beat = held<string>();
    const tick = fence.tick(() => beat.promise);
    await Promise.resolve();
    beat.release('ok');
    await tick;

    // Settled before any detach: the answer described the incarnation it was
    // sent under, and a reattach afterwards cannot retroactively stale it.
    await fence.detaching(0);
    expect((await tick).current).toBe(true);
  });
});

describe('closeAdmission', () => {
  it('shuts the gate without waiting for anything', async () => {
    const fence = new ReattachFence();
    fence.attached();
    const beat = held<string>();
    void fence.tick(() => beat.promise);
    await Promise.resolve();

    fence.closeAdmission();

    expect(await settled(fence.reached)).toBe(false);
    beat.release('ok');
  });
});

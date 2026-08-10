import { describe, expect, it } from 'vitest';
import { AttachQueue, AttachQueueClearedError } from './attach-queue';

/** A promise plus the handles to settle it from the test body. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Queue with no real timers: records each requested delay instead of waiting. */
function makeQueue() {
  const delays: number[] = [];
  const queue = new AttachQueue(250, async (ms) => {
    delays.push(ms);
  });
  return { queue, delays };
}

describe('AttachQueue', () => {
  it('never runs two tasks concurrently', async () => {
    const { queue } = makeQueue();
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];

    const task = (name: string) => async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(`start:${name}`);
      // Yield repeatedly so an unserialised queue would interleave here.
      await Promise.resolve();
      await Promise.resolve();
      order.push(`end:${name}`);
      inFlight -= 1;
    };

    await Promise.all([queue.run(task('a')), queue.run(task('b')), queue.run(task('c'))]);

    expect(maxInFlight).toBe(1);
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
  });

  it('holds a queued task until the one in flight settles', async () => {
    const { queue } = makeQueue();
    const first = deferred();
    let secondStarted = false;

    const firstRun = queue.run(() => first.promise);
    const secondRun = queue.run(async () => {
      secondStarted = true;
    });

    await Promise.resolve();
    expect(secondStarted).toBe(false);

    first.resolve();
    await Promise.all([firstRun, secondRun]);
    expect(secondStarted).toBe(true);
  });

  it('waits between tasks but not before the first', async () => {
    const { queue, delays } = makeQueue();

    await queue.run(async () => 'a');
    expect(delays).toEqual([]);

    const second = queue.run(async () => 'b');
    const third = queue.run(async () => 'c');
    await Promise.all([second, third]);

    // One gap before 'b' and one before 'c' — never before the queue's first task.
    expect(delays).toEqual([250, 250]);
  });

  it('resolves each caller with its own task result', async () => {
    const { queue } = makeQueue();

    const results = await Promise.all([
      queue.run(async () => 'a'),
      queue.run(async () => 'b'),
      queue.run(async () => 'c'),
    ]);

    expect(results).toEqual(['a', 'b', 'c']);
  });

  it('delivers a task rejection to its caller without stalling the queue', async () => {
    const { queue } = makeQueue();

    const failing = queue.run(async () => {
      throw new Error('attach failed');
    });
    const following = queue.run(async () => 'ran anyway');

    await expect(failing).rejects.toThrow('attach failed');
    await expect(following).resolves.toBe('ran anyway');
  });

  it('clear() drops queued tasks without running them', async () => {
    const { queue } = makeQueue();
    const first = deferred();
    let secondStarted = false;

    const firstRun = queue.run(() => first.promise);
    const secondRun = queue.run(async () => {
      secondStarted = true;
    });

    queue.clear();
    first.resolve();
    await firstRun;

    await expect(secondRun).rejects.toBeInstanceOf(AttachQueueClearedError);
    expect(secondStarted).toBe(false);
  });

  it('clear() leaves the in-flight task running', async () => {
    const { queue } = makeQueue();
    const inFlight = deferred<string>();

    const running = queue.run(() => inFlight.promise);
    await Promise.resolve();

    queue.clear();
    inFlight.resolve('completed');

    await expect(running).resolves.toBe('completed');
  });

  it('accepts new work after being cleared', async () => {
    const { queue } = makeQueue();
    const first = deferred();

    const firstRun = queue.run(() => first.promise);
    const dropped = queue.run(async () => 'dropped');
    queue.clear();
    await expect(dropped).rejects.toBeInstanceOf(AttachQueueClearedError);

    first.resolve();
    await firstRun;

    await expect(queue.run(async () => 'fresh')).resolves.toBe('fresh');
  });

  it('reports the number of tasks waiting for a turn', async () => {
    const { queue } = makeQueue();
    const first = deferred();

    const firstRun = queue.run(() => first.promise);
    await Promise.resolve();
    // The in-flight task is not counted.
    expect(queue.depth).toBe(0);

    const second = queue.run(async () => undefined);
    const third = queue.run(async () => undefined);
    expect(queue.depth).toBe(2);

    first.resolve();
    await Promise.all([firstRun, second, third]);
    expect(queue.depth).toBe(0);
  });
});

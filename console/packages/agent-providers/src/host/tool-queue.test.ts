import { describe, expect, it, vi } from 'vitest';
import { ToolCallQueue } from './tool-queue';

describe('ToolCallQueue', () => {
  it('executes tasks in sequential FIFO order (concurrency = 1)', async () => {
    const queue = new ToolCallQueue({ maxWaitingDepth: 10 });
    const sequence: number[] = [];

    const task1 = queue.enqueue(1, async () => {
      await new Promise((r) => setTimeout(r, 50));
      sequence.push(1);
      return 'one';
    });

    const task2 = queue.enqueue(2, async () => {
      sequence.push(2);
      return 'two';
    });

    const task3 = queue.enqueue(3, async () => {
      sequence.push(3);
      return 'three';
    });

    const results = await Promise.all([task1, task2, task3]);
    expect(results).toEqual(['one', 'two', 'three']);
    expect(sequence).toEqual([1, 2, 3]);
  });

  it('rejects immediately when queue capacity (maxWaitingDepth) is reached', async () => {
    // maxWaitingDepth = 2 means 1 running task + 2 waiting tasks. 4th task should be rejected.
    const queue = new ToolCallQueue({ maxWaitingDepth: 2 });

    const task1 = queue.enqueue(1, () => new Promise((r) => setTimeout(r, 100)));
    const task2 = queue.enqueue(2, () => new Promise((r) => setTimeout(r, 100)));
    const task3 = queue.enqueue(3, () => new Promise((r) => setTimeout(r, 100)));

    expect(queue.isBusy).toBe(true);
    expect(queue.waitingCount).toBe(2);

    await expect(queue.enqueue(4, async () => 'overflow')).rejects.toThrow(
      'Server queue full; tool call rejected'
    );

    await Promise.all([task1, task2, task3]);
  });

  it('drops queued tasks after queue wait timeout expires', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const queue = new ToolCallQueue({ queueWaitTimeoutMs: 1000 });

    // Task 1 runs for 2000ms
    const task1 = queue.enqueue(1, () => new Promise((r) => setTimeout(r, 2000)));

    // Task 2 waits in queue, with a 1000ms queue wait timeout
    const task2 = queue.enqueue(2, async () => 'task2');
    const task2Expectation = expect(task2).rejects.toThrow(
      'Tool call 2 timed out waiting in queue'
    );

    await vi.advanceTimersByTimeAsync(1100);
    await task2Expectation;

    await vi.advanceTimersByTimeAsync(1000);
    await task1;
    vi.useRealTimers();
  });

  it('handles tool execution timeout, issues cancel, and settles within grace period', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let cancelIssuedFor: string | number | null = null;

    const queue = new ToolCallQueue({
      executionTimeoutMs: 1000,
      cancelGraceMs: 500,
      onCancelRequested: async (id) => {
        cancelIssuedFor = id;
      },
    });

    let settleWork: ((value: string) => void) | null = null;
    const task1 = queue.enqueue(
      1,
      () =>
        new Promise<string>((resolve) => {
          settleWork = resolve;
        })
    );

    // Advance to trigger execution timeout
    await vi.advanceTimersByTimeAsync(1050);
    expect(cancelIssuedFor).toBe(1);
    expect(queue.activeTaskState).toBe('CANCEL_REQUESTED');

    // Settle within 500ms grace window
    settleWork!('late-settled-result');
    await vi.advanceTimersByTimeAsync(10);

    const result = await task1;
    expect(result).toBe('late-settled-result');
    expect(queue.isBusy).toBe(false);
    vi.useRealTimers();
  });

  it('transitions to QUARANTINED, rejects caller with AMBIGUOUS_OUTCOME, and terminates process when grace expires', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let quarantineFired = false;

    const queue = new ToolCallQueue({
      executionTimeoutMs: 1000,
      cancelGraceMs: 500,
      onCancelRequested: async () => {},
      onQuarantineProcess: async () => {
        quarantineFired = true;
      },
    });

    const task1 = queue.enqueue(
      1,
      () => new Promise<string>(() => {}) // Hangs indefinitely
    );

    const task2 = queue.enqueue(2, async () => 'queued-task');

    // Attach rejection handlers before advancing timers to prevent unhandled rejection events
    const task1Expectation = expect(task1).rejects.toThrow('TOOL_TIMEOUT_AMBIGUOUS_OUTCOME');
    const task2Expectation = expect(task2).rejects.toThrow('Process quarantined due to unsettled tool timeout');

    // Advance past execution timeout (1000ms) and grace period (500ms)
    await vi.advanceTimersByTimeAsync(1600);

    await task1Expectation;
    await task2Expectation;

    expect(quarantineFired).toBe(true);

    // Queue is permanently closed; new calls rejected
    await expect(queue.enqueue(3, async () => 'new')).rejects.toThrow(
      'Queue closed; transport shutting down'
    );
    vi.useRealTimers();
  });

  it('terminates active and queued work immediately upon terminateAll()', async () => {
    let cleanupTriggered = false;
    const queue = new ToolCallQueue({
      onQuarantineProcess: async () => {
        cleanupTriggered = true;
      },
    });

    const task1 = queue.enqueue(1, () => new Promise<string>(() => {}));
    const task2 = queue.enqueue(2, async () => 'two');

    const task1Expectation = expect(task1).rejects.toThrow('Session grant revoked');
    const task2Expectation = expect(task2).rejects.toThrow('Session grant revoked');

    await queue.terminateAll(new Error('Session grant revoked'));

    await task1Expectation;
    await task2Expectation;
    expect(cleanupTriggered).toBe(true);
    expect(queue.isBusy).toBe(false);
  });
});

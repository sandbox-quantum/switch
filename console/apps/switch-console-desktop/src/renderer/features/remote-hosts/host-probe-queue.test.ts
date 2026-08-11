import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queueHostProbe, resetHostProbeQueue } from './host-probe-queue';

/**
 * The setup runner takes one operation per host and refuses the rest (CHOO-1809).
 *
 * Reported as a flood of `Another setup operation is already running for
 * bench-vm` for steps the user never touched. The cause was overlap, not the
 * host: the readiness gate probed the steps it found stale, and each completed
 * step pushed a new plan, which shortened the stale list, which re-rendered the
 * caller, which asked again while the first pass was still going.
 */
beforeEach(() => resetHostProbeQueue());

/** A task that reports whether it ever ran while another was in flight. */
function overlapDetector() {
  const state = { running: 0, maxConcurrent: 0, order: [] as string[] };
  const task =
    (label: string, ms = 0) =>
    async () => {
      state.running += 1;
      state.maxConcurrent = Math.max(state.maxConcurrent, state.running);
      state.order.push(label);
      await new Promise((resolve) => setTimeout(resolve, ms));
      state.running -= 1;
      return label;
    };
  return { state, task };
}

describe('queueHostProbe', () => {
  it('never runs two probes for a host at once', async () => {
    const { state, task } = overlapDetector();

    await Promise.all([
      queueHostProbe('bench-vm', task('a', 5)),
      queueHostProbe('bench-vm', task('b', 5)),
      queueHostProbe('bench-vm', task('c', 5)),
    ]);

    expect(state.maxConcurrent).toBe(1);
  });

  it('runs them in the order they were asked for', async () => {
    const { state, task } = overlapDetector();

    await Promise.all([
      queueHostProbe('bench-vm', task('a', 5)),
      queueHostProbe('bench-vm', task('b', 1)),
    ]);

    expect(state.order).toEqual(['a', 'b']);
  });

  it('does not make one host wait for another', async () => {
    // Hosts are independent; the runner's lock is per host. Serialising across
    // hosts would make a slow VM hold up every other machine.
    const { state, task } = overlapDetector();

    await Promise.all([
      queueHostProbe('bench-vm', task('a', 5)),
      queueHostProbe('dev-vm', task('b', 5)),
    ]);

    expect(state.maxConcurrent).toBe(2);
  });

  it('runs the next probe even after one fails', async () => {
    // A failed probe is ordinary — an unreachable host, a refused command. It
    // must not strand everything queued behind it.
    const after = vi.fn(async () => 'ran');

    const failing = queueHostProbe('bench-vm', async () => {
      throw new Error('unreachable');
    });
    const next = queueHostProbe('bench-vm', after);

    await expect(failing).rejects.toThrow('unreachable');
    await expect(next).resolves.toBe('ran');
    expect(after).toHaveBeenCalledOnce();
  });

  it('gives the caller its own error, not the previous task’s', async () => {
    const failing = queueHostProbe('bench-vm', async () => {
      throw new Error('first');
    });
    await expect(failing).rejects.toThrow('first');

    await expect(
      queueHostProbe('bench-vm', async () => {
        throw new Error('second');
      })
    ).rejects.toThrow('second');
  });

  it('returns the task’s own value', async () => {
    await expect(queueHostProbe('bench-vm', async () => 42)).resolves.toBe(42);
  });
});

/**
 * Serialises PTY attach work for one SSH connection.
 *
 * Every remote session on a host shares a single ssh2 transport, and an attach
 * opens several channels on it (SFTP for hooks, an exec to resolve the CLI, the
 * pty itself). When a transport is rebuilt, every session on that host wants to
 * re-attach at once: 51 sessions on one host produced 51 attaches inside the
 * same millisecond, which saturated the tunnel, pushed channel opens past
 * `CHANNEL_OPEN_TIMEOUT_MS`, and tripped the connection manager's wedge
 * watchdog — rebuilding the transport and starting the same stampede again.
 *
 * Running attaches one at a time with a gap between them keeps the number of
 * in-flight channel opens at roughly one, which is what the slower tunnels
 * (an IAP or SSM ProxyCommand) can actually absorb.
 */

/** Gap between the end of one task and the start of the next. */
const DEFAULT_INTER_TASK_DELAY_MS = 250;

export class AttachQueueClearedError extends Error {
  constructor() {
    super('Attach cancelled: the SSH connection dropped before this attach started');
    this.name = 'AttachQueueClearedError';
  }
}

interface QueuedTask {
  /** Runs the caller's task and settles its promise. Never rejects. */
  readonly run: () => Promise<void>;
  /** Rejects the caller's promise without running the task. */
  readonly cancel: () => void;
}

export class AttachQueue {
  private readonly pending: QueuedTask[] = [];
  private running = false;

  constructor(
    private readonly interTaskDelayMs: number = DEFAULT_INTER_TASK_DELAY_MS,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms))
  ) {}

  /** Tasks waiting for a turn, excluding the one in flight. */
  get depth(): number {
    return this.pending.length;
  }

  /**
   * Run `task` once the queue reaches it. Resolves or rejects with the task's
   * own outcome; a rejection is delivered to that caller only and never stalls
   * the queue. Rejects with `AttachQueueClearedError` if `clear()` discards it
   * before it starts.
   */
  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        // Both handlers are supplied, so the returned promise always fulfils —
        // the drain loop can await it purely for pacing.
        run: () => task().then(resolve, reject),
        cancel: () => reject(new AttachQueueClearedError()),
      });
      if (!this.running) void this.drain();
    });
  }

  /**
   * Drop every task that has not started yet, rejecting its caller so nothing
   * awaits a turn that will never come. The task in flight is left alone — it
   * already owns channels on the transport and abandoning it here would leak
   * them. Used when the connection drops: the queued attaches were aimed at a
   * transport that no longer exists.
   */
  clear(): void {
    const dropped = this.pending.splice(0);
    for (const task of dropped) task.cancel();
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      let isFirst = true;
      while (this.pending.length > 0) {
        if (!isFirst) await this.sleep(this.interTaskDelayMs);
        isFirst = false;
        // `clear()` can empty the queue while we sleep.
        const next = this.pending.shift();
        if (!next) break;
        await next.run();
      }
    } finally {
      this.running = false;
    }
  }
}

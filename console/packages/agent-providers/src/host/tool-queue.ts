import { JsonRpcError } from '../transport/stdio-json-rpc';

export type TaskState =
  | 'QUEUED'
  | 'RUNNING'
  | 'SETTLED'
  | 'CANCEL_REQUESTED'
  | 'QUARANTINED'
  | 'TERMINATED';

export interface ActiveToolTask<T> {
  id: string | number;
  state: TaskState;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timeoutTimer: NodeJS.Timeout | null;
  cancelGraceTimer: NodeJS.Timeout | null;
}

export interface ToolCallQueueOptions {
  /** Maximum number of tasks permitted to wait in queue (excludes the single active running task). */
  maxWaitingDepth?: number;
  /** Maximum milliseconds a task is allowed to wait in queue before being expired. */
  queueWaitTimeoutMs?: number;
  /** Maximum execution duration allowed for a single tool call before triggering cancellation. */
  executionTimeoutMs?: number;
  /** Grace window in milliseconds allowed after sending `notifications/cancelled` for in-flight response. */
  cancelGraceMs?: number;
  /** Callback to emit MCP `notifications/cancelled` over the transport when timeout expires. */
  onCancelRequested?: (id: string | number) => Promise<void>;
  /** Callback to terminate the child process tree when cancellation grace period expires unacknowledged. */
  onQuarantineProcess?: () => Promise<void>;
}

/**
 * Sequential execution queue for MCP stdio tool calls with strict active-operation lifecycle management.
 *
 * Guarantees:
 * 1. Strict sequential execution (concurrency = 1): Eliminates race conditions and database mutation interleaving.
 * 2. Explicit lifecycle states: QUEUED -> RUNNING -> SETTLED | CANCEL_REQUESTED -> QUARANTINED -> TERMINATED.
 * 3. Ambiguous timeout handling: After `executionTimeoutMs`, issues `notifications/cancelled`. If unsettled
 *    after `cancelGraceMs`, marks the process QUARANTINED, rejects caller with `TOOL_TIMEOUT_AMBIGUOUS_OUTCOME`,
 *    and terminates the process tree. Quarantined processes are permanently retired and never reused.
 * 4. Zero automatic replays: Ambiguous database mutations are never retried.
 * 5. Safe rejection: Rejecting queued or active promises is cleanly separated from process termination.
 */
export class ToolCallQueue {
  private activeTask: ActiveToolTask<unknown> | null = null;
  private readonly queue: Array<ActiveToolTask<unknown>> = [];
  private isClosed = false;

  private readonly maxWaitingDepth: number;
  private readonly queueWaitTimeoutMs: number;
  private readonly executionTimeoutMs: number;
  private readonly cancelGraceMs: number;
  private readonly onCancelRequested?: (id: string | number) => Promise<void>;
  private readonly onQuarantineProcess?: () => Promise<void>;

  constructor(options: ToolCallQueueOptions = {}) {
    this.maxWaitingDepth = options.maxWaitingDepth ?? 32;
    this.queueWaitTimeoutMs = options.queueWaitTimeoutMs ?? 30_000;
    this.executionTimeoutMs = options.executionTimeoutMs ?? 120_000;
    this.cancelGraceMs = options.cancelGraceMs ?? 5_000;
    this.onCancelRequested = options.onCancelRequested;
    this.onQuarantineProcess = options.onQuarantineProcess;
  }

  get waitingCount(): number {
    return this.queue.length;
  }

  get isBusy(): boolean {
    return this.activeTask !== null;
  }

  get activeTaskState(): TaskState | null {
    return this.activeTask?.state ?? null;
  }

  enqueue<T>(id: string | number, run: () => Promise<T>): Promise<T> {
    if (this.isClosed) {
      return Promise.reject(new JsonRpcError(-32001, 'Queue closed; transport shutting down'));
    }
    if (this.queue.length >= this.maxWaitingDepth) {
      return Promise.reject(new JsonRpcError(-32004, 'Server queue full; tool call rejected'));
    }

    return new Promise<T>((resolve, reject) => {
      const timeoutTimer = setTimeout(() => {
        const index = this.queue.findIndex((item) => item.id === id);
        if (index !== -1) {
          const [expired] = this.queue.splice(index, 1);
          expired.state = 'TERMINATED';
          expired.reject(new JsonRpcError(-32000, `Tool call ${id} timed out waiting in queue`));
        }
      }, this.queueWaitTimeoutMs);

      const task: ActiveToolTask<unknown> = {
        id,
        state: 'QUEUED',
        run: run as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
        timeoutTimer,
        cancelGraceTimer: null,
      };

      this.queue.push(task);
      this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.activeTask || this.isClosed || this.queue.length === 0) return;

    const task = this.queue.shift()!;
    if (task.timeoutTimer) {
      clearTimeout(task.timeoutTimer);
      task.timeoutTimer = null;
    }

    task.state = 'RUNNING';
    this.activeTask = task;

    // Arm execution timeout
    task.timeoutTimer = setTimeout(() => {
      this.handleExecutionTimeout(task);
    }, this.executionTimeoutMs);

    try {
      const result = await task.run();
      // Handle response settlement race
      if (this.isSettlable(task)) {
        task.state = 'SETTLED';
        this.clearTimers(task);
        task.resolve(result);
      }
      // If QUARANTINED or TERMINATED, resolve/reject was already handled
    } catch (error) {
      if (this.isSettlable(task)) {
        task.state = 'SETTLED';
        this.clearTimers(task);
        task.reject(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      if (task.state === 'SETTLED') {
        this.activeTask = null;
        this.drain();
      }
      // If task is QUARANTINED or TERMINATED, drain stops completely.
    }
  }

  // The execution-timeout timer mutates task.state from outside the async
  // flow, so this reads the live state rather than a control-flow narrowing.
  private isSettlable(task: ActiveToolTask<unknown>): boolean {
    return task.state === 'RUNNING' || task.state === 'CANCEL_REQUESTED';
  }

  private async handleExecutionTimeout(task: ActiveToolTask<unknown>): Promise<void> {
    if (task.state !== 'RUNNING') return;
    task.state = 'CANCEL_REQUESTED';

    // 1. Emit notifications/cancelled over stdio
    try {
      await this.onCancelRequested?.(task.id);
    } catch {}

    // 2. Start grace window
    task.cancelGraceTimer = setTimeout(async () => {
      if (task.state === 'CANCEL_REQUESTED') {
        task.state = 'QUARANTINED';
        this.isClosed = true; // Never return this process to service

        // Reject active operation with explicit ambiguous outcome
        task.reject(
          new JsonRpcError(
            -32000,
            `TOOL_TIMEOUT_AMBIGUOUS_OUTCOME: Operation timed out after ${this.executionTimeoutMs / 1000}s. Outcome is unknown; mutation not retried. Process quarantined.`
          )
        );

        // Reject all waiting queued tasks
        this.rejectQueuedWork(
          new JsonRpcError(-32000, 'Process quarantined due to unsettled tool timeout')
        );

        // Terminate child process tree
        try {
          await this.onQuarantineProcess?.();
        } catch (cleanupErr) {
          console.error(`Cleanup failed during quarantine: ${String(cleanupErr)}`);
        }
        task.state = 'TERMINATED';
        this.activeTask = null;
      }
    }, this.cancelGraceMs);
  }

  /**
   * Invoked upon grant revocation, fatal frame error, process crash, or session shutdown.
   */
  async terminateAll(reason: Error): Promise<void> {
    this.isClosed = true;

    // Reject queued work immediately
    this.rejectQueuedWork(reason);

    // Handle active operation
    if (
      this.activeTask &&
      (this.activeTask.state === 'RUNNING' || this.activeTask.state === 'CANCEL_REQUESTED')
    ) {
      const active = this.activeTask;
      active.state = 'TERMINATED';
      this.clearTimers(active);
      active.reject(reason);
      this.activeTask = null;

      // Ensure process termination is triggered
      try {
        await this.onQuarantineProcess?.();
      } catch (err) {
        console.error(`Error terminating process during terminateAll: ${String(err)}`);
      }
    }
  }

  private rejectQueuedWork(error: Error): void {
    while (this.queue.length > 0) {
      const task = this.queue.shift()!;
      task.state = 'TERMINATED';
      if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
      task.reject(error);
    }
  }

  private clearTimers(task: ActiveToolTask<unknown>): void {
    if (task.timeoutTimer) {
      clearTimeout(task.timeoutTimer);
      task.timeoutTimer = null;
    }
    if (task.cancelGraceTimer) {
      clearTimeout(task.cancelGraceTimer);
      task.cancelGraceTimer = null;
    }
  }
}

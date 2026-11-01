import type { ChildProcess } from 'node:child_process';
import { spawnProvider, stopProvider } from '../provider-process';
import type { ProviderLogger } from '../transport/stdio-json-rpc';

/**
 * The client side of `pi --mode rpc`: one JSON object per line on the child's
 * stdin and stdout. Commands carry an `id` and a `type`; Pi answers each with
 * `{ id, type: 'response', command, success, data? | error? }`. Everything
 * else it writes is an event, including `extension_ui_request`, which has an
 * `id` of its own that is not one of ours and is answered with
 * `extension_ui_response` through `send`.
 *
 * Framing follows Pi's own reader (`dist/modes/rpc/jsonl.js`): records are
 * split on LF only, never with `readline`, which would also split on U+2028
 * and U+2029 inside JSON strings; a trailing CR is dropped, as Pi drops it
 * (`jsonl.js:22`), so a CRLF line is logged without its CR.
 *
 * The process ending and its stdout ending are separate: Node may report
 * `exit` before the last chunks are read. When Pi goes away on its own, the
 * commands still waiting are rejected at once, but its remaining output is
 * still read, to the end of the stream or for `OUTPUT_DRAIN_MS` at most (a
 * child of Pi may hold the pipe open), and only then is the exit reported.
 * A failed write to its input ends the link the same way.
 *
 * Every way the client can be finished with the process ends in `finalize`,
 * which does the same each time and only once: commands still waiting are
 * rejected, timers stop, the output streams are let go of (so an inherited
 * pipe keeps neither the host nor the client alive) and `onExit` is called.
 */

export const PI_RPC_MAX_LINE_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const STDERR_TAIL_LIMIT = 8_000;
const LOGGED_LINE_LIMIT = 200;
/** How long the output of a process that has exited is still read. */
export const OUTPUT_DRAIN_MS = 1000;

export interface PiRpcResponse {
  id?: string;
  type: 'response';
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/** Any record from Pi that is not a response to one of this client's commands. */
export interface PiRpcEvent {
  type: string;
  [key: string]: unknown;
}

export interface PiRpcClientOptions {
  command: string;
  args: string[];
  cwd: string;
  /** Complete environment for the child; never merged with `process.env`. */
  env: Record<string, string>;
  logger: ProviderLogger;
  /** Every event, in the order Pi wrote it, until the client is disposed. */
  onEvent: (event: PiRpcEvent) => void;
  /**
   * Called once, when the client is finished with the process: it went away,
   * whether or not it was asked to, its streams failed, or it outlived
   * `dispose`.
   */
  onExit: (reason: string) => void;
  /** Longest line accepted before the process is interrupted. */
  maxLineBytes?: number;
}

/** Pi answered the command with `success: false`. */
export class PiRpcError extends Error {
  constructor(
    readonly command: string,
    message: string
  ) {
    super(message);
    this.name = 'PiRpcError';
  }
}

interface PendingRequest {
  command: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PiRpcClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly logger: ProviderLogger;
  private readonly onEvent: (event: PiRpcEvent) => void;
  private readonly onExit: (reason: string) => void;
  private readonly maxLineBytes: number;
  private partial: Buffer[] = [];
  private partialBytes = 0;
  private stderrTail = '';
  private nextId = 0;
  /** No more commands are written; those waiting have been rejected. */
  private closed = false;
  /** No more output is read: the client was disposed, or is finished. */
  private outputStopped = false;
  private outputEnded = false;
  /** `finalize` has run. */
  private finished = false;
  private processExited = false;
  /** The exit reason held back while the output of an exited process is drained. */
  private drainingExit: { reason: string; timer: ReturnType<typeof setTimeout> } | null = null;
  /** The shutdown under way or done, which every call to `dispose` waits for. */
  private disposing: Promise<void> | null = null;
  private shutdownAttempts = 0;
  private readonly onStdoutData = (chunk: Buffer | string) =>
    this.handleOutput(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  private readonly onStdoutEnd = () => {
    this.flushPartial();
    this.handleOutputEnd();
  };
  private readonly onStdoutClose = () => this.handleOutputEnd();
  private readonly onStderrData = (chunk: Buffer | string) => {
    this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-STDERR_TAIL_LIMIT);
  };

  constructor(options: PiRpcClientOptions) {
    this.logger = options.logger;
    this.onEvent = options.onEvent;
    this.onExit = options.onExit;
    this.maxLineBytes = options.maxLineBytes ?? PI_RPC_MAX_LINE_BYTES;
    this.child = spawnProvider(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const { stdin, stdout, stderr } = this.child;
    if (!stdin || !stdout || !stderr)
      throw new Error('provider process was spawned without stdio pipes');

    stdout.on('data', this.onStdoutData);
    stdout.on('end', this.onStdoutEnd);
    stdout.on('close', this.onStdoutClose);
    stderr.on('data', this.onStderrData);
    // A stream without an `error` listener throws, which would take the host
    // down; a failed output stream ends the client as a failed spawn does.
    stdout.on('error', (error) => this.handleStreamError('output', error));
    stderr.on('error', (error) => this.handleStreamError('error output', error));
    // A write to a process that has just gone fails asynchronously with
    // EPIPE; no more commands can reach Pi, but what it already wrote is
    // still read, as when it exits.
    stdin.on('error', (error) => {
      this.logger.warn('provider input could not be written', { error: error.message });
      this.handleGone(`provider input stream failed: ${error.message}`);
    });

    // Node reports here both a process that could not be started and a
    // signal that could not be sent to one that runs; only the first has no
    // pid. A failed signal says nothing of the process, so only `exit` or the
    // limit of `dispose` ends the client then.
    this.child.on('error', (error) => {
      if (this.child.pid !== undefined) {
        this.logger.warn('provider process could not be signalled', {
          pid: this.child.pid,
          error: error.message,
        });
        return;
      }
      this.processExited = true;
      this.finalize(`spawn failed: ${error.message}`);
    });
    this.child.on('exit', (code, signal) => {
      this.processExited = true;
      this.handleGone(
        `provider process exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`
      );
    });
  }

  get stderr(): string {
    return this.stderrTail;
  }

  get isAlive(): boolean {
    return !this.closed;
  }

  /**
   * Writes the command `type` and resolves with the `data` of its response,
   * or rejects with `PiRpcError` when Pi answers `success: false`. A command
   * that is not answered in time is not resent: its outcome is unknown.
   */
  request<T = unknown>(
    type: string,
    params: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {}
  ): Promise<T> {
    if (this.closed)
      return Promise.reject(new Error(`provider process is gone; cannot send ${type}`));
    const id = `sw${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`Pi command ${type} timed out; its outcome is unknown and it was not resent.`)
        );
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, {
        command: type,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      try {
        this.write({ ...params, id, type });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Writes a record that Pi does not answer, such as `extension_ui_response`. */
  send(message: { type: string; [key: string]: unknown }): void {
    if (this.closed) throw new Error(`provider process is gone; cannot send ${message.type}`);
    this.write(message);
  }

  /**
   * Stops the process with a single request to shut down, then SIGKILL if it
   * is still there two seconds later. Pi starts its shutdown on SIGTERM and on
   * the end of its input alike, but a second start while the first is under
   * way exits at once, skipping the cleanup (`dist/modes/rpc/rpc-mode.js:580`),
   * so only one is sent. Elsewhere than Windows that is SIGTERM, as Pi's own
   * client stops it (`dist/modes/rpc/rpc-client.js:94`); its handler also
   * ends the detached children Pi tracks (`rpc-mode.js:281-283`). On Windows
   * every kill is immediate, so the request there is the end of its input
   * (`rpc-mode.js:639-642`). Commands still waiting are rejected at once and
   * nothing it writes from now on reaches `onEvent`. A call made while the
   * shutdown is under way waits for the same one and sends nothing: a second
   * SIGTERM would end Pi before its cleanup (`rpc-mode.js:584-589`).
   *
   * If the process is still there five seconds after the request, even after
   * SIGKILL, the client finishes without it and the call rejects. That
   * outcome is not kept: the next call tries again, with SIGKILL at once, as
   * Pi's cleanup is past saving. The rejection is never left unhandled, so a
   * caller that does not wait for `dispose` does not bring the host down.
   */
  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    const attempt = this.shutdown(this.shutdownAttempts++ === 0);
    this.disposing = attempt;
    attempt.then(undefined, () => {
      if (this.disposing === attempt) this.disposing = null;
    });
    return attempt;
  }

  private async shutdown(graceful: boolean): Promise<void> {
    this.close('provider process was stopped');
    this.stopOutput();
    if (this.processExited) return;
    await new Promise<void>((resolve, reject) => {
      const kill = graceful
        ? setTimeout(() => stopProvider(this.child, 'SIGKILL'), 2000)
        : undefined;
      const timeout = setTimeout(() => {
        cleanup();
        const reason = 'Provider process did not exit after termination.';
        this.logger.warn('provider process did not exit after termination', {
          pid: this.child.pid,
        });
        reject(new Error(reason));
        this.finalize(reason);
      }, 5000);
      const cleanup = () => {
        clearTimeout(kill);
        clearTimeout(timeout);
        this.child.removeListener('exit', exited);
        this.child.removeListener('error', failedToStart);
      };
      const exited = () => {
        cleanup();
        resolve();
      };
      // A process that could not be started never emits `exit` (Node 24:
      // `error`, then `close`). The handler set up in the constructor runs
      // first and marks it gone; a signal that could not be sent leaves it
      // running, so the wait goes on.
      const failedToStart = () => {
        if (this.processExited) exited();
      };
      this.child.once('exit', exited);
      this.child.on('error', failedToStart);
      if (!graceful) stopProvider(this.child, 'SIGKILL');
      else if (process.platform === 'win32') this.child.stdin?.end();
      else stopProvider(this.child, 'SIGTERM');
    });
  }

  private write(message: Record<string, unknown>): void {
    const stdin = this.child.stdin;
    if (!stdin || !stdin.writable)
      throw new Error('Provider input is closed; command was not written.');
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleOutput(chunk: Buffer): void {
    let start = 0;
    while (!this.outputStopped) {
      // 0x0A never occurs inside a multi-byte UTF-8 sequence, so the split
      // is safe on raw bytes and a character cut between chunks survives.
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      this.partialBytes += end - start;
      if (this.partialBytes > this.maxLineBytes) {
        this.partial = [];
        this.partialBytes = 0;
        const reason = `Provider protocol line exceeds ${this.maxLineBytes} bytes. Execution was interrupted.`;
        this.finalize(reason);
        stopProvider(this.child, 'SIGKILL');
        return;
      }
      if (end > start) this.partial.push(chunk.subarray(start, end));
      if (newline === -1) return;
      const line = Buffer.concat(this.partial).toString('utf8');
      this.partial = [];
      this.partialBytes = 0;
      this.handleLine(line.endsWith('\r') ? line.slice(0, -1) : line);
      start = newline + 1;
    }
  }

  /** Pi's reader emits an unterminated last record at end of stream; so does this one. */
  private flushPartial(): void {
    if (this.partialBytes === 0 || this.outputStopped) return;
    const line = Buffer.concat(this.partial).toString('utf8');
    this.partial = [];
    this.partialBytes = 0;
    this.handleLine(line.endsWith('\r') ? line.slice(0, -1) : line);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      this.logger.warn('provider process emitted a line that is not JSON', {
        line: line.slice(0, LOGGED_LINE_LIMIT),
      });
      return;
    }
    if (typeof record !== 'object' || record === null || Array.isArray(record)) {
      this.logger.warn('provider process emitted a record that is not an object', {
        line: line.slice(0, LOGGED_LINE_LIMIT),
      });
      return;
    }
    const message = record as Record<string, unknown>;
    if (typeof message.type !== 'string') {
      this.logger.warn('provider process emitted a record without a type', {
        line: line.slice(0, LOGGED_LINE_LIMIT),
      });
      return;
    }
    if (message.type === 'response') {
      this.handleResponse(message as unknown as PiRpcResponse);
      return;
    }
    try {
      this.onEvent(message as PiRpcEvent);
    } catch (cause) {
      this.logger.error('provider event handler threw', {
        type: message.type,
        error: String(cause),
      });
    }
  }

  private handleResponse(response: PiRpcResponse): void {
    const pending = typeof response.id === 'string' ? this.pending.get(response.id) : undefined;
    if (!pending) {
      // A parse error has no id, and a command that timed out is no longer
      // waited for; neither can be matched to a caller.
      this.logger.warn('provider process answered a command that is not pending', {
        command: response.command,
        id: response.id,
        error: response.error,
      });
      return;
    }
    this.pending.delete(response.id as string);
    clearTimeout(pending.timer);
    if (response.success === true) pending.resolve(response.data);
    else
      pending.reject(
        new PiRpcError(
          pending.command,
          typeof response.error === 'string' ? response.error : `Pi rejected ${pending.command}`
        )
      );
  }

  private close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new Error(`${reason} while awaiting ${pending.command}`));
    }
  }

  /** No more output is read; an exit held back for the drain is reported now. */
  private stopOutput(): void {
    this.outputStopped = true;
    if (this.drainingExit) this.finalize(this.drainingExit.reason);
  }

  private handleStreamError(stream: string, error: Error): void {
    this.logger.warn(`provider ${stream} stream failed`, { error: error.message });
    this.finalize(`provider ${stream} stream failed: ${error.message}`);
  }

  private handleOutputEnd(): void {
    this.outputEnded = true;
    if (this.drainingExit) this.finalize(this.drainingExit.reason);
  }

  /**
   * Pi can no longer be reached: the process is gone, or its input failed.
   * What it wrote before may still be unread, so the output is read to its
   * end, or for `OUTPUT_DRAIN_MS`, unless it has ended or is no longer read.
   */
  private handleGone(reason: string): void {
    if (this.finished || this.drainingExit) return;
    this.close(reason);
    // The output ended before the process did: there is nothing left to read.
    if (this.outputEnded) {
      this.finalize(reason);
      return;
    }
    // The client was disposed: what Pi writes while it shuts down is not read.
    if (this.outputStopped) {
      this.finalize(reason);
      return;
    }
    const timer = setTimeout(() => this.finalize(reason), OUTPUT_DRAIN_MS);
    timer.unref();
    this.drainingExit = { reason, timer };
  }

  /**
   * The one end of every path: commands still waiting are rejected, the drain
   * timer stops, the output is let go of (its listeners come off, unread data
   * is dropped, the streams are destroyed) and `onExit` is called. Only the
   * `error` listeners stay, so a late failure is only logged. Runs once.
   */
  private finalize(reason: string): void {
    if (this.finished) return;
    this.finished = true;
    if (this.drainingExit) {
      clearTimeout(this.drainingExit.timer);
      this.drainingExit = null;
    }
    this.close(reason);
    this.outputStopped = true;
    this.partial = [];
    this.partialBytes = 0;
    const { stdout, stderr } = this.child;
    stdout?.off('data', this.onStdoutData);
    stdout?.off('end', this.onStdoutEnd);
    stdout?.off('close', this.onStdoutClose);
    stderr?.off('data', this.onStderrData);
    stdout?.destroy();
    stderr?.destroy();
    this.onExit(reason);
  }
}

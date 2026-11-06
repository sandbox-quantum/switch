import type { ChildProcess } from 'node:child_process';
import { spawnProvider, stopProvider } from '../provider-process';
import type { ProviderLogger } from '../transport/stdio-json-rpc';
import type { PiEvent, PiUiRequest, PiUiResponse } from './protocol';

export interface PiRpcClientOptions {
  command: string;
  args: string[];
  cwd: string;
  /** Complete environment for the child; never merged with `process.env`. */
  env: Record<string, string>;
  logger: ProviderLogger;
  /** Called with each session event Pi streams. */
  onEvent: (event: PiEvent) => void;
  /** Called with each request an extension makes of the client. */
  onUiRequest: (request: PiUiRequest) => void;
  /** Called once when the process goes away, whether or not it was asked to. */
  onExit: (reason: string) => void;
}

/** A command Pi answered with `success: false`. */
export class PiRpcError extends Error {
  constructor(
    readonly command: string,
    message: string
  ) {
    super(message);
    this.name = 'PiRpcError';
  }
}

interface PendingCommand {
  command: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PiRecord {
  type?: string;
  id?: string;
  command?: string;
  success?: boolean;
  data?: unknown;
  error?: string;
}

const LINE_LIMIT = 16 * 1024 * 1024;
const STDERR_TAIL_LIMIT = 8_000;
const LF = 0x0a;

/**
 * The client of `pi --mode rpc`: JSON records, one per line, on the process's
 * stdin and stdout.
 *
 * Lines end at LF and nothing else. Pi writes U+2028 and U+2029 unescaped
 * inside strings, which Node's `readline` would take for line ends, so the
 * stream is split here on the bytes. Commands carry an `id` and are answered
 * by the `response` record that repeats it; every other record is a session
 * event or a request from an extension, and goes to the callbacks.
 */
export class PiRpcClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<string, PendingCommand>();
  private readonly logger: ProviderLogger;
  private stderrTail = '';
  private buffered: Buffer = Buffer.alloc(0);
  private nextId = 0;
  private exited = false;
  private processExited = false;

  constructor(private readonly options: PiRpcClientOptions) {
    this.logger = options.logger;
    this.child = spawnProvider(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const { stdout, stderr, stdin } = this.child;
    if (!stdout || !stderr || !stdin)
      throw new Error('provider process was spawned without stdio pipes');
    stdout.on('data', (chunk: Buffer) => this.read(chunk));
    stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-STDERR_TAIL_LIMIT);
    });
    // A write to a process that has just gone is reported by its exit.
    stdin.on('error', (error) => this.logger.debug('Pi input closed', { error: String(error) }));
    this.child.on('error', (error) => {
      this.processExited = true;
      this.handleExit(`spawn failed: ${error.message}`);
    });
    this.child.on('exit', (code, signal) => {
      this.processExited = true;
      this.handleExit(
        `provider process exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`
      );
    });
  }

  /** What the process has written to stderr lately, for an error to quote. */
  get stderr(): string {
    return this.stderrTail;
  }

  get isAlive(): boolean {
    return !this.exited;
  }

  /** Sends a command and resolves with the `data` of its response. */
  request<T = undefined>(
    command: string,
    params: Record<string, unknown> = {},
    timeoutMs = 60_000
  ): Promise<T> {
    if (this.exited)
      return Promise.reject(new Error(`provider process is gone; cannot call ${command}`));
    const id = String(++this.nextId);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Pi command ${command} timed out; its outcome is unknown and it was not resent.`
          )
        );
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        command,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      try {
        this.write({ id, type: command, ...params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Answers a request an extension made; Pi sends nothing back. */
  respond(response: PiUiResponse): void {
    if (!this.exited) this.write(response);
  }

  async dispose(): Promise<void> {
    if (this.processExited) return;
    await new Promise<void>((resolve, reject) => {
      const kill = setTimeout(() => stopProvider(this.child, 'SIGKILL'), 2000);
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Provider process did not exit after termination.'));
      }, 5000);
      const cleanup = () => {
        clearTimeout(kill);
        clearTimeout(timeout);
        this.child.removeListener('exit', exited);
      };
      const exited = () => {
        cleanup();
        resolve();
      };
      this.child.once('exit', exited);
      // Closing stdin is how Pi is asked to finish up; the signal is for a Pi
      // that does not, and is safe to send alongside it. On Windows any kill
      // is immediate, so the closed stdin is the whole request there.
      this.child.stdin?.end();
      if (process.platform !== 'win32') this.child.kill('SIGTERM');
    });
  }

  private write(record: Record<string, unknown>): void {
    const stdin = this.child.stdin;
    if (!stdin || !stdin.writable)
      throw new Error('Provider input is closed; command was not written.');
    stdin.write(`${JSON.stringify(record)}\n`);
  }

  private read(chunk: Buffer): void {
    this.buffered = this.buffered.length ? Buffer.concat([this.buffered, chunk]) : chunk;
    let end = this.buffered.indexOf(LF);
    while (end >= 0) {
      const line = this.buffered.subarray(0, end).toString('utf8').replace(/\r$/, '');
      this.buffered = this.buffered.subarray(end + 1);
      if (line.trim()) this.handleLine(line);
      end = this.buffered.indexOf(LF);
    }
    if (this.buffered.length > LINE_LIMIT) {
      stopProvider(this.child, 'SIGKILL');
      this.handleExit('Provider protocol line exceeds 16 MiB. Execution was interrupted.');
    }
  }

  private handleLine(line: string): void {
    let record: PiRecord;
    try {
      record = JSON.parse(line) as PiRecord;
    } catch {
      this.logger.warn('provider process emitted a line that is not JSON', { line });
      return;
    }
    try {
      if (record.type === 'response') this.handleResponse(record);
      else if (record.type === 'extension_ui_request')
        this.options.onUiRequest(record as unknown as PiUiRequest);
      else this.options.onEvent(record as unknown as PiEvent);
    } catch (cause) {
      this.logger.error('Pi record handler threw', { type: record.type, error: String(cause) });
    }
  }

  private handleResponse(record: PiRecord): void {
    const pending = record.id === undefined ? undefined : this.pending.get(record.id);
    if (!pending || record.id === undefined) {
      // A command Pi could not parse is answered without the id it carried.
      if (record.success === false)
        this.logger.warn('Pi rejected a command', { command: record.command, error: record.error });
      return;
    }
    this.pending.delete(record.id);
    clearTimeout(pending.timer);
    if (record.success === false)
      pending.reject(new PiRpcError(pending.command, record.error ?? `${pending.command} failed`));
    else pending.resolve(record.data);
  }

  private handleExit(reason: string): void {
    if (this.exited) return;
    this.exited = true;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new Error(`${reason} while awaiting ${pending.command}`));
    }
    this.options.onExit(reason);
  }
}

import type { ChildProcess } from 'node:child_process';
import { spawnProvider, stopProvider } from '../provider-process';
import type { ProviderLogger } from '../transport/stdio-json-rpc';

/** A record Pi writes on stdout: a command response, a session event or an extension UI request. */
export interface PiRecord {
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
  /** Every record that is not the response to a command sent with `command`. */
  onRecord: (record: PiRecord) => void;
  /** Called once when the process goes away, whether or not it was asked to. */
  onExit: (reason: string) => void;
}

export class PiCommandError extends Error {
  constructor(
    readonly command: string,
    message: string
  ) {
    super(message);
    this.name = 'PiCommandError';
  }
}

interface PendingCommand {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  type: string;
  timer: ReturnType<typeof setTimeout>;
}

const LINE_LIMIT = 16 * 1024 * 1024;
const STDERR_TAIL_LIMIT = 8_000;
/** `abort` answers only once the session is idle again, which can take a while. */
const COMMAND_TIMEOUT_MS: Record<string, number> = { abort: 5 * 60 * 1000 };
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Pi's RPC mode over a child process' stdio: one JSON record per LF-terminated
 * line each way. Records are split on the LF byte alone, as Pi requires:
 * `readline` also splits on U+2028 and U+2029, which are valid inside JSON
 * strings. A command carries an id that its `response` repeats; everything
 * else Pi writes goes to `onRecord`.
 */
export class PiRpcClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<string, PendingCommand>();
  private readonly logger: ProviderLogger;
  private readonly onRecord: (record: PiRecord) => void;
  private readonly onExit: (reason: string) => void;
  private chunks: Buffer[] = [];
  private lineBytes = 0;
  private stderrTail = '';
  private nextId = 0;
  private exited = false;
  private processExited = false;

  constructor(options: PiRpcClientOptions) {
    this.logger = options.logger;
    this.onRecord = options.onRecord;
    this.onExit = options.onExit;
    this.child = spawnProvider(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = this.child.stdout;
    const stderr = this.child.stderr;
    if (!stdout || !stderr) throw new Error('pi was spawned without stdio pipes');
    stdout.on('data', (chunk: Buffer) => this.read(chunk));
    stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-STDERR_TAIL_LIMIT);
    });
    this.child.on('error', (error) => {
      this.processExited = true;
      this.handleExit(`spawn failed: ${error.message}`);
    });
    this.child.on('exit', (code, signal) => {
      this.processExited = true;
      this.handleExit(`pi exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`);
    });
  }

  get stderr(): string {
    return this.stderrTail;
  }

  get isAlive(): boolean {
    return !this.exited;
  }

  /** Sends a command and resolves with its response's `data`; a refused command rejects. */
  command<T = unknown>(type: string, fields: Record<string, unknown> = {}): Promise<T> {
    if (this.exited) return Promise.reject(new Error(`pi is gone; cannot send ${type}`));
    const id = `switch-${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `pi did not answer ${type} in time; its outcome is unknown and it was not resent.`
          )
        );
      }, COMMAND_TIMEOUT_MS[type] ?? DEFAULT_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, { resolve: resolve as (data: unknown) => void, reject, type, timer });
      try {
        this.write({ ...fields, id, type });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Writes a record that has no response, such as an `extension_ui_response`. */
  send(record: PiRecord): void {
    if (this.exited) return;
    this.write(record);
  }

  async dispose(): Promise<void> {
    if (this.processExited) return;
    await new Promise<void>((resolve, reject) => {
      const kill = setTimeout(() => stopProvider(this.child, 'SIGKILL'), 2000);
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('pi did not exit after termination.'));
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
      // Closing stdin is Pi's request for an orderly shutdown.
      this.child.stdin?.end();
      if (process.platform !== 'win32') this.child.kill('SIGTERM');
    });
  }

  private write(record: Record<string, unknown>): void {
    const stdin = this.child.stdin;
    if (!stdin || !stdin.writable) throw new Error('pi input is closed; command was not written.');
    stdin.write(`${JSON.stringify(record)}\n`);
  }

  private read(chunk: Buffer): void {
    let start = 0;
    for (let index = chunk.indexOf(10); index >= 0; index = chunk.indexOf(10, start)) {
      this.chunks.push(chunk.subarray(start, index));
      this.lineBytes += index - start;
      const line = Buffer.concat(this.chunks).toString('utf8');
      this.chunks = [];
      this.lineBytes = 0;
      this.handleLine(line.endsWith('\r') ? line.slice(0, -1) : line);
      start = index + 1;
      if (this.exited) return;
    }
    if (start < chunk.length) {
      this.chunks.push(chunk.subarray(start));
      this.lineBytes += chunk.length - start;
      if (this.lineBytes > LINE_LIMIT) {
        this.chunks = [];
        stopProvider(this.child, 'SIGKILL');
        this.handleExit('A pi protocol line exceeds 16 MiB. Execution was interrupted.');
      }
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let record: PiRecord;
    try {
      record = JSON.parse(line) as PiRecord;
    } catch {
      this.logger.warn('pi wrote a line that is not JSON', { line: line.slice(0, 500) });
      return;
    }
    if (record.type === 'response' && typeof record.id === 'string') {
      const pending = this.pending.get(record.id);
      if (pending) {
        this.pending.delete(record.id);
        clearTimeout(pending.timer);
        if (record.success === false)
          pending.reject(
            new PiCommandError(pending.type, String(record.error ?? `${pending.type} failed`))
          );
        else pending.resolve(record.data);
        return;
      }
    }
    try {
      this.onRecord(record);
    } catch (cause) {
      this.logger.error('pi record handler threw', { type: record.type, error: String(cause) });
    }
  }

  private handleExit(reason: string): void {
    if (this.exited) return;
    this.exited = true;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new Error(`${reason} while awaiting ${pending.type}`));
    }
    this.onExit(reason);
  }
}

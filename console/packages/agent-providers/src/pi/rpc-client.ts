import type { ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { spawnProvider, stopProvider } from '../provider-process';
import type { ProviderLogger } from '../transport/stdio-json-rpc';

/** One JSON record Pi writes on stdout: a response, a session event or an extension UI request. */
export interface PiRecord {
  type: string;
  [field: string]: unknown;
}

const LINE_LIMIT = 16 * 1024 * 1024;
const STDERR_TAIL_LIMIT = 8_000;
const COMMAND_TIMEOUT_MS = 60_000;
/**
 * Pi answers a prompt once it accepts it, which can wait on compaction and on
 * MCP servers connecting, an abort once it is idle, and a compaction once the
 * model has summarized the conversation.
 */
const LONG_COMMANDS = new Set(['prompt', 'abort', 'compact']);
const LONG_COMMAND_TIMEOUT_MS = 10 * 60_000;
/** How long the pipes may stay open after Pi exits, while what it wrote last is read. */
const DRAIN_AFTER_EXIT_MS = 1_000;

/** Pi refused a command (`success: false`), with its own words. */
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
  type: string;
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface PiRpcClientOptions {
  command: string;
  args: string[];
  cwd: string;
  /** Complete environment for the child; never merged with `process.env`. */
  env: Record<string, string>;
  logger: ProviderLogger;
  /** Every record that is not the response to a command sent here. */
  onRecord: (record: PiRecord) => void;
  /** Called once when the process goes away, whether or not it was asked to. */
  onExit: (reason: string) => void;
}

/**
 * Pi's RPC mode (`pi --mode rpc`): JSON records over the child's stdio, one
 * per line. Records are split on LF alone, as Pi requires: Node's `readline`
 * also splits on U+2028 and U+2029, which JSON strings may hold. The CR of a
 * CRLF ending is whitespace to `JSON.parse`.
 */
export class PiRpcClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<string, PendingCommand>();
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private stderrTail = '';
  private nextId = 0;
  private exited = false;
  private processExited = false;

  constructor(private readonly options: PiRpcClientOptions) {
    this.child = spawnProvider(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const { stdout, stderr } = this.child;
    if (!stdout || !stderr) throw new Error('Pi was spawned without stdio pipes.');
    stdout.on('data', (chunk: Buffer) => this.read(chunk));
    stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-STDERR_TAIL_LIMIT);
    });
    this.child.on('error', (error) => {
      this.processExited = true;
      this.handleExit(`Pi could not be started: ${error.message}`);
    });
    this.child.on('exit', (code, signal) => {
      this.processExited = true;
      const reason = `Pi exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`;
      const timer = setTimeout(() => this.handleExit(reason), DRAIN_AFTER_EXIT_MS);
      this.child.once('close', () => {
        clearTimeout(timer);
        this.handleExit(reason);
      });
    });
  }

  /** The last of what Pi wrote on stderr. */
  get stderr(): string {
    return this.stderrTail;
  }

  get isAlive(): boolean {
    return !this.exited;
  }

  /** Sends a command and resolves with its `data`; rejects with {@link PiCommandError} when Pi refuses it. */
  command<T = unknown>(type: string, fields: Record<string, unknown> = {}): Promise<T> {
    if (this.exited) return Promise.reject(new Error(`Pi is gone; ${type} was not sent.`));
    const id = `switch-${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(
            new Error(`Pi did not answer ${type}; its outcome is unknown and it was not resent.`)
          );
        },
        LONG_COMMANDS.has(type) ? LONG_COMMAND_TIMEOUT_MS : COMMAND_TIMEOUT_MS
      );
      timer.unref();
      this.pending.set(id, { type, resolve: resolve as (data: unknown) => void, reject, timer });
      try {
        this.write({ ...fields, id, type });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Writes a record Pi does not answer, such as the reply to an extension dialog. */
  send(record: PiRecord): void {
    if (!this.exited) this.write(record);
  }

  async dispose(): Promise<void> {
    if (this.processExited) return;
    await new Promise<void>((resolve, reject) => {
      const kill = setTimeout(() => stopProvider(this.child, 'SIGKILL'), 2000);
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Pi did not exit after termination.'));
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
      // Closing stdin is Pi's orderly shutdown; on Windows, where any kill is
      // immediate, it is all that is asked before the kill above.
      this.child.stdin?.end();
      if (process.platform !== 'win32') this.child.kill('SIGTERM');
    });
  }

  private write(record: Record<string, unknown>): void {
    const stdin = this.child.stdin;
    if (!stdin || !stdin.writable)
      throw new Error('Pi input is closed; the record was not written.');
    stdin.write(`${JSON.stringify(record)}\n`);
  }

  private read(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.handleLine(line);
      newline = this.buffer.indexOf('\n');
    }
    if (this.buffer.length > LINE_LIMIT) {
      stopProvider(this.child, 'SIGKILL');
      this.handleExit('A Pi record exceeds 16 MiB. Execution was interrupted.');
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      this.options.logger.warn('Pi wrote a line that is not JSON', { line: line.slice(0, 500) });
      return;
    }
    if (
      typeof record !== 'object' ||
      record === null ||
      typeof (record as PiRecord).type !== 'string'
    ) {
      this.options.logger.warn('Pi wrote a record without a type', { line: line.slice(0, 500) });
      return;
    }
    const message = record as PiRecord;
    const pending =
      message.type === 'response' && typeof message.id === 'string'
        ? this.pending.get(message.id)
        : undefined;
    if (!pending) {
      this.options.onRecord(message);
      return;
    }
    this.pending.delete(message.id as string);
    clearTimeout(pending.timer);
    if (message.success === true) pending.resolve(message.data);
    else
      pending.reject(
        new PiCommandError(pending.type, String(message.error ?? `${pending.type} failed`))
      );
  }

  private handleExit(reason: string): void {
    if (this.exited) return;
    this.exited = true;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new Error(`${reason} while awaiting ${pending.type}`));
    }
    this.options.onExit(reason);
  }
}

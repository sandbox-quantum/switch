import type { ChildProcess } from 'node:child_process';
import { spawnProvider, stopProvider } from '../provider-process';
import type { ProviderLogger } from '../transport/stdio-json-rpc';

/** One record Pi writes on stdout: a command's response, a session event or an extension UI request. */
export type PiRecord = { type: string } & Record<string, unknown>;

export interface PiResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

/** The commands the adapter sends, with the replies it awaits; see Pi's `docs/rpc-commands.md`. */
export interface PiTransport {
  /** Sends a command and resolves with its response, failed or not. Rejects when Pi is gone. */
  command(command: { type: string } & Record<string, unknown>): Promise<PiResponse>;
  /** Writes a record that has no response, such as an `extension_ui_response`. */
  send(record: { type: string } & Record<string, unknown>): void;
  readonly stderr: string;
  readonly isAlive: boolean;
  dispose(): Promise<void>;
}

export interface PiLaunch {
  command: string;
  args: string[];
  cwd: string;
  /** Complete environment for Pi; never merged with `process.env`. */
  env: Record<string, string>;
}

export interface PiTransportHandlers {
  /** Every record that is not a command's response, in the order Pi wrote them. */
  onRecord: (record: PiRecord) => void;
  /** Called once when Pi goes away, whether or not it was asked to. */
  onExit: (reason: string) => void;
  logger: ProviderLogger;
}

export type PiTransportFactory = (launch: PiLaunch, handlers: PiTransportHandlers) => PiTransport;

const STDERR_TAIL_LIMIT = 8_000;
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 60_000;
/** `abort` answers once the run is idle, and `compact` once the summary is written. */
const SLOW_COMMANDS: Record<string, number> = { abort: 5 * 60_000, compact: 15 * 60_000 };

interface Pending {
  type: string;
  resolve: (response: PiResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * `pi --mode rpc` over a child process' stdio.
 *
 * Records are split on LF bytes only. Pi's RPC docs warn against Node's
 * `readline`, which also ends a line at U+2028 and U+2029, both of which are
 * valid inside a JSON string and so inside any message or tool output.
 */
export class PiRpcClient implements PiTransport {
  private readonly child: ChildProcess;
  private readonly pending = new Map<string, Pending>();
  private readonly handlers: PiTransportHandlers;
  private buffer = Buffer.alloc(0);
  private stderrTail = '';
  private nextId = 0;
  private exited = false;
  private processExited = false;

  constructor(launch: PiLaunch, handlers: PiTransportHandlers) {
    this.handlers = handlers;
    this.child = spawnProvider(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const { stdout, stderr, stdin } = this.child;
    if (!stdout || !stderr || !stdin) throw new Error('Pi was spawned without stdio pipes');
    stdout.on('data', (chunk: Buffer) => this.read(chunk));
    stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-STDERR_TAIL_LIMIT);
    });
    // A write after Pi has gone fails here as well as through `exit`.
    stdin.on('error', (error) => this.handleExit(`Pi's input closed: ${error.message}`));
    this.child.on('error', (error) => {
      this.processExited = true;
      this.handleExit(`spawn failed: ${error.message}`);
    });
    this.child.on('exit', (code, signal) => {
      this.processExited = true;
      this.handleExit(`Pi exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`);
    });
  }

  get stderr(): string {
    return this.stderrTail;
  }

  get isAlive(): boolean {
    return !this.exited;
  }

  command(command: { type: string } & Record<string, unknown>): Promise<PiResponse> {
    if (this.exited) return Promise.reject(new Error(`Pi is gone; ${command.type} was not sent.`));
    const id = `switch-${++this.nextId}`;
    return new Promise<PiResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Pi did not answer ${command.type}; its outcome is unknown and it was not resent.`
          )
        );
      }, SLOW_COMMANDS[command.type] ?? COMMAND_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, { type: command.type, resolve, reject, timer });
      try {
        this.write({ ...command, id });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  send(record: { type: string } & Record<string, unknown>): void {
    if (this.exited) throw new Error(`Pi is gone; ${record.type} was not sent.`);
    this.write(record);
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
      // A closed stdin is Pi's request to shut down in order; the signal
      // follows for a Pi that is stuck.
      this.child.stdin?.end();
      if (process.platform !== 'win32') this.child.kill('SIGTERM');
    });
  }

  private write(record: Record<string, unknown>): void {
    const stdin = this.child.stdin;
    if (!stdin || !stdin.writable) throw new Error('Pi input is closed; command was not written.');
    stdin.write(`${JSON.stringify(record)}\n`);
  }

  private read(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let end: number;
    while ((end = this.buffer.indexOf(10)) >= 0) {
      const line = this.buffer.subarray(0, end).toString('utf8').replace(/\r$/, '');
      this.buffer = this.buffer.subarray(end + 1);
      this.handleLine(line);
    }
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.buffer = Buffer.alloc(0);
      stopProvider(this.child, 'SIGKILL');
      this.handleExit('Pi wrote a protocol line over 16 MiB. Execution was interrupted.');
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let record: PiRecord;
    try {
      record = JSON.parse(line) as PiRecord;
    } catch {
      this.handlers.logger.warn('Pi wrote a line that is not JSON', { line: line.slice(0, 500) });
      return;
    }
    if (
      record.type === 'response' &&
      typeof record.id === 'string' &&
      this.pending.has(record.id)
    ) {
      const pending = this.pending.get(record.id)!;
      this.pending.delete(record.id);
      clearTimeout(pending.timer);
      pending.resolve({
        success: record.success === true,
        ...(record.data === undefined ? {} : { data: record.data }),
        ...(typeof record.error === 'string' ? { error: record.error } : {}),
      });
      return;
    }
    this.handlers.onRecord(record);
  }

  private handleExit(reason: string): void {
    if (this.exited) return;
    this.exited = true;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new Error(`${reason} while awaiting ${pending.type}`));
    }
    this.handlers.onExit(reason);
  }
}

export const spawnPiRpc: PiTransportFactory = (launch, handlers) =>
  new PiRpcClient(launch, handlers);

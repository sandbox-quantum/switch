import type { ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { spawnProvider, stopProvider } from '../provider-process';
import type { ProviderLogger } from '../transport/stdio-json-rpc';

const STDERR_TAIL_LIMIT = 8 * 1024;
const LINE_LIMIT = 16 * 1024 * 1024;

/** A record Pi writes on stdout: a command response, a session event or an extension UI request. */
export type PiRecord = Record<string, unknown> & { type: string };

/** A dialog or notice an extension asks the client for (`docs/rpc-extension-ui.md`). */
export interface PiUiRequest {
  type: 'extension_ui_request';
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
  notifyType?: 'info' | 'warning' | 'error';
  statusKey?: string;
  statusText?: string;
}

export interface PiRpcOptions {
  command: string;
  args: string[];
  cwd: string;
  /** Complete environment for the child; never merged with `process.env`. */
  env: Record<string, string>;
  logger: ProviderLogger;
  onEvent: (event: PiRecord) => void;
  onUiRequest: (request: PiUiRequest) => void;
  /** Called once when the process goes away, whether or not it was asked to. */
  onExit: (reason: string) => void;
}

interface Pending {
  command: string;
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * `pi --mode rpc`: JSONL commands on stdin, and responses, session events and
 * extension UI requests on stdout. Records are split on LF only, as Pi's
 * protocol requires: its strings may hold U+2028 and U+2029, which a line
 * reader would split on.
 */
export class PiRpcClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<string, Pending>();
  private nextId = 0;
  private buffer = '';
  private stderrTail = '';
  private exited = false;
  private processExited = false;

  constructor(private readonly options: PiRpcOptions) {
    this.child = spawnProvider(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const { stdout, stderr } = this.child;
    if (!stdout || !stderr) throw new Error('Pi was spawned without stdio pipes');
    const decoder = new StringDecoder('utf8');
    stdout.on('data', (chunk: Buffer) => this.receive(decoder.write(chunk)));
    stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-STDERR_TAIL_LIMIT);
    });
    this.child.on('error', (error) => {
      this.processExited = true;
      this.gone(`Pi could not be started: ${error.message}`);
    });
    this.child.on('exit', (code, signal) => {
      this.processExited = true;
      this.gone(`Pi exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`);
    });
  }

  get stderr(): string {
    return this.stderrTail;
  }

  get isAlive(): boolean {
    return !this.exited;
  }

  /** Sends a command and resolves with its response's `data`; a refused command rejects with Pi's error. */
  request<T>(type: string, fields: Record<string, unknown> = {}): Promise<T> {
    if (this.exited) return Promise.reject(new Error(`Pi is gone; cannot send ${type}.`));
    const id = `switch-${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { command: type, resolve: resolve as (data: unknown) => void, reject });
      try {
        this.write({ ...fields, id, type });
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Answers a dialog an extension opened. */
  respondToUi(id: string, answer: Record<string, unknown>): void {
    if (this.exited) return;
    this.write({ type: 'extension_ui_response', id, ...answer });
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
      // Closing stdin is Pi's orderly shutdown (`docs/rpc.md`).
      this.child.stdin?.end();
    });
  }

  private write(record: Record<string, unknown>): void {
    const stdin = this.child.stdin;
    if (!stdin || !stdin.writable) throw new Error('Pi input is closed; command was not written.');
    stdin.write(`${JSON.stringify(record)}\n`);
  }

  private receive(text: string): void {
    this.buffer += text;
    if (this.buffer.length > LINE_LIMIT && !this.buffer.includes('\n')) {
      stopProvider(this.child, 'SIGKILL');
      this.gone('Pi wrote a protocol record over 16 MiB. Execution was interrupted.');
      return;
    }
    let end = this.buffer.indexOf('\n');
    while (end >= 0) {
      const line = this.buffer.slice(0, end).replace(/\r$/, '');
      this.buffer = this.buffer.slice(end + 1);
      if (line.trim()) this.record(line);
      end = this.buffer.indexOf('\n');
    }
  }

  private record(line: string): void {
    let record: PiRecord;
    try {
      record = JSON.parse(line) as PiRecord;
    } catch {
      this.options.logger.warn('Pi wrote a line that is not JSON', { line: line.slice(0, 200) });
      return;
    }
    if (record.type === 'response' && typeof record.id === 'string') {
      const pending = this.pending.get(record.id);
      if (!pending) return;
      this.pending.delete(record.id);
      if (record.success === true) pending.resolve(record.data);
      else
        pending.reject(
          new Error(
            `Pi refused ${pending.command}: ${typeof record.error === 'string' ? record.error : 'no reason given'}`
          )
        );
      return;
    }
    if (record.type === 'extension_ui_request') {
      this.options.onUiRequest(record as unknown as PiUiRequest);
      return;
    }
    this.options.onEvent(record);
  }

  private gone(reason: string): void {
    if (this.exited) return;
    this.exited = true;
    for (const pending of this.pending.values())
      pending.reject(new Error(`${reason}${this.stderrTail ? `\n${this.stderrTail}` : ''}`));
    this.pending.clear();
    this.options.onExit(reason);
  }
}

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

export interface FakePiCommand {
  id?: string;
  type: string;
  [key: string]: unknown;
}

/**
 * A stand-in for the `pi --mode rpc` child process. Tests drive the adapter
 * through the same JSONL framing the real binary uses, without spawning
 * anything: they script how it answers commands and push the events and
 * extension requests it would stream.
 */
export class FakePi extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  /** Every record the client wrote, commands and extension UI responses alike. */
  readonly received: FakePiCommand[] = [];
  readonly killed: Array<NodeJS.Signals | undefined> = [];
  private buffer = '';
  private exited = false;

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let end = this.buffer.indexOf('\n');
      while (end >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (line.trim()) {
          const record = JSON.parse(line) as FakePiCommand;
          this.received.push(record);
          this.emit('record', record);
        }
        end = this.buffer.indexOf('\n');
      }
    });
    // Like the real binary, which finishes when its input closes.
    this.stdin.on('finish', () => this.exit(0, null));
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed.push(signal);
    this.exit(null, signal ?? 'SIGTERM');
    return true;
  }

  /** Ends the process without being asked to, as a crash does. */
  crash(): void {
    this.exit(1, null);
  }

  private exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code, signal);
  }

  /** The commands received, by type. */
  commands(type: string): FakePiCommand[] {
    return this.received.filter((record) => record.type === type);
  }

  /** The extension UI responses received. */
  uiResponses(): FakePiCommand[] {
    return this.commands('extension_ui_response');
  }

  /**
   * Answers every command of this type with `data`, or with what `data`
   * returns for it, once that settles.
   */
  answer(type: string, data?: unknown | ((command: FakePiCommand) => unknown)): void {
    this.on('record', (command: FakePiCommand) => {
      if (command.type !== type) return;
      void Promise.resolve(typeof data === 'function' ? data(command) : data).then((body) =>
        this.send({
          type: 'response',
          command: type,
          id: command.id,
          success: true,
          ...(body === undefined ? {} : { data: body }),
        })
      );
    });
  }

  /** Streams a session event. */
  event(record: Record<string, unknown>): void {
    this.send(record);
  }

  /** Streams a request an extension makes of the client. */
  uiRequest(request: Record<string, unknown>): void {
    this.send({ type: 'extension_ui_request', ...request });
  }

  send(record: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(record)}\n`);
  }
}

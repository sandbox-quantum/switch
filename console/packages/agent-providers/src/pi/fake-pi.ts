import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

export interface FakePiRecord {
  id?: string;
  type: string;
  [key: string]: unknown;
}

/**
 * A stand-in for a `pi --mode rpc` child process. Tests drive the adapter
 * through the JSONL framing the real binary uses, without spawning anything:
 * every command gets a successful response, with the data `answer` set for it.
 */
export class FakePi extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly received: FakePiRecord[] = [];
  spawnArgs: string[] = [];
  spawnEnv: Record<string, string> = {};
  private readonly answers = new Map<string, (record: FakePiRecord) => unknown>();
  private readonly held = new Set<string>();
  private buffer = '';
  private exited = false;

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let index = this.buffer.indexOf('\n');
      while (index >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (line.trim()) this.receive(JSON.parse(line) as FakePiRecord);
        index = this.buffer.indexOf('\n');
      }
    });
    // Like the real binary, which stops when its input closes.
    this.stdin.on('finish', () => this.exit(0, null));
  }

  /** Answers every `type` command with `data`, or with what `data` returns for the command. */
  answer(type: string, data: unknown | ((record: FakePiRecord) => unknown)): void {
    this.answers.set(
      type,
      typeof data === 'function' ? (data as (record: FakePiRecord) => unknown) : () => data
    );
  }

  /** Leaves every `type` command unanswered, as Pi leaves an `abort` until it is idle. */
  hold(type: string): void {
    this.held.add(type);
  }

  /** Refuses every `type` command with `error`. */
  refuse(type: string, error: string): void {
    this.answers.set(type, () => {
      throw new Error(error);
    });
  }

  send(record: FakePiRecord): void {
    this.stdout.write(`${JSON.stringify(record)}\n`);
  }

  sent(type: string): FakePiRecord[] {
    return this.received.filter((record) => record.type === type);
  }

  /** Resolves with the next record of `type` the adapter writes, or one it already wrote. */
  next(type: string): Promise<FakePiRecord> {
    const seen = this.sent(type).at(-1);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve) => {
      const handler = (record: FakePiRecord) => {
        if (record.type !== type) return;
        this.off('record', handler);
        resolve(record);
      };
      this.on('record', handler);
    });
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.exit(null, signal ?? 'SIGTERM');
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code, signal);
  }

  private receive(record: FakePiRecord): void {
    this.received.push(record);
    this.emit('record', record);
    if (
      record.type === 'extension_ui_response' ||
      record.id === undefined ||
      this.held.has(record.type)
    )
      return;
    const answer = this.answers.get(record.type);
    try {
      const data = answer ? answer(record) : undefined;
      this.send({ id: record.id, type: 'response', command: record.type, success: true, data });
    } catch (error) {
      this.send({
        id: record.id,
        type: 'response',
        command: record.type,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

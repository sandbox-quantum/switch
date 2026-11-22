import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

export interface FakePiRecord {
  type: string;
  id?: string;
  [field: string]: unknown;
}

type Answer = { data?: unknown } | { error: string };

/** The id `get_state` gives a new session, in the form Pi 1.5.0 gives them. */
export const FAKE_PI_SESSION_ID = '01a1aaf4-5447-7451-a203-ddf59e5aaef3';

/**
 * A stand-in for a `pi --mode rpc` child process. Tests drive the adapter
 * through the same JSONL framing the real one uses, without spawning
 * anything: commands are answered as Pi answers them, and events are written
 * by the test.
 */
export class FakePi extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  /** Every record written to Pi, commands and dialog answers alike. */
  readonly received: FakePiRecord[] = [];
  private readonly answers = new Map<string, (command: FakePiRecord) => Answer | null>();
  private buffer = '';
  private exited = false;

  constructor(
    readonly args: string[],
    readonly env: Record<string, string>
  ) {
    super();
    this.answer('get_state', () => ({
      data: {
        model: { id: 'devstral-medium-latest', provider: 'mistral' },
        sessionId: FAKE_PI_SESSION_ID,
        messageCount: 0,
      },
    }));
    this.answer('set_model', (command) => ({
      data: { provider: command.provider, id: command.modelId },
    }));
    this.answer('prompt', () => ({ data: { disposition: 'started' } }));
    this.answer('abort', () => ({}));
    this.stdin.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let newline = this.buffer.indexOf('\n');
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (line.trim()) this.take(JSON.parse(line) as FakePiRecord);
        newline = this.buffer.indexOf('\n');
      }
    });
    // Like Pi, which shuts down when its input closes.
    this.stdin.on('finish', () => this.exit(0, null));
  }

  /** How Pi answers commands of `type` from now on; null leaves one unanswered. */
  answer(type: string, answer: (command: FakePiRecord) => Answer | null): void {
    this.answers.set(type, answer);
  }

  /** The commands of `type` received so far. */
  commands(type: string): FakePiRecord[] {
    return this.received.filter((record) => record.type === type);
  }

  /** Writes a record on Pi's stdout. */
  emitRecord(record: FakePiRecord): void {
    this.stdout.write(`${JSON.stringify(record)}\n`);
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.exit(null, signal ?? 'SIGTERM');
    return true;
  }

  /** Ends the process as a real one ends: `exit`, then `close` once its output has been read. */
  exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    setImmediate(() => {
      this.emit('exit', code, signal);
      setImmediate(() => this.emit('close', code, signal));
    });
  }

  private take(record: FakePiRecord): void {
    this.received.push(record);
    this.emit('record', record);
    const answer = this.answers.get(record.type)?.(record);
    if (!answer) return;
    this.emitRecord(
      'error' in answer
        ? {
            id: record.id,
            type: 'response',
            command: record.type,
            success: false,
            error: answer.error,
          }
        : {
            id: record.id,
            type: 'response',
            command: record.type,
            success: true,
            ...(answer.data === undefined ? {} : { data: answer.data }),
          }
    );
  }
}

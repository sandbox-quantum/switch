import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { AntigravityEvent, StepUpdate, TurnResult } from './protocol';

/**
 * A stand-in for the `agy` child process. Tests drive the adapter through the
 * same NDJSON framing the real binary uses, without spawning anything.
 */
export class FakeAgy extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  /** Every user message the adapter wrote, already parsed. */
  readonly received: Array<{ event?: string; message?: { content?: unknown } }> = [];
  readonly signals: string[] = [];
  killed = false;
  private buffer = '';

  constructor(readonly args: string[]) {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let index = this.buffer.indexOf('\n');
      while (index >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (line.trim()) {
          const message = JSON.parse(line);
          this.received.push(message);
          this.emit('message', message);
        }
        index = this.buffer.indexOf('\n');
      }
    });
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? 'SIGTERM');
    if (this.killed) return true;
    this.killed = true;
    queueMicrotask(() => this.emit('exit', signal === 'SIGKILL' ? null : 1, signal ?? 'SIGTERM'));
    return true;
  }

  /** Ends the process the way a crash does, with no signal. */
  crash(code = 1): void {
    if (this.killed) return;
    this.killed = true;
    this.emit('exit', code, null);
  }

  send(event: AntigravityEvent): void {
    this.stdout.write(`${JSON.stringify(event)}\n`);
  }

  init(conversationId: string): void {
    this.send({ event: 'init', conversation_id: conversationId, init: { tools: [] } });
  }

  step(update: StepUpdate): void {
    this.send({ event: 'step_update', step_update: update });
  }

  result(result: TurnResult): void {
    this.send({ event: 'result', result });
  }

  waitForMessage(): Promise<{ message?: { content?: unknown } }> {
    const seen = this.received.at(-1);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve) => this.once('message', resolve));
  }
}

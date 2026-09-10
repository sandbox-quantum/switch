import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

export interface FakeJsonRpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * A stand-in for the `codex app-server` child process. Tests drive the adapter
 * through the same newline-delimited JSON-RPC framing the real binary uses,
 * without spawning anything.
 */
export class FakeAppServer extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly received: FakeJsonRpcMessage[] = [];
  private buffer = '';

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let index = this.buffer.indexOf('\n');
      while (index >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (line.trim()) {
          const message = JSON.parse(line) as FakeJsonRpcMessage;
          this.received.push(message);
          this.emit('message', message);
        }
        index = this.buffer.indexOf('\n');
      }
    });
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.emit('exit', null, signal ?? 'SIGTERM');
    return true;
  }

  send(message: FakeJsonRpcMessage): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  sendRaw(line: string): void {
    this.stdout.write(`${line}\n`);
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.send({ method, params });
  }

  /** Resolves with the next client request for `method`, replying with `result`. */
  reply(method: string, result: unknown | ((params: Record<string, unknown>) => unknown)): void {
    const handler = (message: FakeJsonRpcMessage) => {
      if (message.method !== method || message.id === undefined) return;
      this.off('message', handler);
      const value = typeof result === 'function' ? result(message.params ?? {}) : result;
      this.send({ id: message.id, result: value });
    };
    this.on('message', handler);
  }

  /** Replies to every client request for `method`, not just the first. */
  replyAlways(method: string, result: (params: Record<string, unknown>) => unknown): void {
    this.on('message', (message: FakeJsonRpcMessage) => {
      if (message.method !== method || message.id === undefined) return;
      this.send({ id: message.id, result: result(message.params ?? {}) });
    });
  }

  waitFor(method: string): Promise<FakeJsonRpcMessage> {
    const seen = this.received.find((message) => message.method === method);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve) => {
      const handler = (message: FakeJsonRpcMessage) => {
        if (message.method !== method) return;
        this.off('message', handler);
        resolve(message);
      };
      this.on('message', handler);
    });
  }
}

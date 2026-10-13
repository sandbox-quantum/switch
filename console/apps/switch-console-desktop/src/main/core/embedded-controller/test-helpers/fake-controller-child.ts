import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { isStopMessage } from '@switch-console/agent-providers';
import type { ControllerChild, SpawnController } from '../controller-supervisor';

/**
 * How a controller is asked to stop, as `signals` records it: SIGTERM, or on
 * Windows the stop message over its IPC channel.
 */
export const STOP_REQUEST = process.platform === 'win32' ? 'stop message' : 'SIGTERM';

/** A spawned controller as the tests drive it: stdin collected, exits on demand. */
export class FakeControllerChild extends EventEmitter implements ControllerChild {
  readonly pid = 4242;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  /** The signals it was sent, and `STOP_REQUEST` for each stop message. */
  readonly signals: string[] = [];
  readonly sent: unknown[] = [];
  connected = true;
  received = '';
  exitedWith: number | null | undefined = undefined;
  /** Whether SIGTERM ends it, as it ends the real controller. */
  exitsOnSigterm = true;

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => (this.received += chunk.toString()));
  }

  send(message: unknown): boolean {
    this.sent.push(message);
    if (isStopMessage(message)) this.signals.push(STOP_REQUEST);
    if (this.exitsOnSigterm && isStopMessage(message)) queueMicrotask(() => this.exit(0));
    return true;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    if (signal === 'SIGKILL' || this.exitsOnSigterm)
      queueMicrotask(() => this.exit(signal === 'SIGTERM' ? 0 : null, signal));
    return true;
  }

  say(line: string): void {
    this.stderr.write(`${line}\n`);
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitedWith !== undefined) return;
    this.exitedWith = code;
    this.emit('exit', code, signal);
  }
}

export type SpawnCall = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  child: FakeControllerChild;
};

export function fakeSpawn(): { spawn: SpawnController; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  return {
    calls,
    spawn: (command, args, options) => {
      const child = new FakeControllerChild();
      calls.push({ command, args, env: options.env, child });
      return child;
    },
  };
}

export async function waitFor(
  condition: () => boolean,
  what: string,
  timeoutMs = 3_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

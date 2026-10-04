import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ControllerChild, SpawnController } from '../controller-supervisor';

/** A spawned controller as the tests drive it: stdin collected, exits on demand. */
export class FakeControllerChild extends EventEmitter implements ControllerChild {
  readonly pid = 4242;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  received = '';
  exitedWith: number | null | undefined = undefined;
  /** Whether SIGTERM ends it, as it ends the real controller. */
  exitsOnSigterm = true;

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => (this.received += chunk.toString()));
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

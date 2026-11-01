import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

/**
 * A stand-in for `pi --mode rpc` (Pi 1.4.0). Tests drive the client through
 * the same LF-delimited JSON the real binary writes, without spawning it.
 *
 * Shapes are taken from recorded sessions with Pi 1.4.0, not invented:
 * responses from `dist/modes/rpc/rpc-mode.js:31-39` (`success` / `error`) and
 * `runs/2026-10-28-switch-777-pi-provider/evidence/spike/r2-6-on/rpc-s4-resume.jsonl:5-20`
 * (`get_state`, `prompt` with `disposition`, a whole text turn);
 * `get_commands` from `evidence/spike/p2-gate/rpc-run1.jsonl`;
 * `extension_ui_request` `confirm` / `notify` from `evidence/spike/r2-1-gate/rpc-run1.jsonl`
 * and `evidence/spike/p2-gate/rpc-run1.jsonl`; a failed `prompt` from
 * `evidence/probes/p01-02/p01-02-preflight_rpc-preflight.jsonl:4`.
 */

export interface FakePiCommand {
  id?: string;
  type: string;
  [key: string]: unknown;
}

export interface FakePiRecord {
  type: string;
  [key: string]: unknown;
}

/** What a command handler returns: the response's `data`, or a failure. */
export type FakePiReply = { data?: unknown } | { error: string } | undefined;
export type FakePiHandler = (command: FakePiCommand) => FakePiReply;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const FAKE_USAGE = {
  input: 11,
  output: 7,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 18,
  cost: ZERO_COST,
  cacheWrite1h: 0,
};

export const FAKE_PI_MODEL = {
  type: 'chat',
  id: 'fake-model',
  name: 'Fake Model',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 4096,
  api: 'anthropic-messages',
  provider: 'fake',
  baseUrl: 'http://127.0.0.1:1',
};

export function fakePiState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: FAKE_PI_MODEL,
    thinkingLevel: 'off',
    isStreaming: false,
    isCompacting: false,
    steeringMode: 'one-at-a-time',
    followUpMode: 'one-at-a-time',
    sessionFile: '/fake/sessions/2026-10-31T10-44-05-301Z_fake-session.jsonl',
    sessionId: 'fake-session',
    autoCompactionEnabled: true,
    messageCount: 0,
    pendingMessageCount: 0,
    ...overrides,
  };
}

export function fakePiCommands(): Record<string, unknown> {
  return {
    commands: [
      {
        name: 'gate-ready',
        description: 'spike: gate loaded',
        source: 'extension',
        sourceInfo: {
          path: '/spike/ext/ext-gate.mjs',
          source: 'cli',
          scope: 'temporary',
          origin: 'top-level',
        },
      },
    ],
  };
}

/** The events of one plain text turn, in the order Pi 1.4.0 writes them. */
export function fakePiTextTurn(prompt: string, reply: string, timestamp = 1793443450178) {
  const user = { role: 'user', content: [{ type: 'text', text: prompt }], timestamp };
  const assistant = {
    role: 'assistant',
    content: [{ type: 'text', text: reply }],
    api: 'anthropic-messages',
    provider: 'fake',
    model: 'fake-model',
    usage: FAKE_USAGE,
    stopReason: 'stop',
    timestamp: timestamp + 18,
    responseId: 'msg_fake_0',
    rawStopReason: 'end_turn',
    durationMs: 29,
    thinkingLevel: 'off',
  };
  const update = (assistantMessageEvent: Record<string, unknown>) => ({
    type: 'message_update',
    usage: FAKE_USAGE,
    assistantMessageEvent,
  });
  return [
    { type: 'agent_start' },
    { type: 'turn_start' },
    { type: 'message_start', message: user },
    { type: 'message_end', message: user },
    {
      type: 'message_start',
      message: {
        ...assistant,
        content: [{ type: 'text', text: '', index: 0 }],
        stopReason: 'pending',
      },
    },
    update({ type: 'text_start', contentIndex: 0 }),
    update({ type: 'text_delta', contentIndex: 0, delta: reply }),
    update({ type: 'text_end', contentIndex: 0, content: reply }),
    { type: 'message_end', message: assistant },
    { type: 'turn_end', message: assistant, toolResults: [] },
    { type: 'agent_end', messages: [user, assistant], willRetry: false },
    { type: 'agent_settled', aborted: false },
  ] satisfies FakePiRecord[];
}

export function fakePiConfirm(id: string, title: string, message: string): FakePiRecord {
  return { type: 'extension_ui_request', id, method: 'confirm', title, message };
}

export function fakePiNotify(id: string, message: string): FakePiRecord {
  return { type: 'extension_ui_request', id, method: 'notify', message, notifyType: 'info' };
}

export class FakePi extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  /** As on a real child, there is no pid once the process failed to start. */
  pid: number | undefined = 4242;
  /** Every record the client wrote, in order. */
  readonly received: FakePiCommand[] = [];
  readonly signals: NodeJS.Signals[] = [];
  /** Commands answered without a test having to. `prompt` only answers; events are scripted. */
  readonly handlers = new Map<string, FakePiHandler>([
    ['get_commands', () => ({ data: fakePiCommands() })],
    ['get_state', () => ({ data: fakePiState() })],
    ['prompt', () => ({ data: { disposition: 'started' } })],
  ]);
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
        if (line.trim()) this.receive(JSON.parse(line) as FakePiCommand);
        index = this.buffer.indexOf('\n');
      }
    });
    // Pi shuts down when its input ends (`rpc-mode.js`, `onInputEnd`).
    this.stdin.on('finish', () => this.exit(0, null));
  }

  /** Dies of the signal at once; its output stays open, for what a dying process still writes. */
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? 'SIGTERM');
    this.exit(null, signal ?? 'SIGTERM', { endOutput: false });
    return true;
  }

  /**
   * The process goes away on its own, as after a crash. As with a real child,
   * `exit` comes first and the end of stdout after it; with `endOutput: false`
   * the stream stays open until `endOutput()`, so a test can write what was
   * still unread when the process went.
   */
  exit(
    code: number | null,
    signal: NodeJS.Signals | null,
    options: { endOutput?: boolean } = {}
  ): void {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code, signal);
    if (options.endOutput ?? true) this.endOutput();
  }

  /** Ends stdout and stderr, as the pipes of a process that is gone close. */
  endOutput(): void {
    this.stdout.end();
    this.stderr.end();
  }

  /** The process could not be started: Node's `error` event on a child without a pid. */
  fail(error: Error): void {
    this.pid = undefined;
    this.emit('error', error);
  }

  /** A signal could not be sent to the running process: Node's `error` event, the pid kept. */
  failSignal(error: Error): void {
    this.emit('error', error);
  }

  /** Writes one record as a line. */
  emitRecord(record: FakePiRecord): void {
    this.stdout.write(`${JSON.stringify(record)}\n`);
  }

  emitRecords(records: readonly FakePiRecord[]): void {
    for (const record of records) this.emitRecord(record);
  }

  /** Writes bytes exactly as given: partial lines, noise, several lines at once. */
  emitRaw(data: string | Buffer): void {
    this.stdout.write(data);
  }

  respond(id: string | undefined, command: string, reply: Exclude<FakePiReply, undefined>): void {
    if ('error' in reply)
      this.emitRecord({ id, type: 'response', command, success: false, error: reply.error });
    else if (reply.data === undefined)
      this.emitRecord({ id, type: 'response', command, success: true });
    else this.emitRecord({ id, type: 'response', command, success: true, data: reply.data });
  }

  /** Resolves with the next record of `type` the client writes, or one already written. */
  waitFor(type: string): Promise<FakePiCommand> {
    const seen = this.received.find((command) => command.type === type);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve) => {
      const handler = (command: FakePiCommand) => {
        if (command.type !== type) return;
        this.off('command', handler);
        resolve(command);
      };
      this.on('command', handler);
    });
  }

  private receive(command: FakePiCommand): void {
    this.received.push(command);
    this.emit('command', command);
    if (command.type === 'extension_ui_response') return;
    const reply = this.handlers.get(command.type)?.(command);
    if (reply) this.respond(command.id, command.type, reply);
  }
}

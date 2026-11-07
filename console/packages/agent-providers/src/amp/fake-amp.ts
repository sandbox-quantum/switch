import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AMP_PLUGIN_ENDPOINT_VARIABLE, AMP_PLUGIN_TOKEN_VARIABLE } from './approval-plugin';
import type { AmpControlCommand, AmpToolDecision } from './plugin-bridge';

export type FakeAmpMessage = Record<string, unknown>;

/**
 * A stand-in for the `amp` child process: stream-JSON lines out, user
 * messages in, and the environment the adapter started it with, which is
 * where the plugin finds the adapter's endpoint and the session's token.
 *
 * Like the binary, it says nothing until its first user message, then
 * announces the thread it continues (`init`); input closing with no message
 * gets the same `init` and an error result, and the process stops.
 */
export class FakeAmp extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly received: FakeAmpMessage[] = [];
  readonly pid = 4242;
  killed: NodeJS.Signals | null = null;
  /** The thread the `init` line names: the one continued, unless a test says otherwise. */
  threadId: string;
  /** The mode the `init` line reports: the `--mode` given, else Amp's default. */
  agentMode: string;
  /** A run that never starts its thread, however long the adapter waits. */
  silent = false;
  private buffer = '';
  private exited = false;
  private started = false;

  constructor(
    readonly command: string,
    readonly args: string[],
    readonly options: { cwd?: string; env?: Record<string, string> }
  ) {
    super();
    this.threadId = args[0] === 'threads' && args[1] === 'continue' ? (args[2] ?? 'T-1') : 'T-1';
    const mode = args.indexOf('--mode');
    this.agentMode = mode >= 0 ? (args[mode + 1] ?? 'medium') : 'medium';
    this.stdin.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let index = this.buffer.indexOf('\n');
      while (index >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (line.trim()) {
          const message = JSON.parse(line) as FakeAmpMessage;
          this.received.push(message);
          if (message.type === 'user' && !this.started && !this.silent) this.init();
          this.emit('message', message);
        }
        index = this.buffer.indexOf('\n');
      }
    });
    this.stdin.on('finish', () => {
      if (!this.started && !this.silent) {
        this.init();
        this.send({
          type: 'result',
          subtype: 'error_during_execution',
          duration_ms: 2,
          is_error: true,
          num_turns: 0,
          error: 'No valid messages found in stdin',
          session_id: this.threadId,
        });
      }
      this.exit(0, null);
    });
  }

  get env(): Record<string, string> {
    return this.options.env ?? {};
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = signal ?? 'SIGTERM';
    this.exit(null, this.killed);
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code, signal);
  }

  send(message: FakeAmpMessage): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  /** The `init` line, as Amp prints it once the first message is in. */
  init(threadId = this.threadId, extra: FakeAmpMessage = {}): void {
    this.started = true;
    this.send({
      type: 'system',
      subtype: 'init',
      cwd: this.options.cwd ?? '/work',
      session_id: threadId,
      tools: [
        'shell_command',
        'shell_command_status',
        'create_file',
        'edit_file',
        'read_web_page',
        'web_search',
        'skill',
        'tool_search',
        'Task',
      ],
      mcp_servers: [],
      agent_mode: this.agentMode,
      subagents: [],
      ...extra,
    });
  }

  echoUser(text: string, threadId = this.threadId): void {
    this.send({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: threadId,
    });
  }

  assistant(
    content: FakeAmpMessage[],
    stopReason: string | null,
    options: { parent?: string | null; usage?: FakeAmpMessage; model?: string; id?: string } = {}
  ): void {
    this.send({
      type: 'assistant',
      message: {
        type: 'message',
        role: 'assistant',
        ...(options.id ? { id: options.id } : {}),
        ...(options.model ? { model: options.model } : {}),
        content,
        stop_reason: stopReason,
        ...(options.usage ? { usage: options.usage } : {}),
      },
      parent_tool_use_id: options.parent ?? null,
      session_id: this.threadId,
    });
  }

  toolResult(toolUseId: string, content: string, isError = false): void {
    this.send({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }],
      },
      parent_tool_use_id: null,
      session_id: this.threadId,
    });
  }

  /** Resolves with the next message written to stdin for which `predicate` holds. */
  next(predicate: (message: FakeAmpMessage) => boolean = () => true): Promise<FakeAmpMessage> {
    const seen = this.received.find(predicate);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve) => {
      const handler = (message: FakeAmpMessage) => {
        if (!predicate(message)) return;
        this.off('message', handler);
        resolve(message);
      };
      this.on('message', handler);
    });
  }
}

/**
 * What the Switch plugin inside Amp does, driven from a test: the same HTTP
 * calls to the adapter's loopback endpoint, with the session's token.
 */
export class FakePlugin {
  private readonly endpoint: string;
  private readonly token: string;

  constructor(amp: FakeAmp) {
    this.endpoint = amp.env[AMP_PLUGIN_ENDPOINT_VARIABLE] ?? '';
    this.token = amp.env[AMP_PLUGIN_TOKEN_VARIABLE] ?? '';
    if (!this.endpoint || !this.token)
      throw new Error('the fake amp was started without the plugin endpoint or token');
  }

  async post<T = Record<string, unknown>>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.endpoint}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      body: JSON.stringify(body),
    });
    if (!response.ok)
      throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
    return (await response.json()) as T;
  }

  ready(): Promise<unknown> {
    return this.post('/ready', {});
  }

  agentStart(message: string, threadId = 'T-1', messageId = 'm1'): Promise<unknown> {
    return this.post('/agent-start', { threadId, messageId, message });
  }

  agentEnd(status: 'done' | 'error' | 'cancelled', threadId = 'T-1', messageId = 'm1') {
    return this.post('/agent-end', { threadId, messageId, status });
  }

  /** One `tool.call` as the plugin runs it: asks, and asks again while the answer is pending. */
  async toolCall(call: {
    toolUseID: string;
    tool: string;
    input?: Record<string, unknown>;
    command?: string | null;
    threadId?: string;
  }): Promise<Exclude<AmpToolDecision, { status: 'pending' }>> {
    const body = {
      threadId: call.threadId ?? 'T-1',
      toolUseID: call.toolUseID,
      tool: call.tool,
      input: call.input ?? {},
      command: call.command ?? null,
    };
    let answer = await this.post<AmpToolDecision>('/tool-call', body);
    while (answer.status === 'pending')
      answer = await this.post<AmpToolDecision>('/tool-call/wait', { toolUseID: call.toolUseID });
    return answer;
  }

  /** One `tool.call` request, without asking again: what one HTTP round trip answers. */
  toolCallOnce(call: {
    toolUseID: string;
    tool: string;
    input?: Record<string, unknown>;
    command?: string | null;
  }) {
    return this.post<AmpToolDecision>('/tool-call', {
      threadId: 'T-1',
      toolUseID: call.toolUseID,
      tool: call.tool,
      input: call.input ?? {},
      command: call.command ?? null,
    });
  }

  control(): Promise<AmpControlCommand> {
    return this.post<AmpControlCommand>('/control', {});
  }

  cancelled(ok: boolean, error?: string, threadId = 'T-1'): Promise<unknown> {
    return this.post('/cancelled', { threadId, ok, error });
  }
}

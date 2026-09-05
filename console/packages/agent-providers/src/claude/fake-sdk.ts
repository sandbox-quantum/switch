import type {
  CanUseTool,
  Options,
  query as sdkQuery,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

/**
 * A scripted stand-in for the Claude Agent SDK, so the adapter's translation
 * and turn bookkeeping can be exercised without spending tokens. The two casts
 * below are the whole escape hatch: `Query` carries a dozen control methods the
 * adapter never calls, and the SDK message union is far wider than the handful
 * of frames these tests replay.
 */
export function asSdkMessage(value: Record<string, unknown>): SDKMessage {
  return value as unknown as SDKMessage;
}

export class FakeQuery {
  readonly sent: SDKUserMessage[] = [];
  readonly setModelCalls: Array<string | undefined> = [];
  interruptCount = 0;
  closed = false;

  private readonly outbox: SDKMessage[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  constructor(prompt: string | AsyncIterable<SDKUserMessage>) {
    if (typeof prompt !== 'string') void this.drain(prompt);
  }

  emit(message: Record<string, unknown>): void {
    this.outbox.push(asSdkMessage(message));
    this.wake?.();
    this.wake = null;
  }

  end(): void {
    this.ended = true;
    this.wake?.();
    this.wake = null;
  }

  /** Resolves once the adapter has pushed `count` messages into the prompt. */
  async waitForSent(count: number): Promise<SDKUserMessage[]> {
    for (let attempt = 0; attempt < 100 && this.sent.length < count; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    return this.sent;
  }

  interrupt(): Promise<undefined> {
    this.interruptCount += 1;
    return Promise.resolve(undefined);
  }

  setModel(model?: string): Promise<void> {
    this.setModelCalls.push(model);
    return Promise.resolve();
  }

  applyFlagSettings(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {
    this.closed = true;
    this.end();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    for (;;) {
      const next = this.outbox.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  private async drain(prompt: AsyncIterable<SDKUserMessage>): Promise<void> {
    for await (const message of prompt) this.sent.push(message);
  }
}

export interface FakeSdk {
  query: typeof sdkQuery;
  queries: FakeQuery[];
  latest(): FakeQuery;
  options(): Options;
  canUseTool(): CanUseTool;
}

/** Mirrors the CLI, which honours `sessionId` and echoes it back on `init`. */
export function createFakeSdk(): FakeSdk {
  const queries: FakeQuery[] = [];
  let captured: Options | undefined;

  const query: typeof sdkQuery = ({ prompt, options }) => {
    captured = options;
    const fake = new FakeQuery(prompt);
    queries.push(fake);
    fake.emit({
      type: 'system',
      subtype: 'init',
      session_id: options?.sessionId ?? options?.resume ?? 'unknown',
      model: 'claude-sonnet-5',
      tools: [],
      mcp_servers: [],
    });
    return fake as unknown as Query;
  };

  const latest = () => {
    const last = queries.at(-1);
    if (!last) throw new Error('No query has been started.');
    return last;
  };

  const options = () => {
    if (!captured) throw new Error('No query options were captured.');
    return captured;
  };

  const canUseTool = () => {
    const callback = options().canUseTool;
    if (!callback) throw new Error('The adapter did not register canUseTool.');
    return callback;
  };

  return { query, queries, latest, options, canUseTool };
}

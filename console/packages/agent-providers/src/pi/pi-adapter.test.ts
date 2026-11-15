import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderConversationUnavailableError,
  ProviderSessionError,
  type ProviderSessionStartInput,
  type RuntimeMode,
} from '../adapter';
import type { ProviderRuntimeEvent, ProviderRuntimeEventType } from '../events';
import { FAKE_PI_SESSION_ID, FakePi, type FakePiRecord } from './fake-pi';

const spawned: FakePi[] = [];
let prepare: ((pi: FakePi) => void) | undefined;

vi.mock('node:child_process', () => ({
  spawn: (_command: string, args: string[], options: { env: Record<string, string> }) => {
    const pi = new FakePi(args, options.env);
    prepare?.(pi);
    spawned.push(pi);
    return pi;
  },
}));

const { createPiAdapter, PI_COMMANDS } = await import('./pi-adapter');
const { PI_EXTENSION_SOURCE, PI_TOOL_CALL_DIALOG } = await import('./extension');
const { PI_SIGN_IN_REQUIRED } = await import('./sign-in');
const { PiRpcClient } = await import('./rpc-client');

const NATIVE = FAKE_PI_SESSION_ID;
const MODEL = { provider: 'mistral', model: 'devstral-medium-latest' };
const adapters: Array<ReturnType<typeof createPiAdapter>> = [];
let home: string;
let work: string;

beforeEach(async () => {
  spawned.length = 0;
  prepare = undefined;
  home = await mkdtemp(join(tmpdir(), 'pi-home-'));
  work = await realpath(await mkdtemp(join(tmpdir(), 'pi-work-')));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(adapters.splice(0).map((adapter) => adapter.stopAll()));
  // Pi saves its queue, compaction and retry settings commands to the user's
  // settings.json, so none of them is ever sent.
  for (const pi of spawned)
    for (const record of pi.received)
      if (record.type !== 'extension_ui_response') expect(PI_COMMANDS).toContain(record.type);
  await rm(home, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

function eventsOf<T extends ProviderRuntimeEventType>(
  events: ProviderRuntimeEvent[],
  type: T
): Array<Extract<ProviderRuntimeEvent, { type: T }>> {
  return events.filter(
    (event): event is Extract<ProviderRuntimeEvent, { type: T }> => event.type === type
  );
}

async function start(input: Partial<ProviderSessionStartInput> = {}) {
  const adapter = createPiAdapter();
  adapters.push(adapter);
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  const session = await adapter.startSession({
    sessionId: 's',
    cwd: work,
    runtimeMode: 'approval-required',
    env: { HOME: home },
    mcpServers: {},
    connectorMcpServers: [],
    ...input,
  });
  return { adapter, events, pi: spawned.at(-1)!, session };
}

async function startTurn(input: Partial<ProviderSessionStartInput> = {}) {
  const started = await start(input);
  await started.adapter.sendTurn({ sessionId: 's', turnId: 't1', text: 'go' });
  await flush();
  return started;
}

function assistant(content: unknown[], stopReason: string, input: number, errorMessage?: string) {
  return {
    role: 'assistant',
    content,
    api: 'mistral-conversations',
    provider: MODEL.provider,
    model: MODEL.model,
    usage: { input, output: 7, cacheRead: 2, cacheWrite: 0, totalTokens: input + 9 },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: 1762335000000,
  };
}

/** What the Switch extension sends before `toolName` runs. */
function askAbout(
  pi: FakePi,
  dialogId: string,
  toolName: string,
  input: Record<string, unknown>,
  toolCallId = `call-${dialogId}`
): void {
  pi.emitRecord({
    type: 'extension_ui_request',
    id: dialogId,
    method: 'confirm',
    title: PI_TOOL_CALL_DIALOG,
    message: JSON.stringify({ toolCallId, toolName, input }),
  });
}

function answers(pi: FakePi): FakePiRecord[] {
  return pi.received.filter((record) => record.type === 'extension_ui_response');
}

function sessionDir(pi: FakePi): string {
  return dirname(pi.args[pi.args.indexOf('-e') + 1]!);
}

/** What Pi 1.5.0 reports when no loaded extension connects MCP servers, as it loads them. */
function unconnected(pi: FakePi, extensionPath = join(sessionDir(pi), 'switch.js')): FakePiRecord {
  return {
    type: 'extension_error',
    extensionPath,
    event: 'register_mcp_server',
    error:
      'MCP server "switch" is registered, but no loaded extension connects MCP servers; another extension may have replaced the built-in MCP support',
  };
}

const SWITCH_MCP = {
  switch: { transport: 'http' as const, url: 'http://127.0.0.1:4000/mcp' },
};

describe('starting a session', () => {
  it('runs Pi in RPC mode with the Switch extension, its MCP servers and its context, from a directory of its own', async () => {
    const { pi, session, events } = await start({
      systemContext: 'Use the Switch tools.',
      model: { id: `${MODEL.provider}/${MODEL.model}` },
      mcpServers: {
        switch: {
          transport: 'http',
          url: 'http://127.0.0.1:4000/mcp',
          headers: { Authorization: 'Bearer $token' },
        },
        echo: { transport: 'stdio', command: '/node', args: ['/echo.mjs'], env: { SAY: '!date' } },
      },
    });
    const extension = pi.args[pi.args.indexOf('-e') + 1]!;
    const dir = dirname(extension);
    expect(basename(dir)).toMatch(/^switch-pi-/);
    expect(pi.args).toEqual([
      '--mode',
      'rpc',
      '-e',
      join(dir, 'switch.js'),
      '--append-system-prompt',
      join(dir, 'context.md'),
    ]);
    expect(pi.env).toEqual({ HOME: home, SWITCH_PI_SESSION: join(dir, 'session.json') });
    expect(await readFile(extension, 'utf8')).toBe(PI_EXTENSION_SOURCE);
    expect(JSON.parse(await readFile(join(dir, 'session.json'), 'utf8'))).toEqual({
      mcpServers: {
        switch: {
          url: 'http://127.0.0.1:4000/mcp',
          headers: { Authorization: 'Bearer $$token' },
          exposure: 'direct',
        },
        echo: { command: '/node', args: ['/echo.mjs'], env: { SAY: '$!date' }, exposure: 'direct' },
      },
    });
    expect(await readFile(join(dir, 'context.md'), 'utf8')).toBe('Use the Switch tools.');
    if (process.platform !== 'win32') {
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      for (const file of ['switch.js', 'session.json', 'context.md'])
        expect((await stat(join(dir, file))).mode & 0o777).toBe(0o600);
    }
    expect(pi.received.map((record) => record.type)).toEqual(['get_state', 'set_model']);
    expect(pi.commands('set_model')[0]).toMatchObject({
      provider: 'mistral',
      modelId: 'devstral-medium-latest',
    });
    expect(session.nativeSessionId).toBe(NATIVE);
    expect(events.map((event) => event.type)).toEqual([
      'session.state.changed',
      'session.started',
      'session.state.changed',
    ]);
    // Nothing of Pi's own configuration is written.
    expect(await readdir(home)).toEqual([]);
  });

  it('removes its directory once the session stops', async () => {
    const { adapter, events, pi } = await start();
    const dir = dirname(pi.args[pi.args.indexOf('-e') + 1]!);
    await adapter.stopSession('s');
    await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(eventsOf(events, 'session.exited')).toMatchObject([{ reason: 'Session stopped' }]);
    expect(adapter.hasSession('s')).toBe(false);
  });

  it('resumes a conversation Pi has saved for the directory', async () => {
    prepare = (pi) =>
      pi.answer('get_state', () => ({
        data: {
          model: { id: MODEL.model, provider: MODEL.provider },
          sessionId: NATIVE,
          messageCount: 4,
        },
      }));
    const { pi, session } = await start({ resume: { nativeSessionId: NATIVE } });
    expect(pi.args.slice(0, 4)).toEqual(['--mode', 'rpc', '--session-id', NATIVE]);
    expect(session.nativeSessionId).toBe(NATIVE);
  });

  it('asks for a fresh conversation when Pi has none to resume, leaving nothing behind', async () => {
    await expect(start({ resume: { nativeSessionId: NATIVE } })).rejects.toBeInstanceOf(
      ProviderConversationUnavailableError
    );
    const dir = dirname(spawned[0]!.args[spawned[0]!.args.indexOf('-e') + 1]!);
    await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('says how to sign in when Pi has no model it can use', async () => {
    // What Pi 1.5.0 answers with no credential: a placeholder model, on which
    // every prompt is refused with "No API key found for the selected model."
    prepare = (pi) =>
      pi.answer('get_state', () => ({
        data: {
          model: { id: 'unknown', name: 'unknown', api: 'unknown', provider: 'unknown' },
          sessionId: NATIVE,
          messageCount: 0,
        },
      }));
    await expect(start()).rejects.toThrow(PI_SIGN_IN_REQUIRED);
    expect(spawned[0]!.received.map((record) => record.type)).toEqual(['get_state']);
  });

  it('says what stopped Pi when it exits as it starts', async () => {
    prepare = (pi) => {
      pi.answer('get_state', () => null);
      pi.stderr.write('Failed to load extension "/tmp/x/switch.js": boom\n');
      pi.exit(1, null);
    };
    await expect(start()).rejects.toThrow(
      /Could not start Pi: .*code 1.*\n.*Failed to load extension/s
    );
  });

  it("passes on Pi's refusal of the chosen model", async () => {
    prepare = (pi) =>
      pi.answer('set_model', (command) => ({
        error: `Model not found: ${String(command.provider)}/${String(command.modelId)}`,
      }));
    await expect(start({ model: { id: 'mistral/no-such-model' } })).rejects.toThrow(
      'Model not found: mistral/no-such-model'
    );
  });

  it("refuses an MCP server that the user's Pi configuration would take for the session's", async () => {
    const agentDir = join(home, '.pi', 'agent');
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { switch: { command: 'my-switch' } } })
    );
    await expect(
      start({ mcpServers: { switch: { transport: 'http', url: 'http://127.0.0.1:4000/mcp' } } })
    ).rejects.toThrow(join(agentDir, 'mcp.json'));
    expect(spawned).toEqual([]);
  });

  it("refuses to start when nothing in Pi connects the session's MCP servers, leaving nothing behind", async () => {
    // Pi writes this as it loads its extensions, before it reads get_state:
    // its built-in MCP support is turned off ("-builtin:mcp") or replaced.
    prepare = (pi) => pi.emitRecord(unconnected(pi));
    await expect(start({ mcpServers: SWITCH_MCP })).rejects.toThrow(
      /\] Pi cannot connect the session's MCP servers, so the agent would have no Switch tools \(MCP server "switch" is registered, but no loaded extension connects MCP servers.*remove "-builtin:mcp"/
    );
    await expect(stat(sessionDir(spawned[0]!))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('stops a running session the same way, and only for its own servers', async () => {
    const { adapter, events, pi } = await startTurn({ mcpServers: SWITCH_MCP });
    pi.emitRecord(unconnected(pi, '/home/me/.pi/agent/extensions/other.ts'));
    await flush();
    expect(adapter.hasSession('s')).toBe(true);
    expect(eventsOf(events, 'runtime.warning')).toMatchObject([
      { message: expect.stringMatching(/^A Pi extension failed in register_mcp_server: /) },
    ]);
    pi.emitRecord(unconnected(pi));
    await vi.waitFor(() => expect(eventsOf(events, 'session.exited')).toHaveLength(1));
    const [error] = eventsOf(events, 'runtime.error');
    expect(error!.message).toMatch(/^Pi cannot connect the session's MCP servers/);
    expect(eventsOf(events, 'turn.completed')).toMatchObject([
      { outcome: 'error', message: error!.message },
    ]);
    expect(eventsOf(events, 'session.exited')).toMatchObject([{ reason: error!.message }]);
    await expect(stat(sessionDir(pi))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes its directory even when Pi does not stop, and says so', async () => {
    const { adapter, events, pi } = await start();
    vi.spyOn(PiRpcClient.prototype, 'dispose').mockRejectedValueOnce(
      new Error('Pi did not exit after termination.')
    );
    await expect(adapter.stopSession('s')).rejects.toThrow('Pi did not exit after termination.');
    await expect(stat(sessionDir(pi))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(eventsOf(events, 'session.exited')).toHaveLength(1);
    expect(adapter.hasSession('s')).toBe(false);
  });
});

describe('a turn', () => {
  it('streams the reply and ends when Pi settles, not when one of its runs ends', async () => {
    const { events, pi } = await startTurn();
    expect(pi.commands('prompt')).toMatchObject([{ message: 'go' }]);
    for (const record of [
      { type: 'agent_start' },
      { type: 'turn_start' },
      { type: 'message_end', message: assistant([], 'error', 120, '429 Too Many Requests') },
      { type: 'agent_end', messages: [], willRetry: true },
      {
        type: 'auto_retry_start',
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2000,
        errorMessage: '429 Too Many Requests',
      },
      { type: 'message_start', message: assistant([], 'pending', 0) },
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', delta: 'Greet.' },
      },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hel' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'lo' } },
      {
        type: 'message_end',
        message: assistant(
          [
            { type: 'thinking', thinking: 'Greet.' },
            { type: 'text', text: 'Hello' },
          ],
          'stop',
          130
        ),
      },
      { type: 'agent_end', messages: [], willRetry: false },
    ])
      pi.emitRecord(record);
    await flush();
    expect(eventsOf(events, 'turn.completed')).toEqual([]);
    pi.emitRecord({ type: 'agent_settled', aborted: false });
    await flush();
    expect(eventsOf(events, 'runtime.warning')).toMatchObject([
      { message: 'Pi is retrying a failed model call (attempt 1 of 3): 429 Too Many Requests' },
    ]);
    expect(
      eventsOf(events, 'content.delta')
        .map((event) => event.delta)
        .join('')
    ).toBe('Hello');
    expect(
      eventsOf(events, 'item.completed').map(({ item }) => [item.type, item.status, item.text])
    ).toEqual([
      ['reasoning', 'completed', 'Greet.'],
      ['assistant_message', 'completed', 'Hello'],
    ]);
    expect(eventsOf(events, 'turn.completed')).toMatchObject([
      {
        turnId: 't1',
        outcome: 'completed',
        usage: [
          {
            model: 'mistral/devstral-medium-latest',
            inputTokens: 250,
            outputTokens: 14,
            cacheReadTokens: 4,
            cacheWriteTokens: 0,
          },
        ],
      },
    ]);
  });

  it('ends with an error when its last model call failed', async () => {
    const { events, pi } = await startTurn();
    pi.emitRecord({ type: 'message_end', message: assistant([], 'error', 10, 'Invalid API key') });
    pi.emitRecord({ type: 'agent_settled', aborted: false });
    await flush();
    expect(eventsOf(events, 'turn.completed')).toMatchObject([
      { outcome: 'error', message: 'Invalid API key' },
    ]);
  });

  it('ends with an error when Pi refuses the prompt', async () => {
    prepare = (pi) => pi.answer('prompt', () => ({ error: 'Agent is already processing.' }));
    const { events } = await startTurn();
    expect(eventsOf(events, 'turn.completed')).toMatchObject([
      { outcome: 'error', message: 'Agent is already processing.' },
    ]);
  });

  it('sends images inline and names other attachments by path', async () => {
    const { adapter, pi } = await start();
    const image = join(work, 'shot.png');
    await writeFile(image, Buffer.from([137, 80, 78, 71]));
    await adapter.sendTurn({
      sessionId: 's',
      turnId: 't1',
      text: 'Look',
      attachments: [
        { path: image, mimeType: 'image/png' },
        { path: '/files/notes.pdf', mimeType: 'application/pdf' },
      ],
    });
    await vi.waitFor(() => expect(pi.commands('prompt')).toHaveLength(1));
    expect(pi.commands('prompt')).toMatchObject([
      {
        message: 'Look\n\nAttached files:\n- /files/notes.pdf',
        images: [{ type: 'image', data: 'iVBORw==', mimeType: 'image/png' }],
      },
    ]);
  });

  it('holds a message sent mid-turn until the turn settles', async () => {
    const { adapter, events, pi } = await startTurn();
    expect(await adapter.sendTurn({ sessionId: 's', turnId: 't2', text: 'next' })).toEqual({
      turnId: 't2',
    });
    await flush();
    expect(pi.commands('prompt')).toHaveLength(1);
    pi.emitRecord({ type: 'agent_settled', aborted: false });
    await flush();
    expect(pi.commands('prompt').map((command) => command.message)).toEqual(['go', 'next']);
    expect(eventsOf(events, 'turn.started').map((event) => event.turnId)).toEqual(['t1', 't2']);
  });

  it('answers what is still asked before it aborts, and ends interrupted', async () => {
    const { adapter, events, pi } = await startTurn();
    pi.emitRecord({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: '1\n2\n' },
    });
    askAbout(pi, 'd1', 'bash', { command: 'sleep 100' });
    await flush();
    pi.answer('abort', () => {
      pi.emitRecord({ type: 'agent_settled', aborted: true });
      return {};
    });
    await adapter.interruptTurn('s');
    await flush();
    expect(pi.received.slice(-2)).toMatchObject([
      { type: 'extension_ui_response', id: 'd1', cancelled: true },
      { type: 'abort' },
    ]);
    expect(eventsOf(events, 'request.resolved')).toMatchObject([{ decision: 'cancel' }]);
    expect(eventsOf(events, 'item.completed')).toMatchObject([
      { item: { type: 'assistant_message', status: 'failed', text: '1\n2\n' } },
    ]);
    expect(eventsOf(events, 'turn.completed')).toMatchObject([{ outcome: 'interrupted' }]);
  });

  it('ends interrupted once Pi is idle, even when no run was left to settle', async () => {
    const { adapter, events } = await startTurn();
    await adapter.interruptTurn('s');
    expect(eventsOf(events, 'turn.completed')).toMatchObject([{ outcome: 'interrupted' }]);
  });

  it('ends with an error when Pi exits mid-turn, with what was asked and queued, and refuses what follows', async () => {
    const { adapter, events, pi } = await startTurn();
    askAbout(pi, 'd1', 'bash', { command: 'make' });
    await adapter.sendTurn({ sessionId: 's', turnId: 't2', text: 'next' });
    await flush();
    const [request] = eventsOf(events, 'request.opened');
    pi.stderr.write('FATAL ERROR: JavaScript heap out of memory\n');
    pi.exit(1, null);
    await vi.waitFor(() => expect(eventsOf(events, 'session.exited')).toHaveLength(1));
    const reason = eventsOf(events, 'session.exited')[0]!.reason;
    expect(reason).toMatch(
      /^Pi exited \(code 1, signal null\): FATAL ERROR: JavaScript heap out of memory$/
    );
    expect(eventsOf(events, 'request.resolved')).toMatchObject([
      { requestId: request!.requestId, decision: 'cancel' },
    ]);
    expect(eventsOf(events, 'turn.started').map((event) => event.turnId)).toEqual(['t1']);
    expect(eventsOf(events, 'turn.completed')).toMatchObject([
      { turnId: 't1', outcome: 'error', message: reason },
      { turnId: 't2', outcome: 'error', message: reason },
    ]);
    expect(pi.commands('prompt')).toHaveLength(1);
    await vi.waitFor(() => expect(stat(sessionDir(pi))).rejects.toMatchObject({ code: 'ENOENT' }));
    await expect(
      adapter.sendTurn({ sessionId: 's', turnId: 't3', text: 'hi' })
    ).rejects.toBeInstanceOf(ProviderSessionError);
  });

  it('ends interrupted when Pi aborts the run itself', async () => {
    const { events, pi } = await startTurn();
    pi.emitRecord({ type: 'agent_settled', aborted: true });
    await flush();
    expect(eventsOf(events, 'turn.completed')).toMatchObject([
      { turnId: 't1', outcome: 'interrupted', message: 'Interrupted.' },
    ]);
  });

  it('ends a turn whose prompt an extension handled itself, as no run follows it', async () => {
    prepare = (pi) => pi.answer('prompt', () => ({ data: { disposition: 'handled' } }));
    const { events } = await startTurn();
    expect(eventsOf(events, 'turn.completed')).toMatchObject([
      { turnId: 't1', outcome: 'completed' },
    ]);
  });

  it('refuses a tool call asked about while the turn is being interrupted, even with full access', async () => {
    const { adapter, events, pi } = await startTurn({ runtimeMode: 'full-access' });
    pi.answer('abort', () => null);
    const interrupting = adapter.interruptTurn('s');
    askAbout(pi, 'd1', 'read', { path: 'README.md' });
    await flush();
    expect(answers(pi)).toEqual([{ type: 'extension_ui_response', id: 'd1', confirmed: false }]);
    pi.emitRecord({
      type: 'response',
      id: pi.commands('abort')[0]!.id,
      command: 'abort',
      success: true,
    });
    await interrupting;
    expect(eventsOf(events, 'turn.completed')).toMatchObject([{ outcome: 'interrupted' }]);
  });

  it('answers what is still asked before it stops Pi', async () => {
    const { adapter, events, pi } = await startTurn();
    askAbout(pi, 'd1', 'bash', { command: 'make' });
    await flush();
    await adapter.stopSession('s');
    expect(pi.received.at(-1)).toEqual({
      type: 'extension_ui_response',
      id: 'd1',
      cancelled: true,
    });
    expect(eventsOf(events, 'request.resolved')).toMatchObject([{ decision: 'cancel' }]);
    expect(eventsOf(events, 'turn.completed')).toMatchObject([
      { outcome: 'interrupted', message: 'Session stopped' },
    ]);
  });
});

describe('tool calls', () => {
  it('replays a turn Pi 1.5.0 ran with the Switch extension: a command it asks about, an MCP tool it does not', async () => {
    const { adapter, events, pi } = await startTurn({
      mcpServers: { echo: { transport: 'stdio', command: '/node', args: ['/echo.mjs'] } },
    });
    const bash = { command: 'echo recorded > out.txt', timeout: 5 };
    const echo = { text: 'RECORDED' };
    const usage = (input: number, output: number) => ({
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
    });
    const reply = (content: unknown[], stopReason: string, spent: ReturnType<typeof usage>) => ({
      role: 'assistant',
      content,
      api: 'mistral-conversations',
      provider: 'mistral',
      model: 'devstral-medium-latest',
      usage: spent,
      stopReason,
    });
    // Recorded from `pi --mode rpc -e switch.js` with Mistral's devstral-medium-latest,
    // trimmed to the fields the adapter reads.
    for (const record of [
      { type: 'agent_start' },
      { type: 'turn_start' },
      {
        type: 'message_end',
        message: reply(
          [
            { type: 'toolCall', id: 'fufda6MOZ', name: 'bash', arguments: bash },
            { type: 'toolCall', id: 'DOuiKxTiW', name: 'mcp__echo__switch_echo', arguments: echo },
          ],
          'toolUse',
          usage(1454, 39)
        ),
      },
      { type: 'tool_execution_start', toolCallId: 'fufda6MOZ', toolName: 'bash', args: bash },
      {
        type: 'extension_ui_request',
        id: 'ee88cea9-a85d-4532-a79d-2d7e93bbaa4d',
        method: 'confirm',
        title: 'switch:tool_call',
        message: JSON.stringify({ toolCallId: 'fufda6MOZ', toolName: 'bash', input: bash }),
      },
    ])
      pi.emitRecord(record);
    await flush();
    const [request] = eventsOf(events, 'request.opened');
    expect(request).toMatchObject({
      requestType: 'command_execution_approval',
      detail: 'echo recorded > out.txt',
    });
    await adapter.respondToRequest('s', request!.requestId, 'accept');
    for (const record of [
      {
        type: 'tool_execution_start',
        toolCallId: 'DOuiKxTiW',
        toolName: 'mcp__echo__switch_echo',
        args: echo,
      },
      {
        type: 'extension_ui_request',
        id: 'f2a2c036-14c0-4904-baf0-5f13ec9213f3',
        method: 'confirm',
        title: 'switch:tool_call',
        message: JSON.stringify({
          toolCallId: 'DOuiKxTiW',
          toolName: 'mcp__echo__switch_echo',
          input: echo,
        }),
      },
      {
        type: 'tool_execution_update',
        toolCallId: 'fufda6MOZ',
        toolName: 'bash',
        args: bash,
        partialResult: { content: [] },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'DOuiKxTiW',
        toolName: 'mcp__echo__switch_echo',
        result: { content: [{ type: 'text', text: 'RECORDED' }] },
        isError: false,
        durationMs: 13,
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'fufda6MOZ',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: '(no output)' }] },
        isError: false,
        durationMs: 19,
      },
      { type: 'turn_end' },
      { type: 'turn_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } },
      {
        type: 'message_update',
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: 'The echo tool returned ',
        },
      },
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'RECORDED' },
      },
      {
        type: 'message_end',
        message: reply(
          [{ type: 'text', text: 'The echo tool returned RECORDED' }],
          'stop',
          usage(1504, 31)
        ),
      },
      { type: 'agent_end', willRetry: false },
      { type: 'agent_settled', aborted: false },
    ])
      pi.emitRecord(record);
    await flush();
    expect(answers(pi)).toEqual([
      {
        type: 'extension_ui_response',
        id: 'ee88cea9-a85d-4532-a79d-2d7e93bbaa4d',
        confirmed: true,
      },
      {
        type: 'extension_ui_response',
        id: 'f2a2c036-14c0-4904-baf0-5f13ec9213f3',
        confirmed: true,
      },
    ]);
    expect(eventsOf(events, 'request.opened')).toHaveLength(1);
    expect(
      eventsOf(events, 'item.completed').map(({ item }) => [
        item.type,
        item.title,
        item.status,
        item.text,
      ])
    ).toEqual([
      ['mcp_tool_call', 'echo.switch_echo', 'completed', 'RECORDED'],
      ['command_execution', 'echo recorded > out.txt', 'completed', '(no output)'],
      [
        'assistant_message',
        'The echo tool returned RECORDED',
        'completed',
        'The echo tool returned RECORDED',
      ],
    ]);
    expect(eventsOf(events, 'turn.completed')).toMatchObject([
      {
        outcome: 'completed',
        usage: [
          {
            model: 'mistral/devstral-medium-latest',
            inputTokens: 2958,
            outputTokens: 70,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        ],
      },
    ]);
  });

  it('shows each as the kind of activity it is', async () => {
    const { events, pi } = await startTurn({
      mcpServers: { switch: { transport: 'http', url: 'http://127.0.0.1:4000/mcp' } },
    });
    const calls: Array<[string, Record<string, unknown>]> = [
      ['bash', { command: 'npm test\nnpm run lint' }],
      ['edit', { path: 'src/a.ts', edits: [{ oldText: 'a', newText: 'b' }] }],
      ['mcp__switch__send_message', { text: 'Done' }],
      ['read', { path: 'README.md' }],
    ];
    for (const [index, [toolName, args]] of calls.entries())
      pi.emitRecord({ type: 'tool_execution_start', toolCallId: `c${index}`, toolName, args });
    pi.emitRecord({
      type: 'tool_execution_update',
      toolCallId: 'c0',
      toolName: 'bash',
      partialResult: { content: [{ type: 'text', text: 'PASS 3 tests' }] },
    });
    pi.emitRecord({
      type: 'tool_execution_end',
      toolCallId: 'c0',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'Command exited with code 1' }] },
      isError: true,
    });
    // What Pi 1.5.0's edit tool returns (dist/core/tools/edit.js).
    const patch = '--- src/a.ts\n+++ src/a.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n';
    pi.emitRecord({
      type: 'tool_execution_end',
      toolCallId: 'c1',
      toolName: 'edit',
      result: {
        content: [{ type: 'text', text: 'Successfully replaced 1 block(s) in src/a.ts.' }],
        details: { diff: '-1 a\n+1 b', patch, firstChangedLine: 1 },
      },
      isError: false,
    });
    pi.emitRecord({
      type: 'tool_execution_end',
      toolCallId: 'c3',
      toolName: 'read',
      result: { content: [{ type: 'text', text: '# Project' }] },
      isError: false,
    });
    await flush();
    expect(
      eventsOf(events, 'item.started').map(({ item }) => [item.type, item.title, item.toolName])
    ).toEqual([
      ['command_execution', 'npm test', 'bash'],
      ['file_change', 'src/a.ts', 'edit'],
      ['mcp_tool_call', 'switch.send_message', 'send_message'],
      ['tool_call', 'read README.md', 'read'],
    ]);
    expect(eventsOf(events, 'item.updated')).toMatchObject([{ item: { text: 'PASS 3 tests' } }]);
    expect(
      eventsOf(events, 'item.completed').map(({ item }) => [item.id, item.status, item.text])
    ).toEqual([
      ['c0', 'failed', 'Command exited with code 1'],
      ['c1', 'completed', patch],
      ['c3', 'completed', '# Project'],
    ]);
  });

  describe('the approval each runtime mode asks for', () => {
    const MODES: RuntimeMode[] = ['approval-required', 'auto-accept-edits', 'auto', 'full-access'];
    const ASKS = (requestType: string) => [requestType, requestType, requestType, 'allow'];
    const ALLOWED = ['allow', 'allow', 'allow', 'allow'];
    const CALLS: Array<[string, Record<string, unknown>, string[]]> = [
      ['mcp__switch__send_message', { text: 'hi' }, ALLOWED],
      ['read', { path: 'README.md' }, ALLOWED],
      ['grep', { pattern: 'TODO' }, ALLOWED],
      ['codemode', { code: 'return 1' }, ALLOWED],
      [
        'edit',
        { path: 'src/a.ts', edits: [] },
        ['file_change_approval', 'allow', 'allow', 'allow'],
      ],
      [
        'write',
        { path: 'b.txt', content: 'x' },
        ['file_change_approval', 'allow', 'allow', 'allow'],
      ],
      ['bash', { command: 'ls' }, ASKS('command_execution_approval')],
      ['read_mcp_resource', { server: 'switch', uri: 'switch://room' }, ALLOWED],
      ['read_mcp_resource', { server: 'github', uri: 'repo://x' }, ASKS('mcp_tool_approval')],
      ['read_mcp_resource', { server: 'docs', uri: 'docs://x' }, ASKS('mcp_tool_approval')],
      ['mcp__github__create_issue', { title: 'x' }, ASKS('mcp_tool_approval')],
      ['mcp__docs__search', { query: 'x' }, ASKS('mcp_tool_approval')],
      ['web_fetch', { url: 'https://example.com' }, ASKS('tool_approval')],
    ];

    it.each(MODES.map((mode, index) => [mode, index] as const))('%s', async (mode, index) => {
      const { events, pi } = await startTurn({
        runtimeMode: mode,
        mcpServers: {
          switch: { transport: 'http', url: 'http://127.0.0.1:4000/mcp' },
          github: { transport: 'http', url: 'http://127.0.0.1:4001/mcp' },
        },
        connectorMcpServers: ['github'],
      });
      const outcomes: string[] = [];
      for (const [call, [toolName, input]] of CALLS.entries()) {
        const asked = eventsOf(events, 'request.opened').length;
        askAbout(pi, `d${call}`, toolName, input);
        await flush();
        const opened = eventsOf(events, 'request.opened').slice(asked);
        const answer = answers(pi).find((record) => record.id === `d${call}`);
        outcomes.push(opened[0]?.requestType ?? (answer?.confirmed === true ? 'allow' : 'neither'));
      }
      expect(outcomes).toEqual(CALLS.map(([, , expected]) => expected[index]));
    });
  });

  it('asks with the command, the file, and the connector tool and its input', async () => {
    const { events, pi } = await startTurn({
      mcpServers: { github: { transport: 'http', url: 'http://127.0.0.1:4001/mcp' } },
      connectorMcpServers: ['github'],
    });
    askAbout(pi, 'd1', 'bash', { command: 'npm publish' });
    askAbout(pi, 'd2', 'write', { path: 'src/new.ts', content: 'export {};' });
    askAbout(pi, 'd3', 'mcp__github__create_issue', { title: 'Flaky test' });
    await flush();
    expect(eventsOf(events, 'request.opened')).toMatchObject([
      {
        requestType: 'command_execution_approval',
        title: `Run a command in ${work}`,
        detail: 'npm publish',
        options: [
          { decision: 'accept', label: 'Approve' },
          { decision: 'acceptForSession', label: 'Approve for this session' },
          { decision: 'decline', label: 'Decline' },
          { decision: 'cancel', label: 'Cancel' },
        ],
      },
      { requestType: 'file_change_approval', title: 'Apply file changes', detail: 'src/new.ts' },
      {
        requestType: 'mcp_tool_approval',
        title: 'github wants to run create_issue',
        detail: '{"title":"Flaky test"}',
        connector: 'github',
      },
    ]);
  });

  it('answers each approval as decided, and remembers what is approved for the session', async () => {
    const { adapter, events, pi } = await startTurn();
    askAbout(pi, 'd1', 'bash', { command: 'make' });
    askAbout(pi, 'd2', 'bash', { command: 'rm -rf build' }, 'c2');
    askAbout(pi, 'd3', 'edit', { path: 'a.ts' });
    await flush();
    const [make, remove, edit] = eventsOf(events, 'request.opened');
    await adapter.respondToRequest('s', make!.requestId, 'acceptForSession');
    await adapter.respondToRequest('s', remove!.requestId, 'decline');
    await adapter.respondToRequest('s', edit!.requestId, 'accept');
    await flush();
    expect(answers(pi)).toEqual([
      { type: 'extension_ui_response', id: 'd1', confirmed: true },
      { type: 'extension_ui_response', id: 'd2', confirmed: false },
      { type: 'extension_ui_response', id: 'd3', confirmed: true },
    ]);
    expect(eventsOf(events, 'request.resolved').map((event) => event.decision)).toEqual([
      'acceptForSession',
      'decline',
      'accept',
    ]);
    askAbout(pi, 'd5', 'bash', { command: 'make' });
    askAbout(pi, 'd6', 'bash', { command: 'make install' });
    await flush();
    expect(answers(pi).at(-1)).toEqual({
      type: 'extension_ui_response',
      id: 'd5',
      confirmed: true,
    });
    expect(eventsOf(events, 'request.opened').at(-1)).toMatchObject({ detail: 'make install' });
    pi.emitRecord({
      type: 'tool_execution_end',
      toolCallId: 'c2',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'The user did not allow this tool call.' }] },
      isError: true,
    });
    await flush();
    expect(eventsOf(events, 'item.completed')).toMatchObject([
      { item: { id: 'c2', type: 'command_execution', status: 'declined' } },
    ]);
    await expect(adapter.respondToRequest('s', make!.requestId, 'accept')).rejects.toThrow(
      'No pending approval'
    );
    expect(eventsOf(events, 'turn.completed')).toEqual([]);
  });

  it('stops the turn when an approval is cancelled, blocking its call and closing the others', async () => {
    const { adapter, events, pi } = await startTurn();
    askAbout(pi, 'd1', 'bash', { command: 'make' });
    askAbout(pi, 'd2', 'bash', { command: 'make test' });
    await flush();
    const [first, second] = eventsOf(events, 'request.opened');
    await adapter.respondToRequest('s', first!.requestId, 'cancel');
    expect(pi.received.slice(-3)).toEqual([
      { type: 'extension_ui_response', id: 'd1', cancelled: true },
      { type: 'extension_ui_response', id: 'd2', cancelled: true },
      expect.objectContaining({ type: 'abort' }),
    ]);
    expect(
      eventsOf(events, 'request.resolved').map((event) => [event.requestId, event.decision])
    ).toEqual([
      [first!.requestId, 'cancel'],
      [second!.requestId, 'cancel'],
    ]);
    expect(eventsOf(events, 'turn.completed')).toMatchObject([{ outcome: 'interrupted' }]);
  });

  it('remembers a connector tool or another tool approved for the session by its name', async () => {
    const { adapter, events, pi } = await startTurn({
      mcpServers: { github: { transport: 'http', url: 'http://127.0.0.1:4001/mcp' } },
      connectorMcpServers: ['github'],
    });
    askAbout(pi, 'd1', 'mcp__github__create_issue', { title: 'a' });
    askAbout(pi, 'd2', 'web_fetch', { url: 'https://example.com/a' });
    await flush();
    const [issue, fetch] = eventsOf(events, 'request.opened');
    await adapter.respondToRequest('s', issue!.requestId, 'acceptForSession');
    await adapter.respondToRequest('s', fetch!.requestId, 'acceptForSession');
    askAbout(pi, 'd3', 'mcp__github__create_issue', { title: 'b' });
    askAbout(pi, 'd4', 'web_fetch', { url: 'https://example.com/b' });
    askAbout(pi, 'd5', 'mcp__github__close_issue', { number: 1 });
    await flush();
    expect(answers(pi).slice(2)).toEqual([
      { type: 'extension_ui_response', id: 'd3', confirmed: true },
      { type: 'extension_ui_response', id: 'd4', confirmed: true },
    ]);
    expect(eventsOf(events, 'request.opened').at(-1)).toMatchObject({
      title: 'github wants to run close_issue',
      connector: 'github',
    });
  });

  it('takes a tool for the server with the longest matching prefix', async () => {
    const { events, pi } = await startTurn({
      mcpServers: {
        ...SWITCH_MCP,
        switch__gh: { transport: 'http', url: 'http://127.0.0.1:4001/mcp' },
      },
      connectorMcpServers: ['switch__gh'],
    });
    askAbout(pi, 'd1', 'mcp__switch__gh__create_issue', { title: 'x' });
    askAbout(pi, 'd2', 'mcp__switch__send_message', { text: 'hi' });
    await flush();
    expect(eventsOf(events, 'request.opened')).toMatchObject([
      { title: 'switch__gh wants to run create_issue', connector: 'switch__gh' },
    ]);
    expect(answers(pi)).toEqual([{ type: 'extension_ui_response', id: 'd2', confirmed: true }]);
  });

  it("asks before another server's resource is read, and not before one of the session's own", async () => {
    const { adapter, events, pi } = await startTurn({
      mcpServers: {
        ...SWITCH_MCP,
        github: { transport: 'http', url: 'http://127.0.0.1:4001/mcp' },
      },
      connectorMcpServers: ['github'],
    });
    askAbout(pi, 'd1', 'read_mcp_resource', { server: 'switch', uri: 'switch://room' });
    askAbout(pi, 'd2', 'read_mcp_resource', { server: 'github', uri: 'repo://a/b/README.md' });
    await flush();
    expect(answers(pi)).toEqual([{ type: 'extension_ui_response', id: 'd1', confirmed: true }]);
    const [read] = eventsOf(events, 'request.opened');
    expect(read).toMatchObject({
      requestType: 'mcp_tool_approval',
      title: 'github wants to share one of its resources',
      detail: 'repo://a/b/README.md',
      connector: 'github',
    });
    await adapter.respondToRequest('s', read!.requestId, 'acceptForSession');
    askAbout(pi, 'd3', 'read_mcp_resource', { server: 'github', uri: 'repo://a/b/LICENSE' });
    await flush();
    expect(answers(pi).at(-1)).toEqual({
      type: 'extension_ui_response',
      id: 'd3',
      confirmed: true,
    });
    // A server from the user's own Pi configuration, whose tools ask too.
    askAbout(pi, 'd4', 'read_mcp_resource', { server: 'docs', uri: 'docs://guide' });
    await flush();
    const opened = eventsOf(events, 'request.opened');
    expect(opened).toHaveLength(2);
    expect(opened[1]).toMatchObject({
      title: 'docs wants to share one of its resources',
      detail: 'docs://guide',
    });
    expect(opened[1]).not.toHaveProperty('connector');
  });

  it('reports an answer Pi cannot take, and leaves the approval open', async () => {
    const { adapter, events, pi } = await startTurn();
    askAbout(pi, 'd1', 'bash', { command: 'make' });
    await flush();
    const [request] = eventsOf(events, 'request.opened');
    pi.stdin.end();
    await expect(adapter.respondToRequest('s', request!.requestId, 'accept')).rejects.toThrow(
      /Pi did not take the answer to approval .*: Pi input is closed/
    );
    expect(eventsOf(events, 'request.resolved')).toEqual([]);
    await vi.waitFor(() => expect(eventsOf(events, 'session.exited')).toHaveLength(1));
    expect(eventsOf(events, 'request.resolved')).toMatchObject([
      { requestId: request!.requestId, decision: 'cancel' },
    ]);
  });

  it('refuses a tool call outside a turn, or one it cannot read, which it warns of', async () => {
    const { adapter, events, pi } = await start({ runtimeMode: 'full-access' });
    askAbout(pi, 'd1', 'read', { path: 'README.md' });
    await flush();
    await adapter.sendTurn({ sessionId: 's', turnId: 't1', text: 'go' });
    pi.emitRecord({
      type: 'extension_ui_request',
      id: 'd2',
      method: 'confirm',
      title: PI_TOOL_CALL_DIALOG,
      message: '{"toolName":',
    });
    await flush();
    expect(answers(pi)).toEqual([
      { type: 'extension_ui_response', id: 'd1', confirmed: false },
      { type: 'extension_ui_response', id: 'd2', confirmed: false },
    ]);
    expect(eventsOf(events, 'runtime.warning').map((event) => event.message)).toEqual([
      'Pi asked about a tool call Switch could not read, so the call was blocked.',
    ]);
  });

  it("dismisses another extension's dialog, which nobody could answer, and says so", async () => {
    const { events, pi } = await startTurn();
    pi.emitRecord({
      type: 'extension_ui_request',
      id: 'x1',
      method: 'select',
      title: 'Allow dangerous command?',
      options: ['Allow', 'Block'],
    });
    pi.emitRecord({ type: 'extension_ui_request', id: 'x2', method: 'notify', message: 'Saved' });
    pi.emitRecord({
      type: 'extension_ui_request',
      id: 'x3',
      method: 'notify',
      message: 'MCP server docs failed to connect',
      notifyType: 'error',
    });
    await flush();
    expect(answers(pi)).toEqual([{ type: 'extension_ui_response', id: 'x1', cancelled: true }]);
    expect(eventsOf(events, 'runtime.warning').map((event) => event.message)).toEqual([
      'A Pi extension asked "Allow dangerous command?", which a Switch session cannot answer, so it was dismissed.',
      'Pi: MCP server docs failed to connect',
    ]);
  });
});

describe('compaction', () => {
  it("runs Pi's own, and never during a turn", async () => {
    prepare = (pi) =>
      pi.answer('compact', () => ({ data: { summary: 'Fixed the parser.', tokensBefore: 90000 } }));
    const { adapter, pi } = await start();
    await adapter.compactSession('s');
    expect(pi.commands('compact')).toHaveLength(1);
    await adapter.sendTurn({ sessionId: 's', turnId: 't1', text: 'go' });
    await expect(adapter.compactSession('s')).rejects.toThrow('SESSION_BUSY');
    expect(pi.commands('compact')).toHaveLength(1);
  });

  it('shows a compaction Pi runs on its own in a turn, and how it ended', async () => {
    const { adapter, events, pi } = await startTurn();
    // One that succeeds, one that fails, one aborted, and one still running when the turn settles.
    pi.emitRecord({ type: 'compaction_start', reason: 'threshold' });
    await flush();
    expect(eventsOf(events, 'item.started')).toMatchObject([
      {
        turnId: 't1',
        item: {
          type: 'context_compaction',
          status: 'in_progress',
          title: 'Context compaction',
          payload: { reason: 'threshold' },
        },
      },
    ]);
    const started = eventsOf(events, 'item.started')[0]!.item.id;
    pi.emitRecord({
      type: 'compaction_end',
      reason: 'threshold',
      result: {
        summary: 'Fixed the parser.',
        firstKeptEntryId: 'e7',
        tokensBefore: 150_000,
        estimatedTokensAfter: 32_000,
        usage: {},
        details: {},
      },
      aborted: false,
      willRetry: false,
    });
    pi.emitRecord({ type: 'compaction_start', reason: 'overflow' });
    pi.emitRecord({
      type: 'compaction_end',
      reason: 'overflow',
      aborted: false,
      willRetry: false,
      errorMessage: 'Context overflow recovery failed: 429 Too Many Requests',
    });
    pi.emitRecord({ type: 'compaction_start', reason: 'threshold' });
    pi.emitRecord({ type: 'compaction_end', reason: 'threshold', aborted: true, willRetry: false });
    pi.emitRecord({ type: 'compaction_start', reason: 'threshold' });
    await flush();
    pi.emitRecord({ type: 'agent_settled', aborted: false });
    await flush();
    const compactions = eventsOf(events, 'item.completed').map(({ item }) => item);
    expect(compactions[0]).toMatchObject({
      id: started,
      status: 'completed',
      payload: { reason: 'threshold', tokensBefore: 150_000, estimatedTokensAfter: 32_000 },
    });
    expect(compactions[0]).not.toHaveProperty('text');
    expect(compactions.map((item) => [item.type, item.status, item.text])).toEqual([
      ['context_compaction', 'completed', undefined],
      ['context_compaction', 'failed', 'Context overflow recovery failed: 429 Too Many Requests'],
      ['context_compaction', 'failed', 'The compaction was aborted.'],
      // Still running when the turn settled.
      ['context_compaction', 'failed', undefined],
    ]);
    expect(new Set(compactions.map((item) => item.id)).size).toBe(4);
    expect(eventsOf(events, 'turn.completed')).toMatchObject([{ outcome: 'completed' }]);
    // The next turn starts with none running.
    await adapter.sendTurn({ sessionId: 's', turnId: 't2', text: 'next' });
    await flush();
    pi.emitRecord({ type: 'compaction_start', reason: 'threshold' });
    pi.emitRecord({ type: 'agent_settled', aborted: false });
    await flush();
    const next = [
      ...eventsOf(events, 'item.started'),
      ...eventsOf(events, 'item.completed'),
    ].filter((event) => event.turnId === 't2');
    expect(next.map((event) => [event.type, event.item.status])).toEqual([
      ['item.started', 'in_progress'],
      ['item.completed', 'failed'],
    ]);
    expect(next[1]!.item.id).toBe(next[0]!.item.id);
  });

  it('leaves the compaction Console asks for to compactSession, outside any turn', async () => {
    prepare = (pi) =>
      pi.answer('compact', () => {
        pi.emitRecord({ type: 'compaction_start', reason: 'manual' });
        pi.emitRecord({
          type: 'compaction_end',
          reason: 'manual',
          result: { summary: 'Fixed the parser.', tokensBefore: 90_000 },
          aborted: false,
          willRetry: false,
        });
        return { data: { summary: 'Fixed the parser.', tokensBefore: 90_000 } };
      });
    const { adapter, events } = await start();
    await adapter.compactSession('s');
    await flush();
    expect(eventsOf(events, 'item.started')).toEqual([]);
    expect(eventsOf(events, 'item.completed')).toEqual([]);
  });
});

describe('context usage', () => {
  it("is Pi's own estimate, and unknown when Pi does not know it", async () => {
    let tokens: number | null = 12_345;
    prepare = (pi) =>
      pi.answer('get_session_stats', () => ({
        data: { sessionId: NATIVE, contextUsage: { tokens, contextWindow: 262_144, percent: 4.7 } },
      }));
    const { adapter } = await start();
    expect(await adapter.contextUsage('s')).toEqual({ usedTokens: 12_345, windowTokens: 262_144 });
    tokens = null;
    expect(await adapter.contextUsage('s')).toBeNull();
  });
});

describe('models', () => {
  it('lists the models Pi can use as provider/id, and selects one by its provider and id', async () => {
    prepare = (pi) =>
      pi.answer('get_available_models', () => ({
        data: {
          models: [
            {
              id: 'devstral-medium-latest',
              name: 'Devstral Medium',
              provider: 'mistral',
              input: ['text'],
            },
            {
              id: 'pixtral-large-latest',
              name: 'Pixtral Large',
              provider: 'mistral',
              input: ['text', 'image'],
            },
          ],
        },
      }));
    const { adapter, pi } = await start();
    expect(await adapter.listModels('s')).toEqual([
      {
        id: 'mistral/devstral-medium-latest',
        label: 'mistral: Devstral Medium',
        options: {},
        imageInput: false,
      },
      {
        id: 'mistral/pixtral-large-latest',
        label: 'mistral: Pixtral Large',
        options: {},
        imageInput: true,
      },
    ]);
    await adapter.setModel('s', { id: 'openrouter/qwen/qwen3-coder' });
    expect(pi.commands('set_model').at(-1)).toMatchObject({
      provider: 'openrouter',
      modelId: 'qwen/qwen3-coder',
    });
    await expect(adapter.setModel('s', { id: 'devstral' })).rejects.toThrow(
      'Pi names models provider/model'
    );
  });
});

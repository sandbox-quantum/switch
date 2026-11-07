import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProviderConversationUnavailableError, type ProviderSessionStartInput } from '../adapter';
import { EventRecorder } from '../testing/event-recorder';
import { PI_EXTENSION_SOURCE, PI_SESSION_ENV, PI_TOOL_CALL } from './extension';
import { type FakePi, fakePiTransport } from './fake-pi';
import { createPiAdapter } from './pi-adapter';
import type { PiResponse } from './rpc-client';

let cwd: string;
let home: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'pi-adapter-cwd-'));
  home = await mkdtemp(join(tmpdir(), 'pi-adapter-home-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

const TOKEN = ['Bearer ', 'tok', '$en'].join('');

async function start(
  overrides: Partial<ProviderSessionStartInput> = {},
  options: { ready?: boolean; readyTimeoutMs?: number; respond?: FakePi['respond'] } = {}
) {
  const transport = fakePiTransport({ ready: options.ready ?? true });
  const adapter = createPiAdapter({
    transport: (launch, handlers) => {
      const pi = transport.factory(launch, handlers) as FakePi;
      if (options.respond) pi.respond = options.respond;
      return pi;
    },
    readyTimeoutMs: options.readyTimeoutMs ?? 1000,
  });
  const recorder = new EventRecorder(adapter);
  const input: ProviderSessionStartInput = {
    sessionId: 'session-1',
    cwd,
    runtimeMode: 'approval-required',
    env: { HOME: home, PATH: '/usr/bin' },
    mcpServers: {
      switch: {
        transport: 'http',
        url: 'http://127.0.0.1:1/mcp',
        headers: { Authorization: TOKEN },
      },
    },
    connectorMcpServers: [],
    systemContext: 'The Switch skill.',
    ...overrides,
  };
  const started = adapter.startSession(input);
  return { adapter, recorder, transport, input, started };
}

async function running(
  overrides: Partial<ProviderSessionStartInput> = {},
  options: Parameters<typeof start>[1] = {}
) {
  const setup = await start(overrides, options);
  await setup.started;
  const pi = setup.transport.last();
  await setup.adapter.sendTurn({ sessionId: 'session-1', turnId: 'turn-1', text: 'Hello' });
  return { ...setup, pi };
}

function ask(
  pi: FakePi,
  uiId: string,
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
  annotations: Record<string, boolean> | null = null
): void {
  pi.emit({ type: 'tool_execution_start', toolCallId, toolName, args: input });
  pi.emit({
    type: 'extension_ui_request',
    id: uiId,
    method: 'select',
    title: JSON.stringify({ switch: PI_TOOL_CALL, toolCallId, toolName, input, annotations }),
    options: ['allow', 'block'],
  });
}

function answer(pi: FakePi, uiId: string): Record<string, unknown> | undefined {
  return pi.sent('extension_ui_response').find((response) => response.id === uiId);
}

describe('starting a session', () => {
  it('starts Pi in RPC mode with the extension and the system context, and keeps the tokens off its command line', async () => {
    const { started, transport, recorder } = await start();
    const session = await started;
    const { launch } = transport.last();
    expect(launch.args.slice(0, 3)).toEqual(['--mode', 'rpc', '-e']);
    expect(await readFile(launch.args[3]!, 'utf8')).toBe(PI_EXTENSION_SOURCE);
    const prompt = launch.args[launch.args.indexOf('--append-system-prompt') + 1]!;
    expect(await readFile(prompt, 'utf8')).toBe('The Switch skill.');
    expect(launch.args).not.toContain('--session-id');
    expect(launch.args).toContain('--no-approve');
    expect(launch.args.join(' ')).not.toContain('tok');
    expect(JSON.parse(launch.env[PI_SESSION_ENV]!)).toEqual({
      mcpServers: {
        switch: {
          url: 'http://127.0.0.1:1/mcp',
          headers: { Authorization: 'Bearer tok$$en' },
          exposure: 'direct',
        },
      },
    });
    expect(session.nativeSessionId).toBe('pi-session-1');
    expect(recorder.ofType('session.started')[0]?.nativeSessionId).toBe('pi-session-1');
  });

  it('removes the folder it wrote the extension to when the session ends', async () => {
    const { adapter, started, transport } = await start();
    await started;
    const extension = transport.last().launch.args[3]!;
    expect(existsSync(extension)).toBe(true);
    await adapter.stopSession('session-1');
    expect(transport.last().disposed).toBe(true);
    await expect.poll(() => existsSync(extension)).toBe(false);
    expect(adapter.hasSession('session-1')).toBe(false);
  });

  it('resumes the conversation by its Pi session id', async () => {
    const { started, transport } = await start(
      { resume: { nativeSessionId: 'pi-old' } },
      {
        respond: (command) =>
          command.type === 'get_state'
            ? { success: true, data: { sessionId: 'pi-old', messageCount: 12 } }
            : { success: true, data: { models: [] } },
      }
    );
    expect((await started).nativeSessionId).toBe('pi-old');
    const { args } = transport.last().launch;
    expect(args.slice(args.indexOf('--session-id'), args.indexOf('--session-id') + 2)).toEqual([
      '--session-id',
      'pi-old',
    ]);
  });

  it('refuses to resume a conversation Pi no longer has, rather than starting it empty', async () => {
    const { adapter, started, transport } = await start({ resume: { nativeSessionId: 'pi-gone' } });
    await expect(started).rejects.toBeInstanceOf(ProviderConversationUnavailableError);
    expect(transport.last().disposed).toBe(true);
    expect(adapter.hasSession('session-1')).toBe(false);
  });

  it('refuses to start on the placeholder model Pi falls back to when signed out', async () => {
    const { started, transport } = await start(
      {},
      {
        respond: (command) =>
          command.type === 'get_state'
            ? {
                success: true,
                data: {
                  sessionId: 'pi-session-1',
                  messageCount: 0,
                  model: { id: 'unknown', provider: 'unknown', input: [] },
                },
              }
            : { success: true, data: { models: [] } },
      }
    );
    await expect(started).rejects.toThrow(/not signed in to any model provider.*\/login/s);
    expect(transport.last().disposed).toBe(true);
  });

  it('does not start until the extension says its gate is in place', async () => {
    const { started, transport } = await start({}, { ready: false, readyTimeoutMs: 50 });
    await expect(started).rejects.toThrow(/Switch extension did not start within 50 ms/);
    expect(transport.last().disposed).toBe(true);
  });

  it('says what Pi wrote when it exits before starting', async () => {
    const { started, transport } = await start({}, { ready: false });
    await expect.poll(() => transport.started).toHaveLength(1);
    const pi = transport.last();
    pi.stderr = 'Error: Failed to load extension "switch-session.js"';
    pi.exit('Pi exited (code 1, signal null)');
    await expect(started).rejects.toThrow(/code 1[\s\S]*Failed to load extension/);
  });

  it('refuses a session whose server a Pi mcp.json would replace, and changes no file', async () => {
    const config = join(home, '.pi', 'agent', 'mcp.json');
    await mkdir(join(home, '.pi', 'agent'), { recursive: true });
    const text = JSON.stringify({ mcpServers: { switch: { url: 'https://example.com/mcp' } } });
    await writeFile(config, text);
    const { started, transport } = await start();
    await expect(started).rejects.toThrow(/defines an MCP server named "switch"/);
    expect(transport.started).toHaveLength(0);
    expect(await readFile(config, 'utf8')).toBe(text);
  });

  it('starts beside an mcp.json entry that only turns a server of its own off', async () => {
    await mkdir(join(cwd, '.pi'), { recursive: true });
    await writeFile(
      join(cwd, '.pi', 'mcp.json'),
      JSON.stringify({ mcpServers: { switch: { enabled: false } } })
    );
    const { started } = await start();
    await expect(started).resolves.toMatchObject({ nativeSessionId: 'pi-session-1' });
  });

  it('applies the chosen model and its thinking level', async () => {
    const { started, transport } = await start({
      model: { id: 'google/gemini-2.5-flash', options: { effort: 'high' } },
    });
    await started;
    const pi = transport.last();
    expect(pi.sent('set_model')[0]).toMatchObject({
      provider: 'google',
      modelId: 'gemini-2.5-flash',
    });
    expect(pi.sent('set_thinking_level')[0]).toMatchObject({ level: 'high' });
  });

  it("lists Pi's models by provider, with thinking levels for those that reason", async () => {
    const { adapter, started } = await start();
    await started;
    const models = await adapter.listModels('session-1');
    expect(models.map((model) => model.id)).toEqual(['google/gemini-2.5-flash', 'faux/scripted']);
    expect(models[0]).toMatchObject({ imageInput: true, options: { effort: expect.any(Array) } });
    expect(models[1]?.options).toEqual({});
  });
});

describe('turns', () => {
  it('streams the reply and ends the turn when Pi settles, with the tokens it spent', async () => {
    const { pi, recorder } = await running();
    expect(pi.sent('prompt')[0]).toMatchObject({ message: 'Hello' });
    pi.emit({ type: 'agent_start' });
    pi.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    for (const delta of ['Hel', 'lo'])
      pi.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } });
    pi.emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
        provider: 'google',
        model: 'gemini-2.5-flash',
        stopReason: 'stop',
        usage: { input: 10, output: 2, cacheRead: 30, cacheWrite: 4 },
      },
    });
    // A run's end is not the turn's: Pi may go on to retry, compact or a queued message.
    pi.emit({ type: 'agent_end', messages: [], willRetry: false });
    expect(recorder.ofType('turn.completed')).toHaveLength(0);
    pi.emit({ type: 'agent_settled', aborted: false });
    const done = await recorder.waitFor(
      'turn.completed',
      (event) => event.turnId === 'turn-1',
      100
    );
    expect(done.outcome).toBe('completed');
    expect(done.usage).toEqual([
      {
        model: 'google/gemini-2.5-flash',
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 30,
        cacheWriteTokens: 4,
      },
    ]);
    expect(recorder.assistantText('turn-1')).toContain('Hello');
  });

  it('opens no message for an empty delta, as Gemini sends before a tool call', async () => {
    const { pi, recorder } = await running({ runtimeMode: 'full-access' });
    pi.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    pi.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '' } });
    pi.emit({
      type: 'message_end',
      message: { role: 'assistant', content: [], stopReason: 'toolUse' },
    });
    pi.emit({ type: 'agent_settled', aborted: false });
    await recorder.waitFor('turn.completed', () => true, 100);
    const messages = (type: 'item.started' | 'item.completed') =>
      recorder.ofType(type).filter((event) => event.item.type === 'assistant_message');
    expect(messages('item.started')).toEqual([]);
    expect(messages('item.completed')).toEqual([]);
  });

  it('joins a message sent mid-turn to the running turn', async () => {
    const { adapter, pi, recorder } = await running();
    const second = await adapter.sendTurn({
      sessionId: 'session-1',
      turnId: 'turn-2',
      text: 'Also this',
    });
    expect(second).toEqual({ turnId: 'turn-2', steeredInto: 'turn-1' });
    expect(pi.sent('prompt')[1]).toMatchObject({
      message: 'Also this',
      streamingBehavior: 'steer',
    });
    pi.emit({ type: 'agent_settled', aborted: false });
    expect(recorder.ofType('turn.started').map((event) => event.turnId)).toEqual(['turn-1']);
    expect(recorder.ofType('turn.completed').map((event) => event.turnId)).toEqual(['turn-1']);
  });

  it('keeps the turn open for the run a mid-turn message starts when Pi settled just before it arrived', async () => {
    let release: (response: PiResponse) => void = () => {};
    const { adapter, pi, recorder } = await running();
    pi.respond = (command) =>
      command.type === 'prompt'
        ? new Promise<PiResponse>((resolve) => (release = resolve))
        : { success: true };
    const second = adapter.sendTurn({
      sessionId: 'session-1',
      turnId: 'turn-2',
      text: 'Also this',
    });
    await expect.poll(() => pi.sent('prompt')).toHaveLength(2);
    pi.emit({ type: 'agent_settled', aborted: false });
    release({ success: true, data: { disposition: 'started' } });
    await second;
    expect(recorder.ofType('turn.completed')).toHaveLength(0);
    pi.emit({ type: 'agent_settled', aborted: false });
    expect(recorder.ofType('turn.completed').map((event) => event.turnId)).toEqual(['turn-1']);
  });

  it("ends the turn with Pi's reason when it refuses the message", async () => {
    const { recorder } = await running(
      {},
      {
        respond: (command) =>
          command.type === 'prompt'
            ? { success: false, error: 'No API key found for the selected model.' }
            : { success: true, data: { sessionId: 'pi-session-1' } },
      }
    );
    const done = await recorder.waitFor('turn.completed', () => true, 100);
    expect(done).toMatchObject({
      outcome: 'error',
      message: 'No API key found for the selected model.',
    });
  });

  it("ends the turn as an error when the model's response failed, and keeps the session", async () => {
    const { adapter, pi, recorder } = await running();
    pi.emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: '429 quota exceeded',
      },
    });
    pi.emit({ type: 'agent_settled', aborted: false });
    const done = await recorder.waitFor('turn.completed', () => true, 100);
    expect(done).toMatchObject({ outcome: 'error', message: '429 quota exceeded' });
    // A model that failed one turn, after Pi's own retries, leaves Pi itself
    // running: the session takes the next message rather than faulting.
    expect(recorder.ofType('session.state.changed').at(-1)).toMatchObject({ status: 'ready' });
    expect(recorder.ofType('runtime.error').at(-1)).toMatchObject({
      message: '429 quota exceeded',
    });
    await adapter.sendTurn({ sessionId: 'session-1', turnId: 'turn-2', text: 'Again' });
    await expect.poll(() => pi.sent('prompt')).toHaveLength(2);
  });

  it('sends images the model accepts and names other attachments in the text', async () => {
    const image = join(cwd, 'shot.png');
    await writeFile(image, Buffer.from([1, 2, 3]));
    const { adapter, started, transport } = await start({
      model: { id: 'google/gemini-2.5-flash' },
    });
    await started;
    await adapter.sendTurn({
      sessionId: 'session-1',
      turnId: 'turn-1',
      text: 'Look',
      attachments: [
        { path: image, mimeType: 'image/png' },
        { path: '/tmp/spec.pdf', mimeType: 'application/pdf' },
      ],
    });
    const prompt = transport.last().sent('prompt')[0]!;
    expect(prompt.images).toEqual([{ type: 'image', data: 'AQID', mimeType: 'image/png' }]);
    expect(prompt.message).toBe('Look\n\nAttached file (application/pdf): /tmp/spec.pdf');
  });
});

describe('tool calls', () => {
  it('asks the room before a command runs, and runs it once allowed', async () => {
    const { adapter, pi, recorder } = await running();
    ask(pi, 'ui-1', 'call-1', 'bash', { command: 'rm -rf build' });
    const request = await recorder.waitFor('request.opened', () => true, 100);
    expect(request).toMatchObject({
      turnId: 'turn-1',
      requestType: 'command_execution_approval',
      title: 'Run a command',
      detail: 'rm -rf build',
      options: [
        { decision: 'accept', label: 'Allow once' },
        { decision: 'acceptForSession', label: 'Allow for this session' },
        { decision: 'decline', label: 'Decline' },
      ],
    });
    expect(answer(pi, 'ui-1')).toBeUndefined();
    await adapter.respondToRequest('session-1', request.requestId, 'accept');
    expect(answer(pi, 'ui-1')).toEqual({
      type: 'extension_ui_response',
      id: 'ui-1',
      value: 'allow',
    });
    expect(recorder.ofType('request.resolved')[0]).toMatchObject({ decision: 'accept' });
  });

  it('blocks a declined call and shows it as declined', async () => {
    const { adapter, pi, recorder } = await running();
    ask(pi, 'ui-1', 'call-1', 'write', { path: 'notes.md', content: 'x' });
    const request = await recorder.waitFor('request.opened', () => true, 100);
    expect(request).toMatchObject({ requestType: 'file_change_approval', detail: 'notes.md' });
    await adapter.respondToRequest('session-1', request.requestId, 'decline');
    expect(answer(pi, 'ui-1')).toMatchObject({ value: 'block' });
    pi.emit({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'write',
      result: { content: [{ type: 'text', text: 'Declined in Switch.' }] },
      isError: true,
    });
    const item = await recorder.waitFor(
      'item.completed',
      (event) => event.item.id === 'call-1',
      100
    );
    expect(item.item).toMatchObject({
      type: 'file_change',
      status: 'declined',
      title: 'write notes.md',
    });
  });

  it('stops asking about a tool someone allowed for the session', async () => {
    const { adapter, pi, recorder } = await running();
    ask(pi, 'ui-1', 'call-1', 'bash', { command: 'make' });
    const request = await recorder.waitFor('request.opened', () => true, 100);
    await adapter.respondToRequest('session-1', request.requestId, 'acceptForSession');
    ask(pi, 'ui-2', 'call-2', 'bash', { command: 'make test' });
    expect(answer(pi, 'ui-2')).toMatchObject({ value: 'allow' });
    expect(recorder.ofType('request.opened')).toHaveLength(1);
  });

  it("never asks about the session's own MCP tools, and asks about a connector's", async () => {
    const { pi, recorder } = await running({
      mcpServers: {
        switch: { transport: 'http', url: 'http://127.0.0.1:1/mcp' },
        'git-hub': { transport: 'http', url: 'http://127.0.0.1:2/mcp' },
      },
      connectorMcpServers: ['git-hub'],
    });
    ask(pi, 'ui-1', 'call-1', 'mcp__switch__send_message', { text: 'hi' });
    expect(answer(pi, 'ui-1')).toMatchObject({ value: 'allow' });
    ask(pi, 'ui-2', 'call-2', 'mcp__git_hub__create_issue', { title: 'Bug' });
    const request = await recorder.waitFor('request.opened', () => true, 100);
    expect(request).toMatchObject({
      requestType: 'mcp_tool_approval',
      connector: 'git-hub',
      title: 'git-hub wants to run create_issue',
      detail: '{"title":"Bug"}',
    });
    expect(answer(pi, 'ui-2')).toBeUndefined();
  });

  it('asks about nothing in full access', async () => {
    const { pi, recorder } = await running({ runtimeMode: 'full-access' });
    ask(pi, 'ui-1', 'call-1', 'bash', { command: 'rm -rf build' });
    expect(answer(pi, 'ui-1')).toMatchObject({ value: 'allow' });
    expect(recorder.ofType('request.opened')).toHaveLength(0);
  });

  it('runs edits without asking in auto-accept-edits, and still asks about commands', async () => {
    const { pi, recorder } = await running({ runtimeMode: 'auto-accept-edits' });
    ask(pi, 'ui-1', 'call-1', 'edit', { path: 'a.ts', edits: [] });
    expect(answer(pi, 'ui-1')).toMatchObject({ value: 'allow' });
    ask(pi, 'ui-2', 'call-2', 'bash', { command: 'ls' });
    await recorder.waitFor('request.opened', () => true, 100);
    expect(answer(pi, 'ui-2')).toBeUndefined();
  });

  it('lets read-only tools run without asking', async () => {
    const { pi, recorder } = await running({ runtimeMode: 'auto' });
    ask(pi, 'ui-1', 'call-1', 'read', { path: 'README.md' });
    ask(pi, 'ui-2', 'call-2', 'mcp__docs__search', { q: 'x' }, { readOnlyHint: true });
    ask(
      pi,
      'ui-3',
      'call-3',
      'mcp__docs__purge',
      { q: 'x' },
      { readOnlyHint: true, destructiveHint: true }
    );
    expect(answer(pi, 'ui-1')).toMatchObject({ value: 'allow' });
    expect(answer(pi, 'ui-2')).toMatchObject({ value: 'allow' });
    expect(answer(pi, 'ui-3')).toBeUndefined();
    expect(recorder.ofType('request.opened')).toHaveLength(1);
  });

  it('blocks a tool call that comes when no turn is running', async () => {
    const { started, transport } = await start({ runtimeMode: 'full-access' });
    await started;
    const pi = transport.last();
    ask(pi, 'ui-1', 'call-1', 'bash', { command: 'curl example.com' });
    expect(answer(pi, 'ui-1')).toEqual({
      type: 'extension_ui_response',
      id: 'ui-1',
      cancelled: true,
    });
  });

  it('cancels a question from another extension that Switch cannot show, and says so', async () => {
    const { pi, recorder } = await running();
    pi.emit({
      type: 'extension_ui_request',
      id: 'ui-9',
      method: 'confirm',
      title: 'Clear session?',
    });
    expect(answer(pi, 'ui-9')).toEqual({
      type: 'extension_ui_response',
      id: 'ui-9',
      cancelled: true,
    });
    const warning = await recorder.waitFor('runtime.warning', () => true, 100);
    expect(warning.message).toContain('Clear session?');
  });

  it('shows a command as its command line, with its output and exit code', async () => {
    const { pi, recorder } = await running({ runtimeMode: 'full-access' });
    ask(pi, 'ui-1', 'call-1', 'bash', { command: 'echo hi\necho there' });
    const item = await recorder.waitFor('item.started', (event) => event.item.id === 'call-1', 100);
    expect(item.item).toMatchObject({
      type: 'command_execution',
      title: 'echo hi',
      status: 'in_progress',
    });
    pi.emit({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'bash',
      result: {
        content: [{ type: 'text', text: 'hi\nthere\n' }],
        structuredContent: { exit_code: 0 },
      },
      isError: false,
    });
    const done = await recorder.waitFor(
      'item.completed',
      (event) => event.item.id === 'call-1',
      100
    );
    expect(done.item).toMatchObject({
      status: 'completed',
      text: 'hi\nthere\n',
      payload: { exitCode: 0 },
    });
  });
});

describe('interrupting a turn', () => {
  it('clears the queue and cancels the waiting approvals before it aborts, which Pi would otherwise wait on', async () => {
    const { adapter, pi, recorder } = await running();
    ask(pi, 'ui-1', 'call-1', 'bash', { command: 'sleep 100' });
    await recorder.waitFor('request.opened', () => true, 100);
    await adapter.interruptTurn('session-1');
    expect(
      pi.written
        .map((record) => record.type)
        .filter((type) => ['clear_queue', 'extension_ui_response', 'abort'].includes(type))
    ).toEqual(['clear_queue', 'extension_ui_response', 'abort']);
    expect(answer(pi, 'ui-1')).toMatchObject({ cancelled: true });
    expect(recorder.ofType('request.resolved')[0]).toMatchObject({ decision: 'cancel' });
    pi.emit({ type: 'agent_settled', aborted: true });
    const done = await recorder.waitFor('turn.completed', () => true, 100);
    expect(done.outcome).toBe('interrupted');
  });
});

describe('Pi going away', () => {
  it('fails the running turn and ends the session', async () => {
    const { adapter, pi, recorder } = await running();
    pi.exit('Pi exited (code 1, signal null)');
    const done = await recorder.waitFor('turn.completed', () => true, 100);
    expect(done).toMatchObject({ outcome: 'error', message: 'Pi exited (code 1, signal null)' });
    await recorder.waitFor('session.exited', () => true, 100);
    expect(adapter.hasSession('session-1')).toBe(false);
  });
});

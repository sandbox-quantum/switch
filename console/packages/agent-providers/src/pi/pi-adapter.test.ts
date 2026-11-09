import { existsSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderConversationUnavailableError, type RuntimeMode } from '../adapter';
import type { ProviderRuntimeEvent, ProviderRuntimeEventType } from '../events';
import { PI_APPROVAL_PREFIX, PI_EXTENSION_SOURCE, PI_SESSION_ENV } from './extension';
import { FakePi } from './fake-pi';

const processes: FakePi[] = [];
let state: Record<string, unknown> = {};
let stderr = '';

vi.mock('node:child_process', () => ({
  spawn: (_command: string, args: string[], options: { env: Record<string, string> }) => {
    const pi = new FakePi();
    pi.spawnArgs = args;
    pi.spawnEnv = options.env;
    pi.answer('get_state', () => state);
    if (stderr) pi.stderr.write(stderr);
    processes.push(pi);
    return pi;
  },
}));

const { createPiAdapter, PI_SIGN_IN_REQUIRED } = await import('./pi-adapter');

const SIGNED_IN = { model: { id: 'gemini-2.5-flash', provider: 'google' }, messageCount: 0 };

function eventsOf<T extends ProviderRuntimeEventType>(
  events: ProviderRuntimeEvent[],
  type: T
): Array<Extract<ProviderRuntimeEvent, { type: T }>> {
  return events.filter(
    (event): event is Extract<ProviderRuntimeEvent, { type: T }> => event.type === type
  );
}

async function start(
  runtimeMode: RuntimeMode = 'full-access',
  extra: Record<string, unknown> = {}
) {
  const adapter = createPiAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  const session = await adapter.startSession({
    sessionId: 'session-1',
    cwd: '/work',
    runtimeMode,
    env: { PATH: '/usr/bin', SWITCH_TOKEN: 'secret' },
    mcpServers: {},
    connectorMcpServers: [],
    ...extra,
  });
  const pi = processes.at(-1);
  if (!pi) throw new Error('fake pi was not spawned');
  return { adapter, events, pi, session };
}

/** Lets the adapter read what the fake wrote, and answer it. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

function argAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function runningTurn(
  runtimeMode: RuntimeMode = 'full-access',
  extra: Record<string, unknown> = {}
) {
  const started = await start(runtimeMode, extra);
  await started.adapter.sendTurn({ sessionId: 'session-1', turnId: 'turn-1', text: 'hello' });
  return started;
}

function approval(pi: FakePi, ask: Record<string, unknown>, id = 'ui-1') {
  pi.send({
    type: 'extension_ui_request',
    id,
    method: 'select',
    title: `${PI_APPROVAL_PREFIX}${JSON.stringify(ask)}`,
    options: ['accept', 'acceptForSession', 'decline'],
  });
}

describe('PiAdapter', () => {
  beforeEach(() => {
    processes.length = 0;
    state = SIGNED_IN;
    stderr = '';
  });

  it('starts pi in RPC mode on a session id of its own, with the Switch extension', async () => {
    const { pi, session } = await start('approval-required', {
      model: { id: 'google/gemini-2.5-flash' },
    });
    const args = pi.spawnArgs;
    expect(args.slice(0, 2)).toEqual(['--mode', 'rpc']);
    expect(argAfter(args, '--session-id')).toBe(session.nativeSessionId);
    expect(session.nativeSessionId).toMatch(/^switch-[0-9a-f-]{36}$/);
    expect(args).toContain('--no-approve');
    expect(argAfter(args, '--model')).toBe('google/gemini-2.5-flash');
    const extension = argAfter(args, '-e');
    expect(extension && readFileSync(extension, 'utf8')).toBe(PI_EXTENSION_SOURCE);
  });

  it('hands the extension its settings, with each server converted, and nothing else changed in the environment', async () => {
    const { pi } = await start('approval-required', {
      mcpServers: {
        switch: {
          transport: 'stdio',
          command: 'node',
          args: ['mcp.js'],
          envVars: ['SWITCH_TOKEN'],
        },
        jira: { transport: 'http', url: 'https://mcp.example.test/mcp', headers: { A: 'b' } },
      },
      connectorMcpServers: ['jira'],
    });
    const { [PI_SESSION_ENV]: settings, ...env } = pi.spawnEnv;
    expect(env).toEqual({ PATH: '/usr/bin', SWITCH_TOKEN: 'secret' });
    expect(JSON.parse(settings ?? '')).toEqual({
      runtimeMode: 'approval-required',
      mcpServers: {
        switch: { command: 'node', args: ['mcp.js'], env: { SWITCH_TOKEN: 'secret' } },
        jira: { url: 'https://mcp.example.test/mcp', headers: { A: 'b' } },
      },
      connectorMcpServers: ['jira'],
    });
  });

  it('appends the system context from a file in the session directory, removed when the session stops', async () => {
    const { adapter, pi } = await start('full-access', {
      systemContext: 'You are in room #general.',
    });
    const context = argAfter(pi.spawnArgs, '--append-system-prompt');
    expect(context && readFileSync(context, 'utf8')).toBe('You are in room #general.');
    await adapter.stopSession('session-1');
    expect(context && existsSync(context)).toBe(false);
  });

  it('resumes by the native session id it was given', async () => {
    state = { ...SIGNED_IN, messageCount: 4 };
    const { pi, session } = await start('full-access', {
      resume: { nativeSessionId: 'switch-saved' },
    });
    expect(argAfter(pi.spawnArgs, '--session-id')).toBe('switch-saved');
    expect(session.nativeSessionId).toBe('switch-saved');
  });

  it('refuses to resume a conversation pi no longer has, rather than starting a fresh one', async () => {
    stderr =
      "Warning: No project session found with id 'switch-saved'; creating a new session with that id.\n";
    await expect(
      start('full-access', { resume: { nativeSessionId: 'switch-saved' } })
    ).rejects.toBeInstanceOf(ProviderConversationUnavailableError);
    expect(processes.at(-1)?.stdin.writableEnded).toBe(true);
  });

  it('fails to start, saying how to sign in, when pi has no model to run', async () => {
    state = { model: { id: 'unknown', provider: 'unknown' } };
    await expect(start()).rejects.toThrow(PI_SIGN_IN_REQUIRED);
  });

  it('warns that auto mode asks as approval-required does', async () => {
    const { events } = await start('auto');
    expect(eventsOf(events, 'runtime.warning')[0]?.message).toMatch(/no automatic review/);
  });

  it('streams a turn and completes it on agent_settled, with its usage', async () => {
    const { events, pi } = await runningTurn();
    expect(pi.sent('prompt')[0]).toMatchObject({ message: 'hello' });
    pi.send({ type: 'agent_start' });
    pi.send({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'Hi ' },
    });
    pi.send({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'there' },
    });
    pi.send({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi there' }],
        provider: 'google',
        model: 'gemini-2.5-flash',
        stopReason: 'stop',
        usage: { input: 10, output: 3, cacheRead: 2, cacheWrite: 0 },
      },
    });
    pi.send({ type: 'agent_end', messages: [] });
    pi.send({ type: 'agent_settled', aborted: false });
    await tick();
    expect(eventsOf(events, 'turn.started').map((e) => e.turnId)).toEqual(['turn-1']);
    expect(
      eventsOf(events, 'content.delta')
        .map((e) => e.delta)
        .join('')
    ).toBe('Hi there');
    const message = eventsOf(events, 'item.completed').find(
      (e) => e.item.type === 'assistant_message'
    );
    expect(message?.item.text).toBe('Hi there');
    const done = eventsOf(events, 'turn.completed');
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({
      turnId: 'turn-1',
      outcome: 'completed',
      usage: [
        {
          model: 'google/gemini-2.5-flash',
          inputTokens: 10,
          outputTokens: 3,
          cacheReadTokens: 2,
          cacheWriteTokens: 0,
        },
      ],
    });
  });

  it('keeps the turn running past agent_end, which retries and queued messages can follow', async () => {
    const { events, pi } = await runningTurn();
    pi.send({ type: 'agent_end', messages: [], willRetry: true });
    await tick();
    expect(eventsOf(events, 'turn.completed')).toHaveLength(0);
  });

  it('completes a turn whose failed model call pi retried successfully', async () => {
    const { events, pi } = await runningTurn();
    pi.send({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: '503 high demand',
      },
    });
    pi.send({
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 3,
      errorMessage: '503 high demand',
    });
    pi.send({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop' },
    });
    pi.send({ type: 'agent_settled', aborted: false });
    await tick();
    expect(eventsOf(events, 'runtime.warning').at(-1)?.message).toMatch(/retrying the model call/);
    expect(eventsOf(events, 'turn.completed')[0]?.outcome).toBe('completed');
  });

  it('fails a turn whose last model call failed, saying why', async () => {
    const { events, pi } = await runningTurn();
    pi.send({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: '429 quota exceeded',
      },
    });
    pi.send({ type: 'agent_settled', aborted: false });
    await tick();
    expect(eventsOf(events, 'turn.completed')[0]).toMatchObject({
      outcome: 'error',
      message: '429 quota exceeded',
    });
  });

  it('steers a message sent mid-turn into the running turn', async () => {
    const { adapter, pi } = await runningTurn();
    const result = await adapter.sendTurn({
      sessionId: 'session-1',
      turnId: 'turn-2',
      text: 'stop now',
    });
    expect(result).toEqual({ turnId: 'turn-2', steeredInto: 'turn-1' });
    expect(pi.sent('steer')[0]).toMatchObject({ message: 'stop now' });
    expect(pi.sent('prompt')).toHaveLength(1);
  });

  it('switches the model before the turn that asks for another', async () => {
    const { adapter, pi } = await start('full-access', {
      model: { id: 'google/gemini-2.5-flash' },
    });
    await adapter.setModel('session-1', { id: 'openai/gpt-x' });
    await adapter.sendTurn({ sessionId: 'session-1', turnId: 'turn-1', text: 'hi' });
    expect(pi.sent('set_model')[0]).toMatchObject({ provider: 'openai', modelId: 'gpt-x' });
    const order = pi.received.map((record) => record.type);
    expect(order.indexOf('set_model')).toBeLessThan(order.indexOf('prompt'));
  });

  it('lists the models pi holds a credential for, by provider and id', async () => {
    const { adapter, pi } = await start();
    pi.answer('get_available_models', {
      models: [
        {
          id: 'gemini-2.5-flash',
          name: 'Gemini 2.5 Flash',
          provider: 'google',
          input: ['text', 'image'],
        },
      ],
    });
    expect(await adapter.listModels('session-1')).toEqual([
      { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash', options: {}, imageInput: true },
    ]);
  });

  it('reports tool calls by what they are', async () => {
    const { events, pi } = await runningTurn();
    pi.send({
      type: 'tool_execution_start',
      toolCallId: 'a',
      toolName: 'bash',
      args: { command: 'ls' },
    });
    pi.send({
      type: 'tool_execution_start',
      toolCallId: 'b',
      toolName: 'write',
      args: { path: 'x.txt' },
    });
    pi.send({
      type: 'tool_execution_start',
      toolCallId: 'c',
      toolName: 'mcp__switch__post',
      args: {},
    });
    pi.send({ type: 'tool_execution_start', toolCallId: 'd', toolName: 'grep', args: {} });
    pi.send({
      type: 'tool_execution_end',
      toolCallId: 'a',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'file.txt' }] },
      isError: false,
    });
    await tick();
    expect(eventsOf(events, 'item.started').map((e) => [e.item.type, e.item.title])).toEqual([
      ['command_execution', 'ls'],
      ['file_change', 'x.txt'],
      ['mcp_tool_call', 'mcp__switch__post'],
      ['tool_call', 'grep'],
    ]);
    expect(eventsOf(events, 'item.completed')[0]?.item).toMatchObject({
      status: 'completed',
      text: 'file.txt',
    });
  });

  it("opens the extension's approval as a request, and accepts it", async () => {
    const { adapter, events, pi } = await runningTurn('approval-required');
    approval(pi, {
      kind: 'command',
      toolName: 'bash',
      toolCallId: 'call-1',
      detail: 'rm -rf build',
    });
    await tick();
    const request = eventsOf(events, 'request.opened')[0];
    expect(request).toMatchObject({
      turnId: 'turn-1',
      requestType: 'command_execution_approval',
      detail: 'rm -rf build',
    });
    expect(request?.options.map((option) => option.decision)).toEqual([
      'accept',
      'acceptForSession',
      'decline',
    ]);
    await adapter.respondToRequest('session-1', request?.requestId ?? '', 'acceptForSession');
    expect(pi.sent('extension_ui_response')).toEqual([
      { type: 'extension_ui_response', id: 'ui-1', value: 'acceptForSession' },
    ]);
    expect(eventsOf(events, 'request.resolved')[0]?.decision).toBe('acceptForSession');
  });

  it('declines an approval, and reports the blocked call as declined', async () => {
    const { adapter, events, pi } = await runningTurn('approval-required');
    pi.send({
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'bash',
      args: { command: 'ls' },
    });
    approval(pi, { kind: 'command', toolName: 'bash', toolCallId: 'call-1', detail: 'ls' });
    await tick();
    const request = eventsOf(events, 'request.opened')[0];
    await adapter.respondToRequest('session-1', request?.requestId ?? '', 'decline');
    pi.send({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'bash',
      result: { content: [] },
      isError: true,
    });
    await tick();
    expect(pi.sent('extension_ui_response')[0]).toEqual({
      type: 'extension_ui_response',
      id: 'ui-1',
      value: 'decline',
    });
    expect(eventsOf(events, 'item.completed')[0]?.item.status).toBe('declined');
  });

  it('names the connector an MCP approval is for', async () => {
    const { events, pi } = await runningTurn('approval-required');
    approval(pi, {
      kind: 'mcp',
      toolName: 'mcp__jira__create',
      toolCallId: 'call-1',
      server: 'jira',
    });
    await tick();
    expect(eventsOf(events, 'request.opened')[0]).toMatchObject({
      requestType: 'mcp_tool_approval',
      connector: 'jira',
    });
  });

  it("dismisses a dialog from the person's own extension, and says so", async () => {
    const { events, pi } = await runningTurn();
    pi.send({ type: 'extension_ui_request', id: 'other', method: 'confirm', title: 'Deploy?' });
    await tick();
    expect(pi.sent('extension_ui_response')).toEqual([
      { type: 'extension_ui_response', id: 'other', cancelled: true },
    ]);
    expect(eventsOf(events, 'runtime.warning').at(-1)?.message).toMatch(/Deploy\?/);
    expect(eventsOf(events, 'request.opened')).toHaveLength(0);
  });

  it('interrupts: cancels the approval pi waits on, then aborts, and the turn ends interrupted', async () => {
    const { adapter, events, pi } = await runningTurn('approval-required');
    approval(pi, { kind: 'command', toolName: 'bash', toolCallId: 'call-1', detail: 'sleep 100' });
    await tick();
    await adapter.interruptTurn('session-1');
    expect(pi.sent('extension_ui_response')[0]).toEqual({
      type: 'extension_ui_response',
      id: 'ui-1',
      cancelled: true,
    });
    expect(pi.sent('abort')).toHaveLength(1);
    pi.send({ type: 'agent_settled', aborted: true });
    await tick();
    expect(eventsOf(events, 'request.resolved')[0]?.decision).toBe('cancel');
    expect(eventsOf(events, 'turn.completed')[0]?.outcome).toBe('interrupted');
  });

  it('fails the running turn and ends the session when pi exits', async () => {
    const { adapter, events, pi } = await runningTurn();
    pi.exit(1, null);
    await tick();
    expect(eventsOf(events, 'turn.completed')[0]).toMatchObject({ outcome: 'error' });
    expect(eventsOf(events, 'session.exited')).toHaveLength(1);
    expect(adapter.hasSession('session-1')).toBe(false);
  });

  it('stops: closes stdin and ends the session', async () => {
    const { adapter, events, pi } = await start();
    await adapter.stopSession('session-1');
    expect(pi.stdin.writableEnded).toBe(true);
    expect(eventsOf(events, 'session.exited')[0]?.reason).toBe('stopped by Switch');
    expect(adapter.hasSession('session-1')).toBe(false);
  });

  it('asks no questions', async () => {
    const { adapter } = await start();
    expect(adapter.capabilities.userInput).toBe(false);
    await expect(adapter.respondToUserInput('session-1', 'q-1', {})).rejects.toThrow(
      /asks no questions/
    );
  });
});

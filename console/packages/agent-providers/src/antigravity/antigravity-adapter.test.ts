import type * as fs from 'node:fs/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  mkdir: async () => undefined,
  writeFile: async () => undefined,
  realpath: async (path: string) => path,
}));
const servers: FakeAppServer[] = [];
vi.mock('node:child_process', () => ({
  spawn: () => {
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      agentCapabilities: { sessionCapabilities: { resume: {} } },
    }));
    server.replyAlways('authenticate', () => ({}));
    server.replyAlways('session/new', () => ({
      sessionId: 'native',
      configOptions: [
        { id: 'model', type: 'select', options: [{ value: 'model-a', name: 'Model A' }] },
      ],
    }));
    server.replyAlways('session/resume', () => ({}));
    server.replyAlways('session/set_mode', () => ({}));
    server.replyAlways('session/set_config_option', () => ({}));
    servers.push(server);
    return server;
  },
}));
const { createAntigravityAdapter } = await import('./antigravity-adapter');
beforeEach(() => {
  servers.length = 0;
});
async function setup(resume = false, switchRegistered = true) {
  const adapter = createAntigravityAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  const session = await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: 'approval-required',
    env: {},
    mcpServers: switchRegistered
      ? {
          switch: {
            transport: 'stdio',
            command: 'node',
            args: ['server.js'],
            env: { MODE: 'test' },
          },
        }
      : {},
    ...(resume ? { resume: { nativeSessionId: 'acp:native' } } : {}),
  });
  const server = servers.at(-1)!;
  return { adapter, events, server, session };
}
afterEach(() => {
  for (const server of servers) server.kill();
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

it('registers session MCP servers and resumes the exact native session', async () => {
  const { server, session } = await setup(true);
  expect(session.nativeSessionId).toBe('acp:native');
  expect(server.received.find((m) => m.method === 'session/resume')?.params).toMatchObject({
    sessionId: 'native',
    mcpServers: [
      {
        name: 'switch',
        command: 'node',
        args: ['server.js'],
        env: [{ name: 'MODE', value: 'test' }],
      },
    ],
  });
});

it('preserves tool metadata through sparse updates and ignores replay and other sessions', async () => {
  const { adapter, events, server } = await setup();
  const update = (sessionId: string, update: Record<string, unknown>) =>
    server.notify('session/update', { sessionId, update });
  update('native', {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'replay' },
  });
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'hello' });
  update('other', {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'wrong' },
  });
  update('native', {
    sessionUpdate: 'tool_call',
    toolCallId: 'tool',
    kind: 'execute',
    title: 'Run build',
    status: 'in_progress',
  });
  update('native', {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tool',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'OK' } }],
  });
  expect(events.filter((e) => e.type === 'content.delta')).toEqual([]);
  expect(events.find((e) => e.type === 'item.completed')).toMatchObject({
    item: {
      id: 'tool',
      type: 'command_execution',
      title: 'Run build',
      status: 'completed',
      text: 'OK',
    },
  });
});

it('answers the offered permission ID and excludes persistent permissions', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'write' });
  server.send({
    id: 99,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: { kind: 'edit', title: 'Edit marker', toolCallId: 'edit' },
      options: [
        { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'save', name: 'Allow for future sessions', kind: 'allow_always' },
        { optionId: 'session', name: 'Allow this session', kind: 'allow_always' },
      ],
    },
  });
  const request = events.find((e) => e.type === 'request.opened');
  if (!request || request.type !== 'request.opened') throw new Error('missing approval');
  expect(request.options.map((o) => o.label)).not.toContain('Allow for future sessions');
  await adapter.respondToRequest('s', request.requestId, 'acceptForSession');
  await flush();
  expect(server.received.find((m) => m.id === 99)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'session' },
  });
});

it('interrupts the native turn, cancels pending approvals and waits for cancellation before draining', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 'one', text: 'first' });
  await adapter.sendTurn({ sessionId: 's', turnId: 'two', text: 'second' });
  const prompt = await server.waitFor('session/prompt');
  server.send({
    id: 98,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: { title: 'Run', kind: 'execute', toolCallId: 'tool' },
      options: [],
    },
  });
  await adapter.interruptTurn('s');
  await flush();
  expect(server.received.find((m) => m.method === 'session/cancel')?.params).toEqual({
    sessionId: 'native',
  });
  expect(server.received.find((m) => m.id === 98)?.result).toEqual({
    outcome: { outcome: 'cancelled' },
  });
  expect(server.received.filter((m) => m.method === 'session/prompt')).toHaveLength(1);
  server.send({ id: prompt.id, result: { stopReason: 'cancelled' } });
  await flush();
  expect(events.find((e) => e.type === 'turn.completed')).toMatchObject({
    turnId: 'one',
    outcome: 'interrupted',
  });
  expect(server.received.filter((m) => m.method === 'session/prompt')).toHaveLength(2);
});

it('settles active and queued turns on process exit without starting another prompt', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 'one', text: 'first' });
  await adapter.sendTurn({ sessionId: 's', turnId: 'two', text: 'second' });
  server.kill('SIGKILL');
  await flush();
  expect(adapter.hasSession('s')).toBe(false);
  expect(events.filter((e) => e.type === 'turn.completed').map((e) => e.outcome)).toEqual([
    'error',
    'error',
  ]);
  expect(server.received.filter((m) => m.method === 'session/prompt')).toHaveLength(1);
});

it('finishes streamed assistant messages so the transcript stops showing writing', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'hello' });
  const prompt = await server.waitFor('session/prompt');
  server.notify('session/update', {
    sessionId: 'native',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } },
  });
  server.send({ id: prompt.id, result: { stopReason: 'end_turn' } });
  await flush();
  const delta = events.find((e) => e.type === 'content.delta');
  if (!delta || delta.type !== 'content.delta') throw new Error('missing delta');
  const started = events.findIndex(
    (event) => event.type === 'item.started' && event.item.id === delta.itemId
  );
  expect(started).toBeGreaterThanOrEqual(0);
  expect(started).toBeLessThan(events.indexOf(delta));
  expect(events.find((e) => e.type === 'item.completed')).toMatchObject({
    item: { id: delta.itemId, type: 'assistant_message', status: 'completed', text: 'Hello' },
  });
});

it('serializes turns submitted synchronously by completion listeners', async () => {
  const { adapter, server, events } = await setup();
  adapter.subscribe((e) => {
    if (e.type === 'turn.completed' && e.turnId === 'one') {
      void adapter.sendTurn({ sessionId: 's', turnId: 'two', text: 'second' });
      void adapter.sendTurn({ sessionId: 's', turnId: 'three', text: 'third' });
    }
  });
  await adapter.sendTurn({ sessionId: 's', turnId: 'one', text: 'first' });
  const prompt = server.received.find((m) => m.method === 'session/prompt')!;
  server.send({ id: prompt.id, result: { stopReason: 'end_turn' } });
  await flush();
  expect(server.received.filter((m) => m.method === 'session/prompt')).toHaveLength(2);
  expect(events.at(-1)).toMatchObject({ type: 'session.state.changed', status: 'running' });
});

it('authenticates once on the session process before creating the session', async () => {
  const { server } = await setup();
  expect(servers).toHaveLength(1);
  expect(server.received.slice(0, 3).map((m) => m.method)).toEqual([
    'initialize',
    'authenticate',
    'session/new',
  ]);
});
it('refuses legacy CLI conversation IDs before starting a process', async () => {
  await expect(
    createAntigravityAdapter().startSession({
      sessionId: 'legacy',
      cwd: '/work',
      runtimeMode: 'approval-required',
      env: {},
      mcpServers: {},
      resume: { nativeSessionId: 'old-cli' },
    })
  ).rejects.toThrow('previous Antigravity CLI');
  expect(servers).toHaveLength(0);
});
it('gets models from ACP initialization and uses native config selection', async () => {
  const { adapter, server } = await setup();
  expect(await adapter.listModels('s')).toMatchObject([{ id: 'model-a' }]);
  await adapter.setModel('s', { id: 'model-a' });
  expect(server.received.find((m) => m.method === 'session/set_config_option')?.params).toEqual({
    sessionId: 'native',
    configId: 'model',
    value: 'model-a',
  });
});
it('answers native questions with the offered option ID', async () => {
  const { adapter, server, events } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'question' });
  server.send({
    id: 99,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: { toolCallId: 'interaction_1', title: 'Choose' },
      options: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }],
    },
  });
  const event = events.find((e) => e.type === 'user-input.requested');
  if (!event || event.type !== 'user-input.requested') throw new Error('Missing question');
  await expect(
    adapter.respondToUserInput('s', event.requestId, { interaction_1: 'invented' })
  ).rejects.toThrow('offered');
  await adapter.respondToUserInput('s', event.requestId, { interaction_1: 'yes' });
  await flush();
  expect(server.received.find((m) => m.id === 99)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'yes' },
  });
});

it('auto-approves Switch MCP calls with bypass off using provider metadata', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'connect' });
  const options = [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }];
  server.send({
    id: 90,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: {
        toolCallId: 'call',
        kind: 'other',
        _meta: { is_mcp_tool_call: true, mcp: { server: 'switch', tool: 'connect_to_room' } },
      },
      options,
    },
  });
  await flush();
  expect(server.received.find((m) => m.id === 90)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'once' },
  });
  expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(0);
  for (const [id, toolCall] of [
    [91, { toolCallId: 'unidentified', title: 'switch_connect_to_room', kind: 'execute' }],
    [
      92,
      {
        toolCallId: 'other-server',
        _meta: { is_mcp_tool_call: true, mcp: { server: 'other', tool: 'connect_to_room' } },
      },
    ],
  ] as const) {
    server.send({
      id,
      method: 'session/request_permission',
      params: {
        sessionId: 'native',
        toolCall,
        options,
      },
    });
  }
  expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(2);
});

it('keeps approval for Switch metadata when Switch was not registered by the session', async () => {
  const { adapter, events, server } = await setup(false, false);
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'connect' });
  server.send({
    id: 93,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: {
        toolCallId: 'call',
        _meta: { is_mcp_tool_call: true, mcp: { server: 'switch', tool: 'connect_to_room' } },
      },
      options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }],
    },
  });
  expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(1);
});

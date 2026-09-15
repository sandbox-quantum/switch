import type * as fs from 'node:fs/promises';
import { beforeEach, expect, it, vi } from 'vitest';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));
const servers: FakeAppServer[] = [];
vi.mock('node:child_process', () => ({
  spawn: () => {
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({ agentCapabilities: { loadSession: true } }));
    server.replyAlways('session/new', () => ({ sessionId: 'native' }));
    server.replyAlways('session/load', () => ({}));
    server.replyAlways('session/set_mode', () => ({}));
    server.replyAlways('session/set_model', () => ({}));
    servers.push(server);
    return server;
  },
}));
const { createGeminiAdapter } = await import('./gemini-adapter');
beforeEach(() => {
  servers.length = 0;
});
async function setup(resume = false) {
  const adapter = createGeminiAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  const session = await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: 'approval-required',
    env: {},
    mcpServers: {
      switch: { transport: 'stdio', command: 'node', args: ['server.js'], env: { MODE: 'test' } },
    },
    ...(resume ? { resume: { nativeSessionId: 'native' } } : {}),
  });
  const server = servers.at(-1)!;
  return { adapter, events, server, session };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

it('registers session MCP servers and resumes the exact native session', async () => {
  const { server, session } = await setup(true);
  expect(session.nativeSessionId).toBe('native');
  expect(server.received.find((m) => m.method === 'session/load')?.params).toMatchObject({
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
    params: { sessionId: 'native', toolCall: { title: 'Run', kind: 'execute' }, options: [] },
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

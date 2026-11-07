import type * as fs from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';
import { isDroidSubagent } from './factory-droid-subagent';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));

const servers: FakeAppServer[] = [];
vi.mock('node:child_process', () => ({
  spawn: () => {
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({ agentCapabilities: {} }));
    server.replyAlways('session/new', () => ({ sessionId: 'native' }));
    server.replyAlways('session/set_mode', () => ({}));
    servers.push(server);
    return server;
  },
}));

const { createFactoryDroidAdapter } = await import('./factory-droid-acp');
const { createAcpAdapter } = await import('../acp/acp-adapter');
const { factoryDroidAcp } = await import('./factory-droid-acp');

const task = {
  toolCallId: 'task-1',
  kind: 'other',
  title: 'Explorer: Read the README',
  rawInput: {
    subagent_type: 'explore',
    description: 'Read the README',
    prompt: 'Read its first line',
  },
};

it('recognizes Droid Task input without confusing a wait or an MCP call for a subagent', () => {
  expect(isDroidSubagent(task)).toBe(true);
  expect(isDroidSubagent({ ...task, rawInput: { task_id: 'task-1', block: true } })).toBe(false);
  expect(isDroidSubagent({ ...task, _meta: { factory: { source: 'mcp', server: 'x' } } })).toBe(
    false
  );
  expect(isDroidSubagent({ ...task, toolCallId: 'mcp_tool-1' })).toBe(false);
  expect(isDroidSubagent({ ...task, rawInput: { subagent_type: 'explore' } })).toBe(false);
  expect(isDroidSubagent({ ...task, kind: 'edit' })).toBe(false);
});

it('emits one subagent lifecycle for a Droid Task across sparse updates, not its wait call', async () => {
  const adapter = createFactoryDroidAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: 'full-access',
    env: {},
    mcpServers: {},
    connectorMcpServers: [],
  });
  const server = servers.at(-1)!;
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'delegate' });
  const update = (value: Record<string, unknown>) =>
    server.notify('session/update', { sessionId: 'native', update: value });
  update({ sessionUpdate: 'tool_call', ...task, status: 'pending' });
  update({
    sessionUpdate: 'tool_call_update',
    toolCallId: task.toolCallId,
    _meta: { subagent_session_info: { session_id: 'child', message_start_index: 0 } },
  });
  update({ sessionUpdate: 'tool_call_update', toolCallId: task.toolCallId, status: 'in_progress' });
  update({
    sessionUpdate: 'tool_call',
    toolCallId: 'wait-1',
    kind: 'other',
    title: 'Wait for Explorer',
    rawInput: { task_id: 'child', block: true, timeout: 1000 },
    _meta: { subagent_session_info: { session_id: 'child' } },
    status: 'pending',
  });
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'wait-1', status: 'completed' });
  update({ sessionUpdate: 'tool_call_update', toolCallId: task.toolCallId, status: 'completed' });

  expect(
    events.filter((event) => event.type === 'item.started' && event.item.type === 'subagent')
  ).toMatchObject([{ item: { id: task.toolCallId, type: 'subagent' } }]);
  expect(
    events.filter((event) => event.type === 'item.completed' && event.item.type === 'subagent')
  ).toMatchObject([{ item: { id: task.toolCallId, status: 'completed' } }]);
  expect(
    events.find((event) => event.type === 'item.completed' && event.item.id === 'wait-1')
  ).toMatchObject({ item: { type: 'tool_call', status: 'completed' } });
  await adapter.stopAll();
});

async function withTask(backgroundSubagents = true) {
  const adapter = createAcpAdapter({ ...factoryDroidAcp, backgroundSubagents }, {});
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: 'full-access',
    env: {},
    mcpServers: {},
    connectorMcpServers: [],
  });
  const server = servers.at(-1)!;
  const update = (value: Record<string, unknown>) =>
    server.notify('session/update', { sessionId: 'native', update: value });
  await adapter.sendTurn({ sessionId: 's', turnId: 'first', text: 'delegate' });
  const prompt = await server.waitFor('session/prompt');
  update({ sessionUpdate: 'tool_call', ...task, status: 'pending' });
  return { adapter, events, server, update, prompt };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

it('keeps the originating turn and running assistant text when a subagent finishes after the prompt and during the next turn', async () => {
  const { adapter, events, server, update, prompt } = await withTask();
  server.send({ id: prompt.id, result: { stopReason: 'end_turn' } });
  await flush();
  expect(
    events.find((event) => event.type === 'turn.completed' && event.turnId === 'first')
  ).toMatchObject({ outcome: 'completed' });
  expect(adapter.hasBackgroundWork('s')).toBe(true);
  await adapter.sendTurn({ sessionId: 's', turnId: 'second', text: 'continue' });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'before ' } });
  update({ sessionUpdate: 'tool_call_update', toolCallId: task.toolCallId, status: 'completed' });
  update({ sessionUpdate: 'tool_call_update', toolCallId: task.toolCallId, status: 'completed' });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after' } });
  const done = events.filter(
    (event) => event.type === 'item.completed' && event.item.id === task.toolCallId
  );
  expect(done).toHaveLength(1);
  expect(done[0]).toMatchObject({
    turnId: 'first',
    item: { type: 'subagent', status: 'completed' },
  });
  expect(adapter.hasBackgroundWork('s')).toBe(false);
  const secondPrompt = server.received
    .filter((message) => message.method === 'session/prompt')
    .at(-1)!;
  server.send({ id: secondPrompt.id, result: { stopReason: 'end_turn' } });
  await flush();
  expect(
    events.filter(
      (event) => event.type === 'item.completed' && event.item.type === 'assistant_message'
    )
  ).toMatchObject([{ turnId: 'second', item: { text: 'before after' } }]);
  await adapter.stopAll();
});

it('fails a pending background subagent once when the session stops', async () => {
  const { adapter, events, server, prompt } = await withTask();
  server.send({ id: prompt.id, result: { stopReason: 'end_turn' } });
  await flush();
  expect(adapter.hasBackgroundWork('s')).toBe(true);
  await adapter.stopSession('s');
  expect(adapter.hasBackgroundWork('s')).toBe(false);
  expect(
    events.filter((event) => event.type === 'item.completed' && event.item.id === task.toolCallId)
  ).toMatchObject([{ turnId: 'first', item: { status: 'failed' } }]);
});

it('records a late failed subagent under its original turn while no turn is active', async () => {
  const { adapter, events, server, update, prompt } = await withTask();
  server.send({ id: prompt.id, result: { stopReason: 'end_turn' } });
  await flush();
  update({ sessionUpdate: 'tool_call_update', toolCallId: task.toolCallId, status: 'failed' });
  expect(
    events.filter((event) => event.type === 'item.completed' && event.item.id === task.toolCallId)
  ).toMatchObject([{ turnId: 'first', item: { type: 'subagent', status: 'failed' } }]);
  expect(adapter.hasBackgroundWork('s')).toBe(false);
  await adapter.stopAll();
});

it('does not leave a background task running when another pending tool makes the turn fail', async () => {
  const { adapter, events, server, update, prompt } = await withTask();
  update({
    sessionUpdate: 'tool_call',
    toolCallId: 'ordinary',
    kind: 'execute',
    title: 'Run',
    status: 'pending',
  });
  server.send({ id: prompt.id, result: { stopReason: 'end_turn' } });
  await flush();
  expect(
    events.find((event) => event.type === 'turn.completed' && event.turnId === 'first')
  ).toMatchObject({ outcome: 'error' });
  expect(
    events.find((event) => event.type === 'item.completed' && event.item.id === task.toolCallId)
  ).toMatchObject({ item: { status: 'failed' } });
  expect(adapter.hasBackgroundWork('s')).toBe(false);
  await adapter.stopAll();
});

it('fails an interrupted subagent and ignores its late completion during the next turn', async () => {
  const { adapter, events, server, update, prompt } = await withTask();
  await adapter.interruptTurn('s');
  server.send({ id: prompt.id, result: { stopReason: 'cancelled' } });
  await flush();
  await adapter.sendTurn({ sessionId: 's', turnId: 'second', text: 'continue' });
  update({ sessionUpdate: 'tool_call_update', toolCallId: task.toolCallId, status: 'completed' });
  expect(
    events.filter((event) => event.type === 'item.completed' && event.item.id === task.toolCallId)
  ).toMatchObject([{ turnId: 'first', item: { status: 'failed' } }]);
  expect(adapter.hasBackgroundWork('s')).toBe(false);
  await adapter.stopAll();
});

it('continues to fail unconfirmed tools when background subagents are not enabled', async () => {
  const { adapter, events, server, prompt } = await withTask(false);
  server.send({ id: prompt.id, result: { stopReason: 'end_turn' } });
  await flush();
  expect(
    events.find((event) => event.type === 'turn.completed' && event.turnId === 'first')
  ).toMatchObject({ outcome: 'error' });
  expect(
    events.find((event) => event.type === 'item.completed' && event.item.id === task.toolCallId)
  ).toMatchObject({ item: { status: 'failed' } });
  expect(adapter.hasBackgroundWork('s')).toBe(false);
  await adapter.stopAll();
});

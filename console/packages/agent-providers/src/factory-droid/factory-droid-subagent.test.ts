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
    server.replyAlways('initialize', () => ({ agentCapabilities: { loadSession: true } }));
    server.replyAlways('session/new', () => ({ sessionId: 'native' }));
    server.replyAlways('session/load', () => {
      server.notify('session/update', {
        sessionId: 'native',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replay' } },
      });
      return {};
    });
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

async function withTask(
  backgroundSubagents = true,
  taskUpdate: Record<string, unknown> | null = task,
  guardPendingToolOnTurnEnd = backgroundSubagents
) {
  const adapter = createAcpAdapter(
    { ...factoryDroidAcp, backgroundSubagents, guardPendingToolOnTurnEnd },
    {}
  );
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
  if (taskUpdate) update({ sessionUpdate: 'tool_call', ...taskUpdate, status: 'pending' });
  return { adapter, events, server, update, prompt };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

it.each([false, true])(
  'does not quarantine startup or replay before the first prompt (resume=%s)',
  async (resume) => {
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
      ...(resume ? { resume: { nativeSessionId: 'native' } } : {}),
    });
    const server = servers.at(-1)!;
    server.notify('session/update', {
      sessionId: 'native',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'startup' } },
    });
    await adapter.sendTurn({ sessionId: 's', turnId: 'first', text: 'continue' });
    expect(server.received.filter((message) => message.method === 'session/prompt')).toHaveLength(
      1
    );
    expect(events.filter((event) => event.type === 'runtime.error')).toHaveLength(0);
    await adapter.stopAll();
  }
);

it('fails a queued turn exactly once when the provider disconnects', async () => {
  const { adapter, events, server } = await withTask();
  await adapter.sendTurn({ sessionId: 's', turnId: 'second', text: 'continue' });
  server.kill('SIGKILL');
  await flush();
  expect(
    events.filter((event) => event.type === 'turn.completed' && event.turnId === 'first')
  ).toMatchObject([{ outcome: 'error' }]);
  expect(
    events.filter((event) => event.type === 'turn.completed' && event.turnId === 'second')
  ).toMatchObject([{ outcome: 'error' }]);
  expect(server.received.filter((message) => message.method === 'session/prompt')).toHaveLength(1);
  expect(adapter.hasSession('s')).toBe(false);
});

async function expectQuarantined(
  adapter: ReturnType<typeof createAcpAdapter>,
  events: ProviderRuntimeEvent[],
  turnId: string
) {
  await expect(adapter.sendTurn({ sessionId: 's', turnId, text: 'continue' })).resolves.toEqual({
    turnId,
  });
  expect(
    events.filter((event) => event.type === 'turn.completed' && event.turnId === turnId)
  ).toMatchObject([{ outcome: 'error', message: expect.stringContaining('uncertain') }]);
}

it('quarantines unfinished Tasks before draining the queue and never assigns late text to a new turn', async () => {
  const { adapter, events, server, update, prompt } = await withTask();
  await adapter.sendTurn({ sessionId: 's', turnId: 'second', text: 'continue' });
  server.send({ id: prompt.id, result: { stopReason: 'end_turn' } });
  await flush();
  expect(
    events.find((event) => event.type === 'turn.completed' && event.turnId === 'first')
  ).toMatchObject({ outcome: 'error', message: expect.stringContaining('uncertain') });
  expect(events.filter((event) => event.type === 'runtime.error')).toMatchObject([
    { message: expect.stringContaining('Stop this session') },
  ]);
  expect(
    events.filter((event) => event.type === 'turn.completed' && event.turnId === 'second')
  ).toMatchObject([{ outcome: 'error', message: expect.stringContaining('Further messages') }]);
  expect(server.received.filter((message) => message.method === 'session/prompt')).toHaveLength(1);
  expect(adapter.hasBackgroundWork('s')).toBe(true);
  await expectQuarantined(adapter, events, 'third');
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
  await expectQuarantined(adapter, events, 'fourth');
  expect(
    events.filter((event) => event.type === 'content.delta' && event.turnId !== 'first')
  ).toHaveLength(0);
  await adapter.stopAll();
});

it('quarantines an explicitly background Task, but continues tracking it until completion', async () => {
  const { adapter, events, server, update, prompt } = await withTask(true, {
    ...task,
    rawInput: { ...task.rawInput, run_in_background: true },
  });
  server.send({ id: prompt.id, result: { stopReason: 'end_turn' } });
  await flush();
  expect(
    events.find((event) => event.type === 'turn.completed' && event.turnId === 'first')
  ).toMatchObject({ outcome: 'error', message: expect.stringContaining('uncertain') });
  expect(adapter.hasBackgroundWork('s')).toBe(true);
  await expectQuarantined(adapter, events, 'second');
  update({ sessionUpdate: 'tool_call_update', toolCallId: task.toolCallId, status: 'completed' });
  expect(adapter.hasBackgroundWork('s')).toBe(false);
  await adapter.stopAll();
});

it('quarantines an unfinished tool even when missing metadata prevents Task classification', async () => {
  const { adapter, events, server, update, prompt } = await withTask(true, {
    toolCallId: task.toolCallId,
    kind: 'other',
    title: 'Task',
    rawInput: {},
  });
  server.send({ id: prompt.id, result: { stopReason: 'end_turn' } });
  await flush();
  expect(
    events.find((event) => event.type === 'turn.completed' && event.turnId === 'first')
  ).toMatchObject({ outcome: 'error', message: expect.stringContaining('uncertain') });
  await expectQuarantined(adapter, events, 'second');
  expect(adapter.hasBackgroundWork('s')).toBe(true);
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late' } });
  update({ sessionUpdate: 'tool_call_update', toolCallId: task.toolCallId, status: 'completed' });
  expect(
    events.find((event) => event.type === 'item.completed' && event.item.id === task.toolCallId)
  ).toMatchObject({ turnId: 'first', item: { status: 'completed' } });
  expect(adapter.hasBackgroundWork('s')).toBe(false);
  expect(events.filter((event) => event.type === 'content.delta')).toHaveLength(0);
  expect(server.received.filter((message) => message.method === 'session/prompt')).toHaveLength(1);
  await adapter.stopAll();
});

it('accepts the next turn when the Task finished before the prompt response', async () => {
  const { adapter, events, server, update, prompt } = await withTask();
  update({ sessionUpdate: 'tool_call_update', toolCallId: task.toolCallId, status: 'completed' });
  server.send({ id: prompt.id, result: { stopReason: 'end_turn' } });
  await flush();
  expect(
    events.find((event) => event.type === 'turn.completed' && event.turnId === 'first')
  ).toMatchObject({ outcome: 'completed' });
  await expect(
    adapter.sendTurn({ sessionId: 's', turnId: 'second', text: 'continue' })
  ).resolves.toEqual({
    turnId: 'second',
  });
  expect(server.received.filter((message) => message.method === 'session/prompt')).toHaveLength(2);
  await adapter.stopAll();
});

it('quarantines when Task completion follows the prompt response in the same read', async () => {
  const { adapter, events, server, update, prompt } = await withTask();
  server.send({ id: prompt.id, result: { stopReason: 'end_turn' } });
  update({ sessionUpdate: 'tool_call_update', toolCallId: task.toolCallId, status: 'completed' });
  await flush();
  expect(
    events.find((event) => event.type === 'turn.completed' && event.turnId === 'first')
  ).toMatchObject({ outcome: 'error', message: expect.stringContaining('uncertain') });
  await expectQuarantined(adapter, events, 'second');
  expect(server.received.filter((message) => message.method === 'session/prompt')).toHaveLength(1);
  await adapter.stopAll();
});

it('quarantines a tool that starts and ends after the response in the same read', async () => {
  const { adapter, events, server, update, prompt } = await withTask(true, null);
  await adapter.sendTurn({ sessionId: 's', turnId: 'second', text: 'continue' });
  server.send({ id: prompt.id, result: { stopReason: 'end_turn' } });
  update({ sessionUpdate: 'tool_call', ...task, status: 'pending' });
  update({ sessionUpdate: 'tool_call_update', toolCallId: task.toolCallId, status: 'completed' });
  await flush();
  expect(
    events.find((event) => event.type === 'turn.completed' && event.turnId === 'first')
  ).toMatchObject({ outcome: 'error', message: expect.stringContaining('uncertain') });
  expect(
    events.filter((event) => event.type === 'turn.completed' && event.turnId === 'second')
  ).toMatchObject([{ outcome: 'error' }]);
  expect(server.received.filter((message) => message.method === 'session/prompt')).toHaveLength(1);
  await adapter.stopAll();
});

it('quarantines untagged text received after the response in the same read', async () => {
  const { adapter, events, server, update, prompt } = await withTask(true, null);
  server.send({ id: prompt.id, result: { stopReason: 'end_turn' } });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late' } });
  await flush();
  expect(
    events.find((event) => event.type === 'turn.completed' && event.turnId === 'first')
  ).toMatchObject({ outcome: 'error', message: expect.stringContaining('uncertain') });
  await expectQuarantined(adapter, events, 'second');
  await adapter.stopAll();
});

it('quarantines late untagged text while idle before accepting another turn', async () => {
  const { adapter, events, server, update, prompt } = await withTask(true, null);
  server.send({ id: prompt.id, result: { stopReason: 'end_turn' } });
  await flush();
  expect(
    events.find((event) => event.type === 'turn.completed' && event.turnId === 'first')
  ).toMatchObject({ outcome: 'completed' });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late' } });
  expect(events.filter((event) => event.type === 'runtime.error')).toMatchObject([
    { message: expect.stringContaining('uncertain') },
  ]);
  await expectQuarantined(adapter, events, 'second');
  expect(server.received.filter((message) => message.method === 'session/prompt')).toHaveLength(1);
  await adapter.stopAll();
});

it('leaves opted-out providers able to continue while their tracked background Task runs', async () => {
  const { adapter, events, server, update, prompt } = await withTask(true, task, false);
  server.send({ id: prompt.id, result: { stopReason: 'end_turn' } });
  await flush();
  expect(
    events.find((event) => event.type === 'turn.completed' && event.turnId === 'first')
  ).toMatchObject({ outcome: 'completed' });
  await adapter.sendTurn({ sessionId: 's', turnId: 'second', text: 'continue' });
  update({ sessionUpdate: 'tool_call_update', toolCallId: task.toolCallId, status: 'completed' });
  expect(adapter.hasBackgroundWork('s')).toBe(false);
  expect(server.received.filter((message) => message.method === 'session/prompt')).toHaveLength(2);
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
  ).toMatchObject([
    {
      turnId: 'first',
      item: { status: 'failed', text: expect.stringContaining('may still be running') },
    },
  ]);
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

it('continues tracking an uncertain Task when another pending tool also makes the turn fail', async () => {
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
  expect(adapter.hasBackgroundWork('s')).toBe(true);
  update({ sessionUpdate: 'tool_call_update', toolCallId: task.toolCallId, status: 'completed' });
  expect(
    events.find((event) => event.type === 'item.completed' && event.item.id === task.toolCallId)
  ).toMatchObject({ turnId: 'first', item: { status: 'completed' } });
  expect(adapter.hasBackgroundWork('s')).toBe(true);
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'ordinary', status: 'completed' });
  expect(adapter.hasBackgroundWork('s')).toBe(false);
  await adapter.stopAll();
});

it('quarantines an interrupted turn with an unfinished Task and tracks its late completion', async () => {
  const { adapter, events, server, update, prompt } = await withTask();
  await adapter.interruptTurn('s');
  server.send({ id: prompt.id, result: { stopReason: 'cancelled' } });
  await flush();
  expect(events.filter((event) => event.type === 'session.state.changed').at(-1)).toMatchObject({
    status: 'error',
  });
  await expectQuarantined(adapter, events, 'second');
  update({ sessionUpdate: 'tool_call_update', toolCallId: task.toolCallId, status: 'completed' });
  expect(
    events.filter((event) => event.type === 'item.completed' && event.item.id === task.toolCallId)
  ).toMatchObject([{ turnId: 'first', item: { status: 'completed' } }]);
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

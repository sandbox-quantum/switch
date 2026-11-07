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

import type * as fs from 'node:fs/promises';
import { beforeEach, expect, it, vi } from 'vitest';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));
const servers: FakeAppServer[] = [];
const spawned: Array<{ command: string; args: readonly string[] }> = [];
/** What the fake agent answers `session/new` with: a v2 models list or v3 config options. */
const agent: { session: Record<string, unknown> } = { session: {} };
vi.mock('node:child_process', () => ({
  spawn: (command: string, args: readonly string[]) => {
    spawned.push({ command, args });
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } },
      authMethods: [],
    }));
    server.replyAlways('session/new', () => ({ sessionId: 'native', ...agent.session }));
    server.replyAlways('session/load', () => ({}));
    server.replyAlways('session/set_model', () => ({}));
    server.replyAlways('session/set_config_option', () => ({}));
    servers.push(server);
    return server;
  },
}));
const { createKiroAdapter, kiroAcp } = await import('./kiro-acp');

const V2_MODELS = {
  models: {
    currentModelId: 'auto',
    availableModels: [
      { modelId: 'auto', name: 'auto' },
      { modelId: 'claude-haiku-4.5', name: 'claude-haiku-4.5' },
    ],
  },
};
const V3_CONFIG = {
  configOptions: [
    {
      type: 'select',
      id: 'model',
      name: 'Model',
      category: 'model',
      currentValue: 'auto',
      options: [
        { value: 'auto', name: 'auto' },
        { value: 'claude-haiku-4.5', name: 'claude-haiku-4.5' },
      ],
    },
  ],
};

beforeEach(() => {
  servers.length = 0;
  spawned.length = 0;
  agent.session = V2_MODELS;
});
async function setup(input: { resume?: boolean; model?: string } = {}) {
  const adapter = createKiroAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  const session = await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: 'approval-required',
    env: { HOME: '/home/test' },
    mcpServers: {
      switch: { transport: 'stdio', command: 'node', args: ['server.js'], env: {} },
    },
    connectorMcpServers: [],
    ...(input.resume ? { resume: { nativeSessionId: 'native' } } : {}),
    ...(input.model ? { model: { id: input.model } } : {}),
  });
  const server = servers.at(-1)!;
  return { adapter, events, server, session };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const once = [{ optionId: 'allow_once', name: 'Yes', kind: 'allow_once' }];

it('runs kiro-cli acp on the engine the installed CLI defaults to, and never signs in', async () => {
  const { server } = await setup();
  expect(spawned.at(-1)).toMatchObject({ command: 'kiro-cli', args: ['acp'] });
  expect(server.received.some((m) => m.method === 'authenticate')).toBe(false);
  expect(server.received.some((m) => m.method === 'session/set_mode')).toBe(false);
});

it('leaves the session in the agent the person configured in every runtime mode', () => {
  expect(kiroAcp.sessionMode).toBeUndefined();
});

it('resumes the exact native session with the session MCP servers', async () => {
  const { server, session } = await setup({ resume: true });
  expect(session.nativeSessionId).toBe('native');
  expect(server.received.find((m) => m.method === 'session/load')?.params).toMatchObject({
    sessionId: 'native',
    mcpServers: [{ name: 'switch', command: 'node', args: ['server.js'] }],
  });
});

it('chooses the model through set_model on the v2 engine', async () => {
  const { adapter, server } = await setup({ model: 'claude-haiku-4.5' });
  expect(await adapter.listModels('s')).toEqual([
    expect.objectContaining({ id: 'auto' }),
    expect.objectContaining({ id: 'claude-haiku-4.5' }),
  ]);
  expect(server.received.find((m) => m.method === 'session/set_model')?.params).toEqual({
    sessionId: 'native',
    modelId: 'claude-haiku-4.5',
  });
});

it('chooses the model through its config option on the v3 engine', async () => {
  agent.session = V3_CONFIG;
  const { server } = await setup({ model: 'claude-haiku-4.5' });
  expect(server.received.some((m) => m.method === 'session/set_model')).toBe(false);
  expect(server.received.find((m) => m.method === 'session/set_config_option')?.params).toEqual({
    sessionId: 'native',
    configId: 'model',
    value: 'claude-haiku-4.5',
  });
});

it.each([
  ['v2', { kiro: { toolName: 'switch_echo', mcpServerName: 'switch' } }],
  ['v3', { kiro: { serverName: 'switch', toolOrigin: 'default' } }],
])(
  'allows tools on session MCP servers without asking, named the %s way',
  async (_engine, meta) => {
    const { adapter, events, server } = await setup();
    await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'list rooms' });
    server.notify('session/update', {
      sessionId: 'native',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'mcp-call',
        title: 'Running: @switch/list_rooms',
        _meta: meta,
      },
    });
    // Kiro's permission request repeats the tool call without its metadata.
    server.send({
      id: 90,
      method: 'session/request_permission',
      params: {
        sessionId: 'native',
        toolCall: { toolCallId: 'mcp-call', title: 'Running: @switch/list_rooms' },
        options: once,
      },
    });
    await flush();
    expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(0);
    expect(server.received.find((m) => m.id === 90)?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    });
    expect(events.find((e) => e.type === 'item.started')).toMatchObject({
      item: { id: 'mcp-call', type: 'mcp_tool_call' },
    });
  }
);

it('asks about a tool on an MCP server the session did not register', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'search' });
  server.notify('session/update', {
    sessionId: 'native',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'other-call',
      title: 'Running: @github/search',
      _meta: { kiro: { mcpServerName: 'github' } },
    },
  });
  server.send({
    id: 91,
    method: 'session/request_permission',
    params: { sessionId: 'native', toolCall: { toolCallId: 'other-call' }, options: once },
  });
  await flush();
  expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(1);
});

it('offers allow once, allow for this session and reject for a shell command', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'run it' });
  server.send({
    id: 92,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: { toolCallId: 'shell', kind: 'execute', title: 'Running: echo ok > ok.txt' },
      options: [
        { optionId: 'allow_once', name: 'Yes', kind: 'allow_once' },
        { optionId: 'allow_always', name: 'Always', kind: 'allow_always' },
        { optionId: 'reject_once', name: 'No', kind: 'reject_once' },
      ],
    },
  });
  await flush();
  const request = events.find((e) => e.type === 'request.opened');
  if (!request || request.type !== 'request.opened') throw new Error('missing approval');
  expect(request.requestType).toBe('command_execution_approval');
  expect(request.options.map((o) => o.decision)).toEqual([
    'accept',
    'acceptForSession',
    'decline',
    'cancel',
  ]);
  await adapter.respondToRequest('s', request.requestId, 'decline');
  await flush();
  expect(server.received.find((m) => m.id === 92)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'reject_once' },
  });
});

it.each([
  ['v2', { kiro: { toolName: 'subagent' } }],
  ['v3', { kiro: { kind: 'agent-subtask', agentSubtaskId: 'task-1' } }],
])('shows a delegated task as a subagent, named the %s way', async (_engine, meta) => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'delegate' });
  server.notify('session/update', {
    sessionId: 'native',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'task',
      title: 'Spawning agent crew',
      kind: 'other',
      _meta: meta,
    },
  });
  server.notify('session/update', {
    sessionId: 'native',
    update: { sessionUpdate: 'tool_call_update', toolCallId: 'task', status: 'completed' },
  });
  expect(events.find((e) => e.type === 'item.started')).toMatchObject({
    item: { id: 'task', type: 'subagent', title: 'Spawning agent crew' },
  });
  expect(events.find((e) => e.type === 'item.completed')).toMatchObject({
    item: { id: 'task', type: 'subagent', status: 'completed' },
  });
});

it('keeps a plain tool call typed by its ACP kind', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'read' });
  server.notify('session/update', {
    sessionId: 'native',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'read',
      title: 'Reading README.md',
      kind: 'read',
      _meta: { kiro: { toolName: 'read' } },
    },
  });
  expect(events.find((e) => e.type === 'item.started')).toMatchObject({
    item: { id: 'read', type: 'tool_call' },
  });
});

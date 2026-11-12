import type * as fs from 'node:fs/promises';
import { beforeEach, expect, it, vi } from 'vitest';
import type { RuntimeMode } from '../adapter';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));
const servers: FakeAppServer[] = [];
const spawned: Array<{ command: string; args: readonly string[] }> = [];
vi.mock('node:child_process', () => ({
  spawn: (command: string, args: readonly string[]) => {
    spawned.push({ command, args });
    const server = new FakeAppServer();
    // What qwen-code 0.26.1 answers, trimmed to what the adapter reads.
    server.replyAlways('initialize', () => ({
      protocolVersion: 1,
      agentInfo: { name: 'qwen-code', version: '0.26.1' },
      authMethods: [{ id: 'openai', name: 'Use OpenAI API key' }],
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
        sessionCapabilities: { list: {}, resume: {} },
        mcpCapabilities: { sse: true, http: true },
      },
    }));
    server.replyAlways('session/new', () => SESSION);
    server.replyAlways('session/load', () => SESSION);
    server.replyAlways('session/set_mode', () => ({}));
    server.replyAlways('session/set_config_option', () => ({}));
    servers.push(server);
    return server;
  },
}));
const { createQwenAdapter, qwenAcp } = await import('./qwen-acp');

const MODEL = '$runtime|openai|qwen3-coder-plus(openai)';
const SESSION = {
  sessionId: 'native',
  models: {
    currentModelId: MODEL,
    availableModels: [{ modelId: MODEL, name: 'qwen3-coder-plus' }],
  },
  modes: {
    currentModeId: 'auto',
    availableModes: ['plan', 'default', 'auto-edit', 'auto', 'yolo'].map((id) => ({ id })),
  },
  configOptions: [
    {
      id: 'mode',
      type: 'select',
      category: 'mode',
      currentValue: 'auto',
      options: ['plan', 'default', 'auto-edit', 'auto', 'yolo'].map((value) => ({
        value,
        name: value,
      })),
    },
    {
      id: 'model',
      type: 'select',
      category: 'model',
      currentValue: MODEL,
      options: [
        { value: MODEL, name: 'qwen3-coder-plus' },
        { value: '$runtime|openai|qwen3-max(openai)', name: 'qwen3-max' },
      ],
    },
  ],
};
/** Qwen's options for a shell command in its default mode. */
const SHELL_OPTIONS = [
  {
    optionId: 'proceed_always_project',
    name: 'Always Allow in project: touch *',
    kind: 'allow_always',
  },
  { optionId: 'proceed_always_user', name: 'Always Allow for user: touch *', kind: 'allow_always' },
  { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
];

beforeEach(() => {
  servers.length = 0;
  spawned.length = 0;
});
async function setup(input: { resume?: boolean; model?: string; runtimeMode?: RuntimeMode } = {}) {
  const adapter = createQwenAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  const session = await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: input.runtimeMode ?? 'approval-required',
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
function approval(events: ProviderRuntimeEvent[]) {
  const request = events.find((e) => e.type === 'request.opened');
  if (!request || request.type !== 'request.opened') throw new Error('missing approval');
  return request;
}

it('runs qwen --acp and never sends authenticate, which would clear its credentials', async () => {
  const { server } = await setup();
  expect(spawned.at(-1)).toMatchObject({ command: 'qwen', args: ['--acp'] });
  expect(server.received.some((m) => m.method === 'authenticate')).toBe(false);
});

it.each([
  ['approval-required', 'default'],
  ['auto-accept-edits', 'auto-edit'],
  ['auto', 'auto'],
  ['full-access', 'yolo'],
] as const)(
  'sets an explicit mode for %s, since a new session starts in auto',
  async (runtimeMode, modeId) => {
    const { server } = await setup({ runtimeMode });
    expect(server.received.find((m) => m.method === 'session/set_mode')?.params).toEqual({
      sessionId: 'native',
      modeId,
    });
  }
);

it('resumes the exact native session, then sets its mode again', async () => {
  const { server, session } = await setup({ resume: true });
  expect(session.nativeSessionId).toBe('native');
  const methods = server.received.map((m) => m.method);
  expect(methods).not.toContain('session/new');
  expect(methods.indexOf('session/set_mode')).toBeGreaterThan(methods.indexOf('session/load'));
  expect(server.received.find((m) => m.method === 'session/load')?.params).toMatchObject({
    sessionId: 'native',
    mcpServers: [{ name: 'switch', command: 'node', args: ['server.js'] }],
  });
});

it('chooses the model through its model config option', async () => {
  const other = '$runtime|openai|qwen3-max(openai)';
  const { adapter, server } = await setup({ model: other });
  expect((await adapter.listModels('s')).map((m) => m.id)).toEqual([MODEL, other]);
  expect(server.received.find((m) => m.method === 'session/set_config_option')?.params).toEqual({
    sessionId: 'native',
    configId: 'model',
    value: other,
  });
});

it('offers allow once and reject for a shell command, never the standing rules', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'run it' });
  server.send({
    id: 90,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: {
        toolCallId: 'shell',
        kind: 'execute',
        title: 'touch t.txt',
        rawInput: { command: 'touch t.txt' },
        _meta: { toolName: 'run_shell_command' },
      },
      options: SHELL_OPTIONS,
    },
  });
  await flush();
  const request = approval(events);
  expect(request.requestType).toBe('command_execution_approval');
  expect(request.options).toEqual([
    { decision: 'accept', label: 'Allow' },
    { decision: 'decline', label: 'Reject' },
    { decision: 'cancel', label: 'Cancel' },
  ]);
  await adapter.respondToRequest('s', request.requestId, 'decline');
  await flush();
  expect(server.received.find((m) => m.id === 90)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'cancel' },
  });
});

it('keeps "Allow All Edits", which lasts for the session, for a file edit', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'write it' });
  server.send({
    id: 91,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: { toolCallId: 'write', kind: 'edit', title: 'Writing to a.txt' },
      options: [
        { optionId: 'proceed_always', name: 'Allow All Edits', kind: 'allow_always' },
        { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
      ],
    },
  });
  await flush();
  const request = approval(events);
  expect(request.requestType).toBe('file_change_approval');
  expect(request.options.map((o) => o.decision)).toEqual([
    'acceptForSession',
    'accept',
    'decline',
    'cancel',
  ]);
  await adapter.respondToRequest('s', request.requestId, 'accept');
  await flush();
  expect(server.received.find((m) => m.id === 91)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'proceed_once' },
  });
});

it('allows a tool on a session MCP server without asking, named only by its tool name', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'list rooms' });
  // Qwen calls MCP tools through its deferred `tool_call` tool; the request
  // names the MCP tool, and no update has named its server yet.
  server.notify('session/update', {
    sessionId: 'native',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'mcp-call',
      status: 'pending',
      title: 'ToolCall',
      kind: 'other',
      _meta: { toolName: 'tool_call', provenance: 'builtin' },
    },
  });
  server.send({
    id: 92,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: {
        toolCallId: 'mcp-call',
        kind: 'other',
        title: '{}',
        _meta: { toolName: 'mcp__switch__list_rooms' },
      },
      options: SHELL_OPTIONS,
    },
  });
  await flush();
  expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(0);
  expect(server.received.find((m) => m.id === 92)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'proceed_once' },
  });
  server.notify('session/update', {
    sessionId: 'native',
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'mcp-call',
      status: 'completed',
      _meta: { toolName: 'mcp__switch__list_rooms', provenance: 'mcp', serverId: 'switch' },
    },
  });
  expect(events.find((e) => e.type === 'item.completed')).toMatchObject({
    item: { id: 'mcp-call', type: 'mcp_tool_call', status: 'completed' },
  });
});

it.each([
  ['a server the session did not register', 'mcp__github__search'],
  ['a server name Qwen had to rewrite', 'mcp__my_server__search'],
])('asks about a tool on %s', async (_case, toolName) => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'search' });
  server.send({
    id: 93,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: { toolCallId: 'other-call', kind: 'other', _meta: { toolName } },
      options: SHELL_OPTIONS,
    },
  });
  await flush();
  expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(1);
});

it('asks its questions as questions and sends the answers the way Qwen reads them', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'ask me' });
  const questions = [
    {
      question: 'Which color?',
      header: 'Color',
      options: [
        { label: 'Red', description: 'warm' },
        { label: 'Blue', description: 'cool' },
      ],
      multiSelect: false,
    },
    {
      question: 'Which sizes?',
      header: 'Size',
      options: [
        { label: 'S', description: '' },
        { label: 'M', description: '' },
        { label: 'L', description: '' },
      ],
      multiSelect: true,
    },
  ];
  server.send({
    id: 94,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: {
        toolCallId: 'ask',
        kind: 'think',
        title: 'Ask user 2 questions',
        rawInput: { questions },
        _meta: {
          toolName: 'ask_user_question',
          qwenInteractionKind: 'user_question',
          qwenQuestions: questions,
        },
      },
      options: [
        { optionId: 'proceed_once', name: 'Submit', kind: 'allow_once' },
        { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' },
      ],
    },
  });
  await flush();
  expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(0);
  const asked = events.find((e) => e.type === 'user-input.requested');
  if (!asked || asked.type !== 'user-input.requested') throw new Error('missing question');
  expect(asked.questions).toEqual([
    {
      id: '0',
      header: 'Color',
      question: 'Which color?',
      options: [
        { label: 'Red', value: 'Red', description: 'warm' },
        { label: 'Blue', value: 'Blue', description: 'cool' },
      ],
      multiSelect: false,
      allowCustomAnswer: false,
    },
    expect.objectContaining({ id: '1', multiSelect: true }),
  ]);
  await adapter.respondToUserInput('s', asked.requestId, { 0: 'Blue', 1: ['S', 'L'] });
  await flush();
  expect(server.received.find((m) => m.id === 94)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'proceed_once' },
    answers: { 0: 'Blue', 1: 'S, L' },
  });
});

it('answers a question it cannot show with cancelled', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'ask me' });
  server.send({
    id: 95,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: {
        toolCallId: 'ask',
        kind: 'think',
        _meta: { qwenInteractionKind: 'user_question', qwenQuestions: [{ question: 'Why?' }] },
      },
      options: [{ optionId: 'proceed_once', name: 'Submit', kind: 'allow_once' }],
    },
  });
  await flush();
  expect(events.some((e) => e.type === 'user-input.requested')).toBe(false);
  expect(server.received.find((m) => m.id === 95)?.result).toEqual({
    outcome: { outcome: 'cancelled' },
  });
});

it('starts the agent tool as a subagent once Qwen names it', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'delegate' });
  // The shape Qwen 0.26.1 sends for an agent called through its deferred
  // `tool_call`: the first notification has no input and no hint of the agent.
  for (const update of [
    {
      sessionUpdate: 'tool_call',
      status: 'pending',
      title: 'ToolCall',
      kind: 'other',
      rawInput: {},
      _meta: { toolName: 'tool_call', provenance: 'builtin' },
    },
    {
      sessionUpdate: 'tool_call_update',
      status: 'in_progress',
      title: 'Agent: read the README',
      kind: 'other',
      _meta: { toolName: 'agent', provenance: 'builtin' },
    },
    {
      sessionUpdate: 'tool_call_update',
      status: 'completed',
      _meta: { toolName: 'agent', provenance: 'builtin' },
    },
  ])
    server.notify('session/update', {
      sessionId: 'native',
      update: { toolCallId: 'task', ...update },
    });
  const items = events.flatMap((e) =>
    e.type.startsWith('item.') && 'item' in e && e.item.id === 'task'
      ? [`${e.type}:${e.item.type}`]
      : []
  );
  // The conformance suite waits for a subagent's item.started: the plain tool
  // call that Qwen announced first is started again as the subagent it is.
  expect(items).toEqual([
    'item.started:tool_call',
    'item.started:subagent',
    'item.completed:subagent',
  ]);
  expect(events.find((e) => e.type === 'item.started' && e.item.type === 'subagent')).toMatchObject(
    {
      item: { id: 'task', title: 'Agent: read the README', status: 'in_progress' },
    }
  );
});

it('keeps a built-in tool typed by its ACP kind', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'run' });
  server.notify('session/update', {
    sessionId: 'native',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'sh',
      status: 'pending',
      title: 'Shell',
      kind: 'execute',
      _meta: { toolName: 'run_shell_command', provenance: 'builtin' },
    },
  });
  expect(events.find((e) => e.type === 'item.started')).toMatchObject({
    item: { id: 'sh', type: 'command_execution' },
  });
  expect(qwenAcp.itemType?.({ toolCallId: 'x', _meta: { toolName: 'read_file' } })).toBe(undefined);
});

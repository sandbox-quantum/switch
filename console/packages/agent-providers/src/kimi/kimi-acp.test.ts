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
// What `kimi acp` 2.3.3 answers `initialize` and `session/new` with, trimmed.
const MODES = ['default', 'plan', 'auto', 'yolo'].map((id) => ({ id, name: id }));
vi.mock('node:child_process', () => ({
  spawn: (command: string, args: readonly string[]) => {
    spawned.push({ command, args });
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        sessionCapabilities: { list: {}, resume: {}, close: {} },
        mcpCapabilities: { http: true, sse: true },
      },
      authMethods: [{ id: 'login', type: 'terminal', name: 'Login with Kimi account' }],
      agentInfo: { name: 'Kimi Code CLI', version: '2.3.3' },
    }));
    const session = () => ({
      configOptions: [
        {
          type: 'select',
          id: 'model',
          name: 'Model',
          category: 'model',
          currentValue: 'kimi-for-coding',
          options: [
            { value: 'kimi-for-coding', name: 'Kimi for Coding' },
            { value: 'kimi-code', name: 'Kimi Code' },
          ],
        },
        {
          type: 'select',
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          currentValue: 'default',
          options: MODES.map(({ id, name }) => ({ value: id, name })),
        },
      ],
      modes: { currentModeId: 'default', availableModes: MODES },
    });
    server.replyAlways('session/new', () => ({ sessionId: 'session_native', ...session() }));
    server.replyAlways('session/load', () => session());
    server.replyAlways('session/set_mode', () => ({}));
    server.replyAlways('session/set_config_option', () => ({}));
    servers.push(server);
    return server;
  },
}));
const { createKimiAdapter } = await import('./kimi-acp');

beforeEach(() => {
  servers.length = 0;
  spawned.length = 0;
});
async function setup(
  input: { resume?: boolean; model?: string; runtimeMode?: RuntimeMode; connector?: string } = {}
) {
  const adapter = createKimiAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  const session = await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: input.runtimeMode ?? 'approval-required',
    env: { HOME: '/home/test' },
    mcpServers: {
      switch: { transport: 'stdio', command: 'node', args: ['server.js'], env: {} },
      ...(input.connector
        ? { [input.connector]: { transport: 'stdio', command: 'node', args: [], env: {} } }
        : {}),
    },
    connectorMcpServers: input.connector ? [input.connector] : [],
    ...(input.resume ? { resume: { nativeSessionId: 'session_native' } } : {}),
    ...(input.model ? { model: { id: input.model } } : {}),
  });
  const server = servers.at(-1)!;
  return { adapter, events, server, session };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
/** The options `kimi acp` offers for every tool approval. */
const APPROVAL = [
  { optionId: 'approve_once', name: 'Approve once', kind: 'allow_once' },
  { optionId: 'approve_always', name: 'Approve for this session', kind: 'allow_always' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];
/** Kimi's permission request names the tool in `title` and carries no `kind`. */
function permission(server: FakeAppServer, id: number, toolCallId: string, title: string) {
  server.send({
    id,
    method: 'session/request_permission',
    params: {
      sessionId: 'session_native',
      options: APPROVAL,
      toolCall: {
        toolCallId,
        title,
        content: [{ type: 'content', content: { type: 'text', text: `Requesting approval` } }],
      },
    },
  });
}
function toolCall(server: FakeAppServer, toolCallId: string, title: string, kind = 'other') {
  server.notify('session/update', {
    sessionId: 'session_native',
    update: { sessionUpdate: 'tool_call', toolCallId, title, kind, status: 'pending', content: [] },
  });
}

it('runs kimi acp and never signs in when a session starts', async () => {
  const { server } = await setup();
  expect(spawned.at(-1)).toEqual({ command: 'kimi', args: ['acp'] });
  expect(server.received.map((m) => m.method)).not.toContain('authenticate');
});

it.each([
  ['approval-required', 'default'],
  ['auto-accept-edits', 'default'],
  ['auto', 'yolo'],
  ['full-access', 'yolo'],
] as const)('puts a %s session in Kimi’s %s mode', async (runtimeMode, modeId) => {
  const { server } = await setup({ runtimeMode });
  expect(server.received.find((m) => m.method === 'session/set_mode')?.params).toEqual({
    sessionId: 'session_native',
    modeId,
  });
});

it('resumes the exact native session through session/load with the session MCP servers', async () => {
  const { server, session } = await setup({ resume: true });
  expect(session.nativeSessionId).toBe('session_native');
  expect(server.received.find((m) => m.method === 'session/load')?.params).toMatchObject({
    sessionId: 'session_native',
    mcpServers: [{ name: 'switch', command: 'node', args: ['server.js'] }],
  });
});

it('lists models from its model config option and chooses one through it', async () => {
  const { adapter, server } = await setup({ model: 'kimi-code' });
  expect(await adapter.listModels('s')).toEqual([
    expect.objectContaining({ id: 'kimi-for-coding' }),
    expect.objectContaining({ id: 'kimi-code' }),
  ]);
  expect(server.received.find((m) => m.method === 'session/set_config_option')?.params).toEqual({
    sessionId: 'session_native',
    configId: 'model',
    value: 'kimi-code',
  });
});

it('allows a Switch MCP tool without asking, named mcp__<server>__<tool>', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'list rooms' });
  toolCall(server, '0:call_1', 'mcp__switch__list_rooms');
  permission(server, 90, '0:call_1', 'mcp__switch__list_rooms');
  await flush();
  expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(0);
  expect(server.received.find((m) => m.id === 90)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'approve_once' },
  });
  expect(events.find((e) => e.type === 'item.started')).toMatchObject({
    item: { id: '0:call_1', type: 'mcp_tool_call' },
  });
});

it('asks about a connector tool, naming the connector', async () => {
  const { adapter, events, server } = await setup({ connector: 'github' });
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'search' });
  toolCall(server, '0:call_2', 'mcp__github__search_issues');
  permission(server, 91, '0:call_2', 'mcp__github__search_issues');
  await flush();
  expect(events.find((e) => e.type === 'request.opened')).toMatchObject({
    requestType: 'mcp_tool_approval',
    connector: 'github',
  });
});

it('asks about a shell command with allow once, allow for this session and reject', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'run it' });
  toolCall(server, '1:call_shell', 'Bash', 'execute');
  permission(server, 92, '1:call_shell', 'Bash');
  await flush();
  const request = events.find((e) => e.type === 'request.opened');
  if (!request || request.type !== 'request.opened') throw new Error('missing approval');
  expect(request.options.map((o) => o.decision)).toEqual([
    'accept',
    'acceptForSession',
    'decline',
    'cancel',
  ]);
  await adapter.respondToRequest('s', request.requestId, 'decline');
  await flush();
  expect(server.received.find((m) => m.id === 92)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'reject' },
  });
});

it('answers what Kimi still asks in full access with allow once', async () => {
  const { adapter, events, server } = await setup({ runtimeMode: 'full-access' });
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'clean up' });
  permission(server, 93, '1:call_rm', 'Bash');
  await flush();
  expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(0);
  expect(server.received.find((m) => m.id === 93)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'approve_once' },
  });
});

it.each([
  ['Agent', 'Agent'],
  ['AgentSwarm', 'AgentSwarm'],
  ['a described Agent call', 'Launching explore agent: say done'],
  ['a background Agent call', 'Launching background coder agent: build it'],
  ['a described AgentSwarm call', 'Launching agent swarm: review files'],
])('shows %s as a subagent', async (_name, title) => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'delegate' });
  toolCall(server, '1:call_agent', title);
  server.notify('session/update', {
    sessionId: 'session_native',
    update: { sessionUpdate: 'tool_call_update', toolCallId: '1:call_agent', status: 'completed' },
  });
  expect(events.find((e) => e.type === 'item.started')).toMatchObject({
    item: { id: '1:call_agent', type: 'subagent' },
  });
  expect(events.find((e) => e.type === 'item.completed')).toMatchObject({
    item: { id: '1:call_agent', type: 'subagent', status: 'completed' },
  });
});

it('keeps a built-in tool typed by its ACP kind', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'write' });
  toolCall(server, '2:call_write', 'Write', 'edit');
  expect(events.find((e) => e.type === 'item.started')).toMatchObject({
    item: { id: '2:call_write', type: 'file_change' },
  });
});

it('asks Kimi’s questions as questions and answers with the option chosen', async () => {
  const { adapter, events, server } = await setup({ runtimeMode: 'full-access' });
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'ask me' });
  server.send({
    id: 94,
    method: 'session/request_permission',
    params: {
      sessionId: 'session_native',
      options: [
        { optionId: 'q0_opt_0', name: 'red', kind: 'allow_once' },
        { optionId: 'q0_opt_1', name: 'blue', kind: 'allow_once' },
        { optionId: 'q0_skip', name: 'Skip', kind: 'reject_once' },
      ],
      toolCall: {
        toolCallId: '0:call_ask',
        title: 'AskUserQuestion',
        content: [{ type: 'content', content: { type: 'text', text: 'Pick a colour' } }],
      },
    },
  });
  await flush();
  const event = events.find((e) => e.type === 'user-input.requested');
  if (!event || event.type !== 'user-input.requested') throw new Error('missing question');
  expect(event.questions).toEqual([
    {
      id: '0:call_ask',
      question: 'Pick a colour',
      options: [
        { value: 'q0_opt_0', label: 'red' },
        { value: 'q0_opt_1', label: 'blue' },
      ],
      multiSelect: false,
      allowCustomAnswer: false,
    },
  ]);
  expect(server.received.some((m) => m.id === 94)).toBe(false);
  await adapter.respondToUserInput('s', event.requestId, { '0:call_ask': 'q0_opt_1' });
  await flush();
  expect(server.received.find((m) => m.id === 94)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'q0_opt_1' },
  });
});

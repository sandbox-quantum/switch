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
/** How the fake `kiro-cli acp` behaves: signed in or not. */
const kiro = { signedIn: true };
/** What Kiro 3.0.0 offers on a new session, trimmed to what the adapter reads. */
const configOptions = [
  {
    type: 'select',
    id: 'model',
    name: 'Model',
    currentValue: 'auto',
    options: [
      { value: 'auto', name: 'Auto' },
      { value: 'model-b', name: 'Model B' },
    ],
  },
  {
    type: 'select',
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    currentValue: 'vibe',
    options: [
      { value: 'vibe', name: 'Default' },
      { value: 'plan', name: 'Plan' },
    ],
  },
  {
    type: 'select',
    id: 'autopilot',
    name: 'Autopilot',
    currentValue: 'on',
    options: [
      { value: 'on', name: 'Autopilot' },
      { value: 'off', name: 'Supervised' },
    ],
  },
];

vi.mock('node:child_process', () => ({
  spawn: () => {
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
        _meta: { kiro: { extensionMethods: ['_kiro/session/compact'] } },
      },
      authMethods: kiro.signedIn
        ? [{ id: 'aws-builder-id', name: 'AWS Builder ID' }]
        : [{ id: 'kiro-login', name: 'Kiro Login' }],
    }));
    server.on('message', (message: { id?: number; method?: string }) => {
      if (message.id === undefined) return;
      if (message.method === 'session/new' || message.method === 'session/load') {
        if (!kiro.signedIn) {
          server.send({
            id: message.id,
            error: {
              code: -32000,
              message:
                'Authentication required. Not logged in. Set the KIRO_API_KEY environment variable or run `kiro-cli login` first. Then reconnect to start the Kiro agent.',
            },
          });
          return;
        }
        server.send({
          id: message.id,
          result: {
            ...(message.method === 'session/new' ? { sessionId: 'sess_native' } : {}),
            modes: { availableModes: [{ id: 'vibe' }, { id: 'plan' }], currentModeId: 'vibe' },
            configOptions,
          },
        });
      }
    });
    server.replyAlways('session/set_config_option', (params) => ({
      configOptions: configOptions.map((option) =>
        option.id === params.configId ? { ...option, currentValue: params.value } : option
      ),
    }));
    servers.push(server);
    return server;
  },
}));

const { createKiroAdapter, kiroAcp } = await import('./kiro-acp');

beforeEach(() => {
  servers.length = 0;
  kiro.signedIn = true;
});

async function setup(
  options: {
    runtimeMode?: RuntimeMode;
    resume?: boolean;
    model?: string;
    connectors?: string[];
  } = {}
) {
  const adapter = createKiroAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  const connectors = options.connectors ?? [];
  const session = await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: options.runtimeMode ?? 'approval-required',
    env: {},
    mcpServers: {
      switch: { transport: 'stdio', command: 'node', args: ['server.js'], env: { MODE: 'test' } },
      ...Object.fromEntries(
        connectors.map((name) => [name, { transport: 'stdio' as const, command: 'node', args: [] }])
      ),
    },
    connectorMcpServers: connectors,
    ...(options.model ? { model: { id: options.model } } : {}),
    ...(options.resume ? { resume: { nativeSessionId: 'sess_native' } } : {}),
  });
  const server = servers.at(-1)!;
  return { adapter, events, server, session };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Kiro's tool-approval options, as its V3 engine offers them. */
const approvalOptions = [
  { optionId: 'accept', name: 'Allow', kind: 'allow_once' },
  { optionId: 'always-accept', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
  { optionId: 'always-reject', name: 'Always deny', kind: 'reject_always' },
];

function askPermission(
  server: FakeAppServer,
  id: number,
  toolCall: Record<string, unknown>,
  kiroMeta: Record<string, unknown> | undefined,
  options = approvalOptions
) {
  server.send({
    id,
    method: 'session/request_permission',
    params: {
      sessionId: 'sess_native',
      toolCall: { status: 'pending', ...toolCall },
      options,
      ...(kiroMeta ? { _meta: { kiro: kiroMeta } } : {}),
    },
  });
}

function opened(events: ProviderRuntimeEvent[]) {
  return events.filter(
    (e): e is Extract<ProviderRuntimeEvent, { type: 'request.opened' }> =>
      e.type === 'request.opened'
  );
}

it('runs `kiro-cli acp` with no engine, agent, model or trust flags and the exact environment', async () => {
  const env = { PATH: '/bin', HOME: '/home/user', KIRO_API_KEY: 'synthetic' };
  expect(await kiroAcp.launch({ binaryPath: '/opt/kiro-cli', cwd: '/work', env })).toEqual({
    command: '/opt/kiro-cli',
    args: ['acp'],
    env,
  });
});

it('names its login command, passes its API key through and runs on every platform', () => {
  expect(kiroAcp.provider).toBe('kiro');
  expect(kiroAcp.defaultBinary).toBe('kiro-cli');
  expect(kiroAcp.loginCommand).toBe('kiro-cli login');
  expect(kiroAcp.inheritEnv).toEqual(['KIRO_API_KEY']);
  expect(kiroAcp.unsupportedPlatforms).toBeUndefined();
});

it('starts without authenticate or set_mode and offers the models Kiro advertises', async () => {
  const { adapter, server, session } = await setup();
  expect(session.nativeSessionId).toBe('sess_native');
  const methods = server.received.map((m) => m.method);
  expect(methods).not.toContain('authenticate');
  expect(methods).not.toContain('session/set_mode');
  expect(methods).not.toContain('session/set_model');
  expect(await adapter.listModels('s')).toEqual([
    expect.objectContaining({ id: 'auto', label: 'Auto' }),
    expect.objectContaining({ id: 'model-b', label: 'Model B' }),
  ]);
  expect(server.received.find((m) => m.method === 'session/new')?.params).toMatchObject({
    cwd: '/work',
    mcpServers: [{ name: 'switch', command: 'node', args: ['server.js'] }],
  });
});

it('keeps the agent mode the person configured in every runtime mode', () => {
  expect(kiroAcp.sessionMode).toBeUndefined();
});

it('selects the chosen model through the model config option', async () => {
  const { server } = await setup({ model: 'model-b' });
  expect(server.received.find((m) => m.method === 'session/set_config_option')?.params).toEqual({
    sessionId: 'sess_native',
    configId: 'model',
    value: 'model-b',
  });
});

it('resumes the native session with session/load and registers its MCP servers again', async () => {
  const { server, session } = await setup({ resume: true });
  expect(session.nativeSessionId).toBe('sess_native');
  expect(server.received.find((m) => m.method === 'session/load')?.params).toMatchObject({
    sessionId: 'sess_native',
    mcpServers: [{ name: 'switch', command: 'node', args: ['server.js'] }],
  });
});

it('fails to start a signed-out CLI with what Kiro says to do', async () => {
  kiro.signedIn = false;
  await expect(setup()).rejects.toThrow(/run `kiro-cli login`/);
});

it('asks before a shell command, offering allow, allow for this session and deny only', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'run it' });
  askPermission(
    server,
    90,
    { toolCallId: 'op-1', title: 'echo ok > approved.txt' },
    { toolId: 'run_command', command: 'echo ok > approved.txt' }
  );
  const [request] = opened(events);
  expect(request).toMatchObject({
    requestType: 'command_execution_approval',
    title: 'echo ok > approved.txt',
    options: [
      { decision: 'accept', label: 'Allow' },
      { decision: 'acceptForSession', label: 'Always allow' },
      { decision: 'decline', label: 'Deny' },
      { decision: 'cancel', label: 'Cancel' },
    ],
  });
  await adapter.respondToRequest('s', request!.requestId, 'accept');
  await flush();
  expect(server.received.find((m) => m.id === 90)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'accept' },
  });
});

it('answers a declined approval with Kiro’s one-time reject', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'run it' });
  askPermission(
    server,
    91,
    { toolCallId: 'op-2', title: 'rm -rf build' },
    {
      toolId: 'run_command',
      command: 'rm -rf build',
    }
  );
  await adapter.respondToRequest('s', opened(events)[0]!.requestId, 'decline');
  await flush();
  expect(server.received.find((m) => m.id === 91)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'reject' },
  });
});

it('allows everything once without asking in full access', async () => {
  const { adapter, events, server } = await setup({ runtimeMode: 'full-access' });
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'run it' });
  askPermission(
    server,
    92,
    { toolCallId: 'op-3', title: 'make' },
    {
      toolId: 'run_command',
      command: 'make',
    }
  );
  await flush();
  expect(opened(events)).toHaveLength(0);
  expect(server.received.find((m) => m.id === 92)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'accept' },
  });
});

it('accepts edits but still asks before commands in auto-accept-edits', async () => {
  const { adapter, events, server } = await setup({ runtimeMode: 'auto-accept-edits' });
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'edit and run' });
  askPermission(
    server,
    93,
    { toolCallId: 'op-4', title: 'Write marker.txt' },
    {
      toolId: 'fs_write',
    }
  );
  await flush();
  expect(server.received.find((m) => m.id === 93)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'accept' },
  });
  askPermission(
    server,
    94,
    { toolCallId: 'op-5', title: 'npm test' },
    {
      toolId: 'run_command',
      command: 'npm test',
    }
  );
  expect(opened(events)).toHaveLength(1);
  expect(opened(events)[0]!.requestType).toBe('command_execution_approval');
});

it('keeps a kind Kiro does send', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'edit' });
  askPermission(
    server,
    95,
    { toolCallId: 'op-6', title: 'Edit', kind: 'edit' },
    {
      command: 'not a shell command',
    }
  );
  expect(opened(events)[0]!.requestType).toBe('file_change_approval');
});

it('lets the session’s own MCP servers through and asks for connector tools', async () => {
  const { adapter, events, server } = await setup({ connectors: ['github'] });
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'use tools' });
  askPermission(
    server,
    96,
    { toolCallId: 'op-7', title: '@switch/list_rooms' },
    {
      toolId: 'mcp',
      mcpTool: { version: 1, identity: { serverName: 'switch', toolName: 'list_rooms' } },
    }
  );
  await flush();
  expect(opened(events)).toHaveLength(0);
  expect(server.received.find((m) => m.id === 96)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'accept' },
  });
  askPermission(
    server,
    97,
    { toolCallId: 'op-8', title: '@github/create_issue' },
    {
      toolId: 'mcp',
      mcpTool: { version: 1, identity: { serverName: 'github', toolName: 'create_issue' } },
    }
  );
  expect(opened(events)).toEqual([
    expect.objectContaining({ requestType: 'mcp_tool_approval', connector: 'github' }),
  ]);
});

it('reads the MCP server from a tool call Kiro announced before asking', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'use tools' });
  server.notify('session/update', {
    sessionId: 'sess_native',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'op-9',
      kind: 'other',
      title: 'list_rooms',
      status: 'in_progress',
      _meta: { kiro: { serverName: 'switch' } },
    },
  });
  askPermission(server, 98, { toolCallId: 'op-9' }, { toolId: 'mcp' });
  await flush();
  expect(opened(events)).toHaveLength(0);
  expect(events.find((e) => e.type === 'item.started')).toMatchObject({
    item: { id: 'op-9', type: 'mcp_tool_call' },
  });
});

it('asks Kiro’s questions as questions and answers with the chosen option', async () => {
  const { adapter, events, server } = await setup({ runtimeMode: 'full-access' });
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'ask me' });
  askPermission(server, 99, { toolCallId: 'ask-1', title: 'Which color?' }, undefined, [
    { optionId: 'red', name: 'Red', kind: 'allow_once' },
    { optionId: 'green', name: 'Green', kind: 'allow_once' },
    { optionId: 'blue', name: 'Blue', kind: 'allow_once' },
  ]);
  expect(opened(events)).toHaveLength(0);
  const request = events.find((e) => e.type === 'user-input.requested');
  if (!request || request.type !== 'user-input.requested') throw new Error('No question');
  expect(request.questions).toEqual([
    expect.objectContaining({
      id: 'ask-1',
      question: 'Which color?',
      multiSelect: false,
      options: [
        { value: 'red', label: 'Red' },
        { value: 'green', label: 'Green' },
        { value: 'blue', label: 'Blue' },
      ],
    }),
  ]);
  await adapter.respondToUserInput('s', request.requestId, { 'ask-1': 'green' });
  await flush();
  expect(server.received.find((m) => m.id === 99)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'green' },
  });
});

it('cancels an unanswered question when the turn is interrupted', async () => {
  const { adapter, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'ask me' });
  askPermission(server, 100, { toolCallId: 'ask-2', title: 'Which?' }, undefined, [
    { optionId: 'a', name: 'A', kind: 'allow_once' },
  ]);
  await adapter.interruptTurn('s');
  await flush();
  expect(server.received.find((m) => m.id === 100)?.result).toEqual({
    outcome: { outcome: 'cancelled' },
  });
});

it('shows Kiro’s sub-agent tasks as subagents', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'delegate' });
  server.notify('session/update', {
    sessionId: 'sess_native',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'sub-1',
      kind: 'other',
      title: 'Sub-agent: context-gatherer',
      status: 'in_progress',
      _meta: { kiro: { kind: 'agent-subtask', agentSubtaskId: 'child' } },
    },
  });
  server.notify('session/update', {
    sessionId: 'sess_native',
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'sub-1',
      status: 'completed',
      rawOutput: { response: 'README first line' },
    },
  });
  expect(events.find((e) => e.type === 'item.started')).toMatchObject({
    item: { id: 'sub-1', type: 'subagent', title: 'Sub-agent: context-gatherer' },
  });
  expect(events.find((e) => e.type === 'item.completed')).toMatchObject({
    item: { id: 'sub-1', type: 'subagent', status: 'completed' },
  });
});

it('queues a message sent mid-turn and ends each turn on its prompt response', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 'one', text: 'first' });
  await adapter.sendTurn({ sessionId: 's', turnId: 'two', text: 'second' });
  const prompt = await server.waitFor('session/prompt');
  expect(server.received.filter((m) => m.method === 'session/prompt')).toHaveLength(1);
  server.send({ id: prompt.id, result: { stopReason: 'end_turn' } });
  await flush();
  expect(events.find((e) => e.type === 'turn.completed')).toMatchObject({
    turnId: 'one',
    outcome: 'completed',
  });
  expect(server.received.filter((m) => m.method === 'session/prompt')).toHaveLength(2);
});

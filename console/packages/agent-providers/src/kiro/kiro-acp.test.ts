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
const spawned: Array<{ command: string; args: string[] }> = [];
/**
 * `initialize` as kiro-cli 3.1.0 answers it while signed out (recorded), and
 * a signed-in answer as Kiro's V3 migration guide describes one. A signed-in
 * 3.1.0 handshake was not recorded: no Kiro account was available.
 */
const signedOutInitialize = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: false,
    promptCapabilities: { image: false, audio: false, embeddedContext: false },
    mcpCapabilities: { http: false, sse: false },
    sessionCapabilities: {},
    auth: {},
  },
  authMethods: [{ id: 'kiro-login', name: 'Kiro Login' }],
  agentInfo: { name: 'Kiro CLI Agent', title: 'Kiro CLI Agent', version: '3.1.0' },
};
const signedInInitialize = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true },
    mcpCapabilities: { http: true },
    sessionCapabilities: { list: {} },
    _meta: { kiro: { extensionMethods: ['_kiro/session/compact', '_kiro/account/getUsage'] } },
  },
  authMethods: [],
};
const kiroSession = {
  sessionId: 'native',
  modes: {
    currentModeId: 'vibe',
    availableModes: [
      { id: 'vibe', name: 'Vibe' },
      { id: 'planner', name: 'Planner' },
    ],
  },
  configOptions: [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'auto',
      options: [
        { value: 'auto', name: 'Auto' },
        { value: 'claude-sonnet', name: 'Claude Sonnet' },
      ],
    },
  ],
};
let initialize: unknown = signedInInitialize;
vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[]) => {
    spawned.push({ command, args });
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => initialize);
    server.replyAlways('session/new', () => kiroSession);
    server.replyAlways('session/load', () => ({ modes: kiroSession.modes }));
    server.replyAlways('session/set_mode', () => ({}));
    server.replyAlways('session/set_config_option', () => ({}));
    servers.push(server);
    return server;
  },
}));
const { kiroAcp, kiroMcpServer, createKiroAdapter } = await import('./kiro-acp');

beforeEach(() => {
  servers.length = 0;
  spawned.length = 0;
  initialize = signedInInitialize;
});

async function setup(input: { runtimeMode?: RuntimeMode; resume?: string; model?: string } = {}) {
  const adapter = createKiroAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  const session = await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: input.runtimeMode ?? 'approval-required',
    env: {},
    mcpServers: {
      switch: {
        transport: 'http',
        url: 'http://127.0.0.1:4567/mcp',
        headers: { Authorization: 'Bearer per-session' },
      },
    },
    connectorMcpServers: [],
    ...(input.resume ? { resume: { nativeSessionId: input.resume } } : {}),
    ...(input.model ? { model: { id: input.model } } : {}),
  });
  return { adapter, events, server: servers.at(-1)!, session };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

it('starts kiro-cli acp on the V3 engine, with no sign-in call, in Kiro’s own mode', async () => {
  const { server, session } = await setup();
  expect(spawned.at(-1)).toEqual({ command: 'kiro-cli', args: ['acp', '--agent-engine=v3'] });
  expect(session.nativeSessionId).toBe('native');
  expect(server.received.some((m) => m.method === 'authenticate')).toBe(false);
  // Kiro's modes are agent configurations, not permission levels.
  expect(server.received.some((m) => m.method === 'session/set_mode')).toBe(false);
  expect(server.received.find((m) => m.method === 'session/new')?.params).toMatchObject({
    cwd: '/work',
    mcpServers: [
      {
        type: 'http',
        name: 'switch',
        url: 'http://127.0.0.1:4567/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer per-session' }],
      },
    ],
  });
});

it('registers HTTP MCP servers only when Kiro advertises them', async () => {
  initialize = { ...signedInInitialize, agentCapabilities: signedOutInitialize.agentCapabilities };
  await expect(setup()).rejects.toThrow('Kiro CLI does not declare MCP over HTTP');
});

it('resumes the exact native session through session/load, sending the MCP servers again', async () => {
  const { server, session } = await setup({ resume: 'saved', runtimeMode: 'full-access' });
  expect(session.nativeSessionId).toBe('saved');
  expect(server.received.find((m) => m.method === 'session/load')?.params).toMatchObject({
    sessionId: 'saved',
    cwd: '/work',
    mcpServers: [{ type: 'http', name: 'switch' }],
  });
});

it('lists the models of its model option and selects the chosen one', async () => {
  const { adapter, server } = await setup({ model: 'claude-sonnet' });
  expect((await adapter.listModels('s')).map((model) => model.id)).toEqual([
    'auto',
    'claude-sonnet',
  ]);
  expect(server.received.find((m) => m.method === 'session/set_config_option')?.params).toEqual({
    sessionId: 'native',
    configId: 'model',
    value: 'claude-sonnet',
  });
  expect(server.received.some((m) => m.method === 'session/set_model')).toBe(false);
});

it('answers Kiro permission requests with the options it offered', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  // The options of Kiro's V3 migration guide.
  const options = [
    { optionId: 'accept', name: 'Allow', kind: 'allow_once' },
    { optionId: 'always-accept', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
    { optionId: 'always-reject', name: 'Always deny', kind: 'reject_always' },
  ];
  for (const id of [70, 71])
    server.send({
      id,
      method: 'session/request_permission',
      params: {
        sessionId: 'native',
        toolCall: { toolCallId: `call-${id}`, title: 'Run tests', status: 'pending' },
        options,
      },
    });
  await flush();
  const opened = events.filter((e) => e.type === 'request.opened');
  expect(opened).toHaveLength(2);
  for (const [event, decision] of [
    [opened[0], 'accept'],
    [opened[1], 'decline'],
  ] as const) {
    if (event?.type !== 'request.opened') throw new Error('No approval');
    await adapter.respondToRequest('s', event.requestId, decision);
  }
  await flush();
  expect([70, 71].map((id) => server.received.find((m) => m.id === id)?.result)).toEqual([
    { outcome: { outcome: 'selected', optionId: 'accept' } },
    { outcome: { outcome: 'selected', optionId: 'reject' } },
  ]);
});

it('runs the session’s own MCP tools without asking, named by Kiro’s mcpTool identity', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  for (const [toolCallId, serverName] of [
    ['mcp-call', 'switch'],
    ['other-call', 'elsewhere'],
  ])
    server.notify('session/update', {
      sessionId: 'native',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId,
        title: `@${serverName}/list_rooms`,
        kind: 'other',
        status: 'pending',
        _meta: {
          kiro: { mcpTool: { version: 1, identity: { serverName, toolName: 'list_rooms' } } },
        },
      },
    });
  const options = [
    { optionId: 'accept', name: 'Allow', kind: 'allow_once' },
    { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
  ];
  for (const [id, toolCallId] of [
    [80, 'mcp-call'],
    [81, 'other-call'],
  ] as const)
    server.send({
      id,
      method: 'session/request_permission',
      params: { sessionId: 'native', toolCall: { toolCallId }, options },
    });
  await flush();
  expect(server.received.find((m) => m.id === 80)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'accept' },
  });
  expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(1);
});

it('uses request-level MCP identity and fails closed on invalid or conflicting identities', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });

  // Updates establish identities independently of the later request payloads.
  for (const [toolCallId, serverName] of [
    ['unknown-version', 'switch'],
    ['conflict', 'switch'],
    ['malformed', 'switch'],
    ['nested-conflict', 'elsewhere'],
    ['nested-without-request', 'elsewhere'],
  ]) {
    server.notify('session/update', {
      sessionId: 'native',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId,
        title: '@switch/list_rooms',
        status: 'pending',
        _meta: { kiro: { mcpTool: { version: 1, identity: { serverName } } } },
      },
    });
  }
  const options = [
    { optionId: 'accept', name: 'Allow', kind: 'allow_once' },
    { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
  ];
  const calls = [
    {
      id: 100,
      toolCallId: 'registered',
      mcpTool: { version: 1, identity: { serverName: 'switch' } },
    },
    {
      id: 101,
      toolCallId: 'unregistered',
      mcpTool: { version: 1, identity: { serverName: 'elsewhere' } },
    },
    {
      id: 102,
      toolCallId: 'unknown-version',
      mcpTool: { version: 2, identity: { serverName: 'switch' } },
    },
    {
      id: 103,
      toolCallId: 'conflict',
      mcpTool: { version: 1, identity: { serverName: 'elsewhere' } },
    },
    { id: 104, toolCallId: 'malformed', mcpTool: null },
  ];
  for (const { id, toolCallId, mcpTool } of calls) {
    server.send({
      id,
      method: 'session/request_permission',
      params: {
        sessionId: 'native',
        toolCall: { toolCallId, title: '@switch/list_rooms' },
        options,
        _meta: { kiro: { mcpTool } },
      },
    });
  }
  // A nested permission-toolCall identity must not hide a conflicting update,
  // whether or not request-level metadata is also present.
  for (const [id, toolCallId, includeRequestMeta] of [
    [105, 'nested-conflict', true],
    [106, 'nested-without-request', false],
  ] as const) {
    const mcpTool = { version: 1, identity: { serverName: 'switch' } };
    server.send({
      id,
      method: 'session/request_permission',
      params: {
        sessionId: 'native',
        toolCall: { toolCallId, _meta: { kiro: { mcpTool } } },
        options,
        ...(includeRequestMeta ? { _meta: { kiro: { mcpTool } } } : {}),
      },
    });
  }
  await flush();
  expect(server.received.find((m) => m.id === 100)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'accept' },
  });
  for (const id of [101, 102, 103, 104, 105, 106]) {
    expect(server.received.find((m) => m.id === id)?.result).toBeUndefined();
  }
  expect(events.filter((event) => event.type === 'request.opened')).toHaveLength(6);
  await adapter.stopAll();
});

it('retains conflicting or malformed update identities and rejects malformed nested identities', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  const toolIdentity = (serverName: string, version = 1) => ({
    kiro: { mcpTool: { version, identity: { serverName } } },
  });
  const update = (toolCallId: string, meta: unknown) =>
    server.notify('session/update', {
      sessionId: 'native',
      update: { sessionUpdate: 'tool_call_update', toolCallId, _meta: meta },
    });

  // A later valid update cannot erase either a conflicting server or a prior
  // unknown-version identity for the same call.
  update('conflicting-updates', toolIdentity('elsewhere'));
  update('conflicting-updates', toolIdentity('switch'));
  update('malformed-update', toolIdentity('switch'));
  update('malformed-update', toolIdentity('switch', 2));
  update('malformed-update', toolIdentity('switch'));
  update('malformed-nested', toolIdentity('switch'));
  update('absent-nested', toolIdentity('switch'));

  const options = [
    { optionId: 'accept', name: 'Allow', kind: 'allow_once' },
    { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
  ];
  for (const [id, toolCallId, nestedMeta] of [
    [120, 'conflicting-updates', undefined],
    [121, 'malformed-update', undefined],
    [122, 'malformed-nested', toolIdentity('switch', 2)],
    [123, 'absent-nested', undefined],
  ] as const) {
    server.send({
      id,
      method: 'session/request_permission',
      params: {
        sessionId: 'native',
        toolCall: { toolCallId, ...(nestedMeta ? { _meta: nestedMeta } : {}) },
        options,
        _meta: toolIdentity('switch'),
      },
    });
  }
  await flush();
  for (const id of [120, 121, 122]) {
    expect(server.received.find((message) => message.id === id)?.result).toBeUndefined();
  }
  expect(server.received.find((message) => message.id === 123)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'accept' },
  });
  expect(events.filter((event) => event.type === 'request.opened')).toHaveLength(3);
  await adapter.stopAll();
});

it('fails closed on malformed metadata containers but preserves fallback for unrelated metadata', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  const metadataCases: Array<{ id: number; meta?: unknown; shouldApprove: boolean }> = [
    { id: 110, meta: null, shouldApprove: false },
    { id: 111, meta: 'invalid', shouldApprove: false },
    { id: 112, meta: [], shouldApprove: false },
    { id: 113, meta: { kiro: null }, shouldApprove: false },
    { id: 114, meta: { kiro: 'invalid' }, shouldApprove: false },
    { id: 115, meta: { kiro: [] }, shouldApprove: false },
    { id: 116, meta: { other: { name: 'unrelated' } }, shouldApprove: true },
    { id: 117, meta: { kiro: { consent: { capability: 'shell' } } }, shouldApprove: true },
    { id: 118, shouldApprove: true },
  ];
  for (const { id } of metadataCases) {
    server.notify('session/update', {
      sessionId: 'native',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: `metadata-${id}`,
        title: '@switch/list_rooms',
        status: 'pending',
        _meta: { kiro: { mcpTool: { version: 1, identity: { serverName: 'switch' } } } },
      },
    });
  }
  const options = [
    { optionId: 'accept', name: 'Allow', kind: 'allow_once' },
    { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
  ];
  for (const { id, meta } of metadataCases) {
    server.send({
      id,
      method: 'session/request_permission',
      params: {
        sessionId: 'native',
        toolCall: { toolCallId: `metadata-${id}` },
        options,
        ...(meta !== undefined ? { _meta: meta } : {}),
      },
    });
  }
  await flush();
  for (const { id, shouldApprove } of metadataCases) {
    const response = server.received.find((message) => message.id === id)?.result;
    if (shouldApprove) {
      expect(response).toEqual({ outcome: { outcome: 'selected', optionId: 'accept' } });
    } else {
      expect(response).toBeUndefined();
    }
  }
  expect(events.filter((event) => event.type === 'request.opened')).toHaveLength(6);
  await adapter.stopAll();
});

it('recognizes Kiro subagent calls without misclassifying nested tool calls', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  for (const update of [
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'task',
      title: 'Delegate',
      status: 'pending',
      _meta: { kiro: { kind: 'agent-subtask' } },
    },
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'child',
      title: 'Read',
      status: 'pending',
      kind: 'execute',
      _meta: { kiro: { agentSubtaskId: 'task' } },
    },
    { sessionUpdate: 'tool_call_update', toolCallId: 'task', status: 'completed' },
  ])
    server.notify('session/update', { sessionId: 'native', update });
  await flush();
  const started = events.filter((event) => event.type === 'item.started');
  expect(started).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ item: expect.objectContaining({ id: 'task', type: 'subagent' }) }),
      expect.objectContaining({
        item: expect.objectContaining({ id: 'child', type: 'command_execution' }),
      }),
    ])
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'item.completed',
      item: expect.objectContaining({ id: 'task', type: 'subagent', status: 'completed' }),
    })
  );
  await adapter.stopAll();
});

it('reads only a version 1 mcpTool identity, never the title', () => {
  expect(
    kiroMcpServer({ _meta: { kiro: { mcpTool: { version: 1, identity: { serverName: 's' } } } } })
  ).toBe('s');
  expect(
    kiroMcpServer({ _meta: { kiro: { mcpTool: { version: 2, identity: { serverName: 's' } } } } })
  ).toBe(undefined);
  expect(kiroMcpServer({ _meta: { kiro: { mcpTool: { version: 1, identity: {} } } } })).toBe(
    undefined
  );
  expect(kiroMcpServer({})).toBe(undefined);
});

it('checks the sign-in with what Kiro answers after the handshake, never signing it in', async () => {
  const requests: string[] = [];
  const check = (answer: () => unknown) =>
    kiroAcp.checkSignIn!({
      binaryPath: 'kiro-cli',
      cwd: '/work',
      env: {},
      handshake: async () => signedOutInitialize,
      request: async <T>(method: string) => {
        requests.push(method);
        return answer() as T;
      },
    });
  await expect(check(() => ({ sessions: [] }))).resolves.toMatchObject({
    status: 'authenticated',
  });
  // kiro-cli 3.1.0's answer to every request after `initialize` while signed out.
  await expect(
    check(() => {
      throw new Error(
        'Authentication required. Not logged in. Set the KIRO_API_KEY environment variable or run `kiro-cli login` first. Then reconnect to start the Kiro agent.'
      );
    })
  ).resolves.toMatchObject({
    status: 'unauthenticated',
    message: 'Sign in on the execution machine with kiro-cli login.',
  });
  await expect(
    check(() => {
      throw new Error('Method not found (-32601)');
    })
  ).resolves.toMatchObject({ status: 'authenticated' });
  await expect(
    check(() => {
      throw new Error('boom');
    })
  ).rejects.toThrow('boom');
  expect(requests).toEqual(['session/list', 'session/list', 'session/list', 'session/list']);
});

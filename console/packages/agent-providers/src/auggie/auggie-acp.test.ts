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
/** An `mcpCapabilities` the fake agent declares; real Auggie declares none. */
const acp: { mcpCapabilities?: { http: boolean } } = {};
vi.mock('node:child_process', () => ({
  spawn: () => {
    const server = new FakeAppServer();
    // What `auggie --acp` 0.37.0 answers, signed in or out.
    server.replyAlways('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true },
        sessionCapabilities: { list: {} },
        ...acp,
      },
      authMethods: [],
    }));
    server.replyAlways('authenticate', () => ({}));
    // 0.37.0 offers its models in `session/new`, with no `model` config option.
    server.replyAlways('session/new', () => ({
      sessionId: 'native',
      models: {
        currentModelId: 'model-a',
        availableModels: [
          { modelId: 'model-a', name: 'Model A' },
          { modelId: 'model-b', name: 'Model B' },
        ],
      },
    }));
    server.replyAlways('session/load', () => ({}));
    server.replyAlways('session/set_mode', () => ({}));
    server.replyAlways('session/set_model', () => ({}));
    servers.push(server);
    return server;
  },
}));
const { auggieAcp, createAuggieAdapter, parseAuggieStatus, AUGGIE_INDEXING_PERMISSION } =
  await import('./auggie-acp');
beforeEach(() => {
  servers.length = 0;
  delete acp.mcpCapabilities;
});
async function setup(resume = false, runtimeMode: RuntimeMode = 'approval-required') {
  const adapter = createAuggieAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  const session = await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode,
    env: {},
    mcpServers: {
      switch: { transport: 'stdio', command: 'node', args: ['server.js'], env: { MODE: 'test' } },
    },
    connectorMcpServers: [],
    ...(resume ? { resume: { nativeSessionId: 'native' } } : {}),
  });
  const server = servers.at(-1)!;
  return { adapter, events, server, session };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const runBuild = { kind: 'execute', title: 'Run build', toolCallId: 'run' };
const switchOverHttp = {
  switch: {
    transport: 'http' as const,
    url: 'http://127.0.0.1:4567/mcp',
    headers: { Authorization: 'Bearer per-session' },
  },
};
/** Auggie's indexing consent, exactly as 0.37.0 sends it. */
const indexing = (id: number) => ({
  id,
  method: 'session/request_permission',
  params: {
    sessionId: 'native',
    toolCall: { toolCallId: AUGGIE_INDEXING_PERMISSION, title: 'Workspace Indexing Permission' },
    options: [
      { optionId: 'always-enable', name: 'Always index', kind: 'allow_always' },
      { optionId: 'always-disable', name: 'Never index', kind: 'reject_always' },
      { optionId: 'session-enable', name: 'Index for this session', kind: 'allow_once' },
      { optionId: 'session-disable', name: 'Skip for this session', kind: 'reject_once' },
    ],
  },
});
async function startOverHttp(runtimeMode: RuntimeMode = 'approval-required') {
  const adapter = createAuggieAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode,
    env: {},
    mcpServers: switchOverHttp,
    connectorMcpServers: [],
  });
  return { adapter, events, server: servers.at(-1)! };
}

it('starts auggie in ACP mode with exactly the environment it was given', async () => {
  expect(
    await auggieAcp.launch({ binaryPath: '/bin/auggie', cwd: '/work', env: { A: '1' } })
  ).toEqual({ command: '/bin/auggie', args: ['--acp'], env: { A: '1' } });
});

it('names its sign-in command and passes its session variable through', () => {
  expect(auggieAcp.loginCommand).toBe('auggie login');
  expect(auggieAcp.inheritEnv).toEqual(['AUGMENT_SESSION_AUTH', 'AUGMENT_DISABLE_AUTO_UPDATE']);
});

it.each([
  // `auggie account status --json`, 0.37.0, signed out: exit 1, on stderr.
  "You are not currently logged in to Augment.\n   Run 'auggie login' to authenticate first.\n",
  'Authentication required',
])('reads signed-out Auggie with the sign-in hint: %s', (output) => {
  expect(parseAuggieStatus(output, false)).toEqual({
    status: 'unauthenticated',
    message: 'Sign in on the execution machine with auggie login.',
    models: [],
  });
});

it('takes a clean status exit as signed in, without returning account details', () => {
  expect(parseAuggieStatus('{"planName":"Some Plan","amountRemaining":"12.5"}', true)).toEqual({
    status: 'authenticated',
    message: 'Signed in.',
    models: [],
  });
});

it('keeps any other status failure unknown, never signed in', () => {
  expect(
    parseAuggieStatus('Cannot retrieve account status: API server not available', false).status
  ).toBe('unknown');
  expect(parseAuggieStatus('', false).status).toBe('unknown');
});

it('gives Auggie the Switch MCP server over HTTP although initialize does not declare it', async () => {
  const { server } = await startOverHttp();
  expect(server.received.find((m) => m.method === 'session/new')?.params?.mcpServers).toEqual([
    {
      type: 'http',
      name: 'switch',
      url: 'http://127.0.0.1:4567/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer per-session' }],
    },
  ]);
});

it('skips indexing asked before any turn, without telling Auggie to remember it', async () => {
  const { events, server } = await startOverHttp('full-access');
  server.send(indexing(70));
  await flush();
  expect(events.some((e) => e.type === 'request.opened')).toBe(false);
  expect(server.received.find((m) => m.id === 70)?.result).toEqual({
    outcome: { outcome: 'cancelled' },
  });
});

it.each(['full-access', 'approval-required'] as const)(
  'skips indexing asked in the first turn (%s), without asking or holding the turn up',
  async (runtimeMode) => {
    const { adapter, events, server } = await startOverHttp(runtimeMode);
    await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'hello' });
    server.send(indexing(71));
    await flush();
    expect(events.some((e) => e.type === 'request.opened')).toBe(false);
    // "Skip for this session": never "Always index", which Auggie would store.
    expect(server.received.find((m) => m.id === 71)?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'session-disable' },
    });
  }
);

it('lists Auggie models and starts on the chosen one through session/set_model', async () => {
  const adapter = createAuggieAdapter();
  await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: 'approval-required',
    env: {},
    model: { id: 'model-b' },
    mcpServers: {},
    connectorMcpServers: [],
  });
  expect((await adapter.listModels('s')).map((m) => m.id)).toEqual(['model-a', 'model-b']);
  expect(servers.at(-1)!.received.find((m) => m.method === 'session/set_model')?.params).toEqual({
    sessionId: 'native',
    modelId: 'model-b',
  });
});

it('leaves the agent in its own mode and sends no sign-in when a session starts', async () => {
  const { server } = await setup();
  expect(server.received.some((m) => m.method === 'authenticate')).toBe(false);
  expect(server.received.some((m) => m.method === 'session/set_mode')).toBe(false);
});

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

/** A tool approval as 0.37.0 sends one: only "Allow" and "Deny", never an "always". */
const toolApproval = (id: number) => ({
  id,
  method: 'session/request_permission',
  params: {
    sessionId: 'native',
    toolCall: runBuild,
    options: [
      { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
    ],
  },
});

it('asks before running a tool in approval-required', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'build' });
  server.send(toolApproval(99));
  await flush();
  const request = events.find((e) => e.type === 'request.opened');
  if (!request || request.type !== 'request.opened') throw new Error('missing approval');
  expect(request.requestType).toBe('command_execution_approval');
  expect(request.options.map((o) => o.label)).toEqual(['Allow', 'Deny', 'Cancel']);
  await adapter.respondToRequest('s', request.requestId, 'accept');
  await flush();
  expect(server.received.find((m) => m.id === 99)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'allow_once' },
  });
});

it('answers a declined approval with the rejection Auggie offered', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'build' });
  server.send(toolApproval(98));
  await flush();
  const request = events.find((e) => e.type === 'request.opened');
  if (!request || request.type !== 'request.opened') throw new Error('missing approval');
  await adapter.respondToRequest('s', request.requestId, 'decline');
  await flush();
  expect(server.received.find((m) => m.id === 98)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'reject_once' },
  });
});

it('approves tools by itself in full access, which is how Auggie auto-approves', async () => {
  const { adapter, events, server } = await setup(false, 'full-access');
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'build' });
  server.send(toolApproval(77));
  await flush();
  expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(0);
  expect(server.received.find((m) => m.id === 77)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'allow_once' },
  });
});

it('interrupts the native turn and queues a message sent mid-turn', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 'one', text: 'first' });
  await adapter.sendTurn({ sessionId: 's', turnId: 'two', text: 'second' });
  const prompt = await server.waitFor('session/prompt');
  expect(server.received.filter((m) => m.method === 'session/prompt')).toHaveLength(1);
  await adapter.interruptTurn('s');
  await flush();
  expect(server.received.find((m) => m.method === 'session/cancel')?.params).toEqual({
    sessionId: 'native',
  });
  server.send({ id: prompt.id, result: { stopReason: 'cancelled' } });
  await flush();
  expect(events.find((e) => e.type === 'turn.completed')).toMatchObject({
    turnId: 'one',
    outcome: 'interrupted',
  });
  expect(server.received.filter((m) => m.method === 'session/prompt')).toHaveLength(2);
});

it('refuses HTTP MCP servers once a later Auggie declares it cannot take them', async () => {
  acp.mcpCapabilities = { http: false };
  const adapter = createAuggieAdapter();
  await expect(
    adapter.startSession({
      sessionId: 'no-http',
      cwd: '/work',
      runtimeMode: 'approval-required',
      env: {},
      mcpServers: switchOverHttp,
      connectorMcpServers: [],
    })
  ).rejects.toThrow('Auggie CLI does not declare MCP over HTTP');
  expect(servers.at(-1)!.received.some((m) => m.method === 'session/new')).toBe(false);
});

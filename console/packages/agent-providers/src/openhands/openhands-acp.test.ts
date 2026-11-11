import type * as fs from 'node:fs/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProviderSessionStartInput } from '../adapter';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';

const files = vi.hoisted(() => ({
  text: JSON.stringify({ llm: { model: 'openai/configured-model' } }),
  error: undefined as NodeJS.ErrnoException | undefined,
  read: vi.fn(),
}));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async () => '/resolved/work',
  readFile: async (path: string) => {
    files.read(path);
    if (files.error) throw files.error;
    return files.text;
  },
}));
const spawned: Array<{ command: string; args: string[]; options: unknown }> = [];
const servers: FakeAppServer[] = [];
vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[], options: unknown) => {
    spawned.push({ command, args, options });
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      authMethods: [{ id: 'oauth', name: 'OAuth with OpenHands Cloud' }],
      agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } },
    }));
    server.replyAlways('session/new', () => ({ sessionId: 'native-id' }));
    server.replyAlways('session/load', () => ({}));
    server.replyAlways('session/set_mode', () => ({}));
    servers.push(server);
    return server;
  },
}));
const { createOpenHandsAdapter, openhandsAcp } = await import('./openhands-acp');
const { checkAcpSignIn } = await import('../acp/acp-adapter');
const adapters: ReturnType<typeof createOpenHandsAdapter>[] = [];
const input: ProviderSessionStartInput = {
  sessionId: 's',
  cwd: '/work',
  env: { HOME: '/execution-home' },
  runtimeMode: 'approval-required' as const,
  mcpServers: { switch: { transport: 'http' as const, url: 'https://switch.example/mcp' } },
  connectorMcpServers: [],
  systemContext: 'Read room context through the Switch MCP server before answering mentions.',
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
beforeEach(() => {
  files.text = JSON.stringify({ llm: { model: 'openai/configured-model' } });
  files.error = undefined;
  files.read.mockClear();
  spawned.length = 0;
  servers.length = 0;
});
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.stopAll()));
});

async function start(overrides: Partial<ProviderSessionStartInput> = {}) {
  const adapter = createOpenHandsAdapter({ binaryPath: '/isolated/bin/openhands' });
  adapters.push(adapter);
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  await adapter.startSession({ ...input, ...overrides });
  return { adapter, events, server: servers.at(-1)! };
}

it('checks saved configuration without launching a process or OAuth', async () => {
  const result = await checkAcpSignIn(openhandsAcp, { ...input, binaryPath: 'openhands' });
  expect(result).toMatchObject({
    status: 'authenticated',
    models: [{ id: 'openai/configured-model' }],
  });
  expect(files.read).toHaveBeenCalledWith('/execution-home/.openhands/agent_settings.json');
  expect(spawned).toEqual([]);
});

it('uses the execution machine persistence directory, including relative overrides', async () => {
  await openhandsAcp.checkSignIn!({
    ...input,
    binaryPath: 'openhands',
    env: { OPENHANDS_PERSISTENCE_DIR: 'profile' },
    handshake: vi.fn(),
  });
  expect(files.read).toHaveBeenCalledWith('/resolved/work/profile/agent_settings.json');
});

it('reports signed-out and unreadable settings without leaking error details', async () => {
  files.error = Object.assign(new Error('private settings content'), { code: 'ENOENT' });
  const signedOut = await checkAcpSignIn(openhandsAcp, { ...input, binaryPath: 'openhands' });
  expect(signedOut).toMatchObject({ status: 'unauthenticated' });
  expect(signedOut.message).toContain('openhands login');
  expect(signedOut.message).toContain('/settings');
  files.error.code = 'EACCES';
  const unreadable = await checkAcpSignIn(openhandsAcp, { ...input, binaryPath: 'openhands' });
  expect(unreadable.status).toBe('unknown');
  expect(JSON.stringify(unreadable)).not.toContain('private settings content');
  expect(spawned).toEqual([]);
});

it.each(['{invalid', '{}', '{"llm":{"model":""}}', '{"llm":{"model":" model "}}'])(
  'rejects invalid settings: %s',
  async (text) => {
    files.text = text;
    expect((await checkAcpSignIn(openhandsAcp, { ...input, binaryPath: 'openhands' })).status).toBe(
      'unconfigured'
    );
  }
);

it('starts native ACP in the resolved working directory without login or bypass flags', async () => {
  const { server } = await start();
  expect(spawned).toMatchObject([
    {
      command: '/isolated/bin/openhands',
      args: ['acp'],
      options: {
        cwd: '/resolved/work',
        env: {
          HOME: '/execution-home',
          OPENHANDS_WORK_DIR: '/resolved/work',
          OPENHANDS_SUPPRESS_BANNER: '1',
        },
      },
    },
  ]);
  expect(server.received.map((message) => message.method)).toEqual([
    'initialize',
    'session/new',
    'session/set_mode',
  ]);
  expect(server.received[1]?.params).toMatchObject({
    cwd: '/resolved/work',
    mcpServers: [{ type: 'http', name: 'switch', url: 'https://switch.example/mcp' }],
  });
});

it('lists only the configured model and rejects the native no-op model switch', async () => {
  const { adapter, server } = await start();
  expect(await adapter.listModels('s')).toEqual([
    { id: 'openai/configured-model', label: 'openai/configured-model', options: {} },
  ]);
  await adapter.setModel('s', { id: 'openai/configured-model' });
  await expect(adapter.setModel('s', { id: 'different-model' })).rejects.toThrow('cannot switch');
  await expect(adapter.setModel('missing', { id: 'openai/configured-model' })).rejects.toThrow();
  expect(server.received.some((message) => message.method === 'session/set_model')).toBe(false);
});

it('refuses a mismatched initial model before spawning and accepts the configured selection', async () => {
  const adapter = createOpenHandsAdapter();
  adapters.push(adapter);
  await expect(
    adapter.startSession({ ...input, model: { id: 'different-model' } })
  ).rejects.toThrow('cannot switch');
  expect(spawned).toEqual([]);
  await adapter.startSession({ ...input, model: { id: 'openai/configured-model' } });
});

it('resumes the exact native session with MCP registration on a fresh adapter', async () => {
  const adapter = createOpenHandsAdapter();
  adapters.push(adapter);
  await adapter.startSession({ ...input, resume: { nativeSessionId: 'saved-id' } });
  expect(
    servers[0]?.received.find((message) => message.method === 'session/load')?.params
  ).toMatchObject({ sessionId: 'saved-id', cwd: '/resolved/work' });
});

const permission = (sessionId = 'native-id') => ({
  sessionId,
  toolCall: { toolCallId: 'confirmation', title: 'Confirm Agent Actions', kind: 'other' },
  options: [
    { optionId: 'accept', name: 'Yes, proceed', kind: 'allow_once' },
    { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    { optionId: 'always_proceed', name: "Always proceed (don't ask again)", kind: 'allow_always' },
    { optionId: 'risk_based', name: 'Auto-confirm low risk', kind: 'allow_once' },
  ],
});

it.each(['accept', 'decline'] as const)(
  'reports tools and securely answers %s',
  async (decision) => {
    const { adapter, events, server } = await start();
    await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'run command' });
    server.notify('session/update', {
      sessionId: 'native-id',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool',
        kind: 'execute',
        title: 'Run command',
      },
    });
    server.send({ id: 100, method: 'session/request_permission', params: permission() });
    const request = events.find((event) => event.type === 'request.opened');
    if (!request || request.type !== 'request.opened') throw new Error('missing permission');
    expect(request.options.filter((option) => option.decision === 'accept')).toHaveLength(1);
    await adapter.respondToRequest('s', request.requestId, decision);
    await flush();
    expect(server.received.find((message) => message.id === 100)?.result).toEqual({
      outcome: { outcome: 'selected', optionId: decision === 'accept' ? 'accept' : 'reject' },
    });
    expect(events.some((event) => event.type === 'item.started')).toBe(true);
  }
);

it('auto-approves once only in full access through Switch, with no native bypass mode', async () => {
  const { adapter, events, server } = await start({ runtimeMode: 'full-access' });
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'run command' });
  server.send({ id: 101, method: 'session/request_permission', params: permission() });
  await flush();
  expect(server.received.find((message) => message.id === 101)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'accept' },
  });
  expect(events.some((event) => event.type === 'request.opened')).toBe(false);
  expect(
    server.received.find((message) => message.method === 'session/set_mode')?.params
  ).toMatchObject({ modeId: 'always-ask' });
});

it('queues room context, cancels pending approval, and drains only after native cancellation', async () => {
  const { adapter, events, server } = await start();
  await adapter.sendTurn({ sessionId: 's', turnId: 'one', text: 'room mention' });
  const prompt = await server.waitFor('session/prompt');
  expect(JSON.stringify(prompt.params)).toContain(input.systemContext);
  server.send({ id: 102, method: 'session/request_permission', params: permission() });
  await adapter.sendTurn({ sessionId: 's', turnId: 'two', text: 'next mention' });
  expect(server.received.filter((message) => message.method === 'session/prompt')).toHaveLength(1);
  await adapter.interruptTurn('s');
  await flush();
  expect(server.received.find((message) => message.id === 102)?.result).toEqual({
    outcome: { outcome: 'cancelled' },
  });
  expect(server.received.find((message) => message.method === 'session/cancel')?.params).toEqual({
    sessionId: 'native-id',
  });
  server.send({ id: prompt.id, result: { stopReason: 'cancelled' } });
  await flush();
  expect(events.find((event) => event.type === 'turn.completed')).toMatchObject({
    turnId: 'one',
    outcome: 'interrupted',
  });
  expect(server.received.filter((message) => message.method === 'session/prompt')).toHaveLength(2);
});

it.each(['approval-required', 'auto', 'auto-accept-edits'] as const)(
  'keeps untyped batched actions behind approvals in %s',
  async (runtimeMode) => {
    const { adapter, events, server } = await start({ runtimeMode });
    await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'read room context' });
    server.send({ id: 103, method: 'session/request_permission', params: permission() });
    await flush();
    expect(events.some((event) => event.type === 'request.opened')).toBe(true);
    expect(server.received.find((message) => message.id === 103)).toBeUndefined();
  }
);

it('routes streamed assistant replies and finished tools to the activity transcript', async () => {
  const { adapter, events, server } = await start();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: '@agent hello' });
  for (const update of [
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Room reply' } },
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'shell',
      kind: 'execute',
      title: 'Run pwd',
      status: 'in_progress',
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'shell',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: '/resolved/work' } }],
    },
  ])
    server.notify('session/update', { sessionId: 'native-id', update });
  expect(events.find((event) => event.type === 'content.delta')).toMatchObject({
    turnId: 't',
    delta: 'Room reply',
  });
  expect(
    events.find((event) => event.type === 'item.completed' && event.item.id === 'shell')
  ).toMatchObject({ item: { id: 'shell', type: 'command_execution', text: '/resolved/work' } });
});

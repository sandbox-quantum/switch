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
vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[]) => {
    spawned.push({ command, args });
    const server = new FakeAppServer();
    // What Auggie 0.37.0 answers: no `mcpCapabilities`, no auth methods.
    server.replyAlways('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true },
        sessionCapabilities: { list: {} },
      },
      authMethods: [],
    }));
    for (const method of ['session/new', 'session/load'])
      server.replyAlways(method, () => ({
        sessionId: 'native',
        modes: {
          currentModeId: 'default',
          availableModes: [
            { id: 'default', name: 'Default' },
            { id: 'ask', name: 'Ask' },
          ],
        },
        models: {
          currentModelId: 'sonnet4.5',
          availableModels: [
            { modelId: 'sonnet4.5', name: 'Sonnet 4.5' },
            { modelId: 'gpt5', name: 'GPT-5' },
          ],
        },
      }));
    server.replyAlways('session/set_model', () => ({}));
    servers.push(server);
    return server;
  },
}));
const { createAuggieAdapter, parseAuggieAccountStatus, AUGGIE_INDEXING_PERMISSION } =
  await import('./auggie-adapter');

beforeEach(() => {
  servers.length = 0;
  spawned.length = 0;
});

async function setup(runtimeMode: RuntimeMode = 'approval-required', model?: string) {
  const adapter = createAuggieAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  const session = await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode,
    env: {},
    ...(model ? { model: { id: model } } : {}),
    mcpServers: {
      switch: {
        transport: 'http',
        url: 'http://127.0.0.1:4000/mcp',
        headers: { Authorization: 'Bearer t' },
      },
    },
    connectorMcpServers: [],
  });
  return { adapter, events, session, server: servers.at(-1)! };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Auggie's indexing consent, as 0.37.0 sends it. */
const indexing = (id: number) => ({
  id,
  method: 'session/request_permission',
  params: {
    sessionId: 'native',
    toolCall: {
      toolCallId: AUGGIE_INDEXING_PERMISSION,
      title: 'Workspace Indexing Permission',
      kind: 'other',
      status: 'pending',
    },
    options: [
      { optionId: 'always-enable', name: 'Always index', kind: 'allow_always' },
      { optionId: 'always-disable', name: 'Never index', kind: 'reject_always' },
      { optionId: 'session-enable', name: 'Index for this session', kind: 'allow_once' },
      { optionId: 'session-disable', name: 'Skip for this session', kind: 'reject_once' },
    ],
  },
});

it('launches auggie --acp and gives it the Switch MCP server over HTTP', async () => {
  const { server, session } = await setup();
  expect(spawned).toEqual([{ command: 'auggie', args: ['--acp'] }]);
  expect(session.nativeSessionId).toBe('native');
  expect(server.received.map((m) => m.method)).toEqual(['initialize', 'session/new']);
  expect(server.received.find((m) => m.method === 'session/new')?.params?.mcpServers).toEqual([
    {
      type: 'http',
      name: 'switch',
      url: 'http://127.0.0.1:4000/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer t' }],
    },
  ]);
});

it('lists Auggie models and starts on the chosen one through session/set_model', async () => {
  const { adapter, server } = await setup('approval-required', 'gpt5');
  expect((await adapter.listModels('s')).map((m) => m.id)).toEqual(['sonnet4.5', 'gpt5']);
  expect(server.received.find((m) => m.method === 'session/set_model')?.params).toEqual({
    sessionId: 'native',
    modelId: 'gpt5',
  });
});

it('declines indexing asked before any turn, without telling Auggie to remember it', async () => {
  const { events, server } = await setup('full-access');
  server.send(indexing(70));
  await flush();
  expect(events.some((e) => e.type === 'request.opened')).toBe(false);
  expect(server.received.find((m) => m.id === 70)?.result).toEqual({
    outcome: { outcome: 'cancelled' },
  });
});

it('asks the owner about indexing even in full access, offering only this session', async () => {
  const { adapter, events, server } = await setup('full-access');
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'hello' });
  server.send(indexing(71));
  await flush();
  const request = events.find((e) => e.type === 'request.opened');
  if (!request || request.type !== 'request.opened') throw new Error('missing indexing request');
  expect(request.options.map((o) => o.label)).toEqual([
    'Index for this session',
    'Skip for this session',
    'Cancel',
  ]);
  await adapter.respondToRequest('s', request.requestId, 'accept');
  await flush();
  expect(server.received.find((m) => m.id === 71)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'session-enable' },
  });
});

it('approves tools without asking in full access, never for good', async () => {
  const { adapter, events, server } = await setup('full-access');
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'run' });
  server.send({
    id: 72,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: { toolCallId: 'call-1', title: 'launch-process', kind: 'execute' },
      options: [
        { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Deny', kind: 'reject_once' },
      ],
    },
  });
  await flush();
  expect(events.some((e) => e.type === 'request.opened')).toBe(false);
  expect(server.received.find((m) => m.id === 72)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'allow-once' },
  });
});

it('reads signed-in state from account status without trusting an exit code alone', () => {
  expect(
    parseAuggieAccountStatus({
      exitCode: 1,
      stdout: '',
      stderr: 'You are not currently logged in to Augment.\n',
    })
  ).toMatchObject({ status: 'unauthenticated', message: expect.stringContaining('auggie login') });
  expect(
    parseAuggieAccountStatus({ exitCode: 0, stdout: '{"credits":{}}', stderr: '' })
  ).toMatchObject({ status: 'authenticated' });
  expect(
    parseAuggieAccountStatus({
      exitCode: 1,
      stdout: '',
      stderr: 'Cannot retrieve account status: API server not available',
    })
  ).toMatchObject({ status: 'unknown' });
});

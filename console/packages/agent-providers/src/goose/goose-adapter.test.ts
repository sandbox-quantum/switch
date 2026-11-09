import type * as fs from 'node:fs/promises';
import { beforeEach, expect, it, vi } from 'vitest';
import { FakeAppServer, type FakeJsonRpcMessage } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));
const servers: FakeAppServer[] = [];
/** What the fake Goose answers `session/new` with. */
const goose = {
  configured: true,
  modes: ['auto', 'approve', 'smart_approve', 'chat'],
  newError: undefined as { message: string; data: string } | undefined,
};
vi.mock('node:child_process', () => ({
  spawn: () => {
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      agentInfo: { name: 'goose', version: '1.57.0' },
      authMethods: [{ id: 'goose-provider', name: 'Configure Provider' }],
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: true, sse: false },
      },
    }));
    server.on('message', (message: FakeJsonRpcMessage) => {
      if (message.method !== 'session/new' || message.id === undefined) return;
      if (!goose.configured || goose.newError) {
        server.send({
          id: message.id,
          error: {
            code: -32603,
            message: goose.newError?.message ?? 'Internal error',
            data: goose.newError?.data ?? 'Configuration value not found: GOOSE_PROVIDER',
          } as { code: number; message: string },
        });
        return;
      }
      server.send({
        id: message.id,
        result: {
          sessionId: 'native',
          modes: {
            currentModeId: 'auto',
            availableModes: goose.modes.map((id) => ({ id, name: id })),
          },
          configOptions: [
            {
              id: 'model',
              type: 'select',
              currentValue: 'model-a',
              options: [
                { value: 'model-a', name: 'Model A' },
                { value: 'model-b', name: 'Model B' },
              ],
            },
          ],
        },
      });
    });
    server.replyAlways('session/delete', () => ({}));
    server.replyAlways('session/set_mode', () => ({}));
    server.replyAlways('session/set_config_option', () => ({ configOptions: [] }));
    server.replyAlways('session/load', () => ({}));
    servers.push(server);
    return server;
  },
}));
const { checkAcpSignIn } = await import('../acp/acp-adapter');
const {
  GOOSE_LOGIN,
  createGooseAdapter,
  gooseAcp,
  gooseItemType,
  gooseMcpServer,
  gooseSessionMode,
} = await import('./goose-adapter');
const { providerRuntime } = await import('../providers/registry');

beforeEach(() => {
  servers.length = 0;
  goose.configured = true;
  goose.modes = ['auto', 'approve', 'smart_approve', 'chat'];
  goose.newError = undefined;
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function setup(
  runtimeMode: 'approval-required' | 'auto-accept-edits' | 'auto' | 'full-access'
) {
  const adapter = createGooseAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode,
    env: {},
    mcpServers: {
      switch: { transport: 'stdio', command: 'node', args: ['server.js'], env: {} },
    },
    connectorMcpServers: [],
  });
  const server = servers.at(-1)!;
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  return { adapter, events, server };
}

// The payloads below are what goose 1.57.0 sent over `goose acp`.
const options = [
  { optionId: 'allow_always', name: 'allow_always', kind: 'allow_always' },
  { optionId: 'allow_once', name: 'allow_once', kind: 'allow_once' },
  { optionId: 'reject_once', name: 'reject_once', kind: 'reject_once' },
  { optionId: 'reject_always', name: 'reject_always', kind: 'reject_always' },
];
const shellCall = {
  sessionUpdate: 'tool_call',
  toolCallId: 'call_1',
  title: 'shell · echo hi > hi.txt',
  rawInput: { command: 'echo hi > hi.txt' },
  _meta: { goose: { toolCall: { toolName: 'shell', extensionName: 'developer' } } },
};
const switchCall = {
  sessionUpdate: 'tool_call',
  toolCallId: 'call_2',
  title: 'switch: list rooms',
  rawInput: {},
  _meta: { goose: { toolCall: { toolName: 'switch__list_rooms', extensionName: 'switch' } } },
};

it('puts a session in the Goose mode that asks, since Goose starts in auto', () => {
  const modes = { availableModes: goose.modes.map((id) => ({ id })) };
  expect(gooseSessionMode('approval-required', modes)).toBe('approve');
  expect(gooseSessionMode('auto-accept-edits', modes)).toBe('approve');
  expect(gooseSessionMode('auto', modes)).toBe('approve');
  expect(gooseSessionMode('full-access', modes)).toBe('auto');
});

it('refuses a session that must ask when Goose does not offer the mode, rather than leave it approving everything', () => {
  const modes = { availableModes: [{ id: 'auto' }, { id: 'chat' }] };
  expect(() => gooseSessionMode('approval-required', modes)).toThrow(
    'does not offer its "approve" mode (it offers: auto, chat)'
  );
  expect(() => gooseSessionMode('auto', undefined)).toThrow('it offers: none');
  expect(gooseSessionMode('full-access', { availableModes: [{ id: 'chat' }] })).toBeUndefined();
});

it('sets the mode on the session when it starts', async () => {
  const { server } = await setup('approval-required');
  expect(server.received.find((m) => m.method === 'session/set_mode')?.params).toEqual({
    sessionId: 'native',
    modeId: 'approve',
  });
  const full = await setup('full-access');
  expect(full.server.received.find((m) => m.method === 'session/set_mode')?.params).toEqual({
    sessionId: 'native',
    modeId: 'auto',
  });
});

it('fails to start an asking session when Goose lacks the mode', async () => {
  goose.modes = ['auto', 'chat'];
  await expect(setup('approval-required')).rejects.toThrow('Could not start Goose');
});

it('reads a tool’s MCP server from the extension only when the tool is prefixed with it', () => {
  expect(gooseMcpServer(switchCall)).toBe('switch');
  expect(gooseMcpServer(shellCall)).toBeUndefined();
  expect(gooseMcpServer({ toolCallId: 'x' })).toBeUndefined();
  expect(
    gooseMcpServer({
      toolCallId: 'x',
      _meta: { goose: { toolCall: { toolName: 'switch__a', extensionName: 'other' } } },
    })
  ).toBeUndefined();
});

it('types Goose’s developer tools and subagents, which it sends without a kind', () => {
  const tool = (extensionName: string, toolName: string) => ({
    toolCallId: 'x',
    _meta: { goose: { toolCall: { toolName, extensionName } } },
  });
  expect(gooseItemType(tool('developer', 'shell'))).toBe('command_execution');
  expect(gooseItemType(tool('developer', 'write'))).toBe('file_change');
  expect(gooseItemType(tool('developer', 'edit'))).toBe('file_change');
  expect(gooseItemType(tool('summon', 'delegate'))).toBe('subagent');
  expect(gooseItemType(tool('developer', 'tree'))).toBeUndefined();
  expect(gooseItemType(tool('switch', 'shell'))).toBeUndefined();
  expect(gooseItemType({ toolCallId: 'x' })).toBeUndefined();
});

it('shows Goose’s shell calls as commands in the activity stream', async () => {
  const { events, server } = await setup('approval-required');
  server.notify('session/update', { sessionId: 'native', update: shellCall });
  expect(events.find((e) => e.type === 'item.started' && e.item.id === 'call_1')).toMatchObject({
    item: { type: 'command_execution', title: 'shell · echo hi > hi.txt' },
  });
});

it('runs the session’s own MCP server’s tools without asking, but asks for Goose’s shell', async () => {
  const { events, server } = await setup('approval-required');
  server.notify('session/update', { sessionId: 'native', update: switchCall });
  server.send({
    id: 90,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: { toolCallId: 'call_2', kind: 'other', title: 'switch: list rooms' },
      options,
    },
  });
  await flush();
  expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(0);
  expect(server.received.find((m) => m.id === 90)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'allow_once' },
  });

  server.notify('session/update', { sessionId: 'native', update: shellCall });
  server.send({
    id: 91,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: { toolCallId: 'call_1', kind: 'other', title: 'shell · echo hi > hi.txt' },
      options,
    },
  });
  await flush();
  expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(1);
});

async function ask(
  toolCall: Record<string, unknown>,
  runtimeMode: 'approval-required' | 'auto-accept-edits' = 'approval-required'
) {
  const { adapter, events, server } = await setup(runtimeMode);
  server.send({
    id: 70,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: { toolCallId: 'p', status: 'pending', ...toolCall },
      options,
    },
  });
  await flush();
  const request = events.find((e) => e.type === 'request.opened');
  return { adapter, request, server };
}

it('offers only allow once and reject, never a permanent rule, with readable names', async () => {
  const { request } = await ask({
    kind: 'other',
    title: 'shell · echo hi > hi.txt',
    rawInput: { command: 'echo hi > hi.txt' },
  });
  if (!request || request.type !== 'request.opened') throw new Error('missing approval');
  expect(request.requestType).toBe('command_execution_approval');
  expect(request.options).toEqual([
    { decision: 'accept', label: 'Allow once' },
    { decision: 'decline', label: 'Reject' },
    { decision: 'cancel', label: 'Cancel' },
  ]);
});

it('answers with Goose’s own option ids', async () => {
  const { adapter, request, server } = await ask({
    kind: 'other',
    title: 'shell · ls',
    rawInput: { command: 'ls' },
  });
  if (!request || request.type !== 'request.opened') throw new Error('missing approval');
  await adapter.respondToRequest('s', request.requestId, 'decline');
  await flush();
  expect(server.received.find((m) => m.id === 70)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'reject_once' },
  });
});

it('accepts edits without asking in auto-accept-edits, but still asks for commands', async () => {
  const edit = await ask(
    {
      kind: 'other',
      title: 'write · /work/notes.txt',
      rawInput: { path: '/work/notes.txt', content: 'x' },
    },
    'auto-accept-edits'
  );
  expect(edit.request).toBeUndefined();
  expect(edit.server.received.find((m) => m.id === 70)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'allow_once' },
  });
  const command = await ask(
    { kind: 'other', title: 'shell · rm x', rawInput: { command: 'rm x' } },
    'auto-accept-edits'
  );
  expect(command.request).toMatchObject({ requestType: 'command_execution_approval' });
});

it('does not take an MCP tool or an unknown tool for one of Goose’s own', async () => {
  for (const toolCall of [
    { kind: 'other', title: 'shell: run', rawInput: { command: 'ls' } },
    { kind: 'other', title: 'shell · ls', rawInput: { text: 'ls' } },
    { kind: 'other', title: 'tree · /work', rawInput: { path: '/work' } },
    { kind: 'other', title: 'delegate', rawInput: {} },
  ]) {
    const { request } = await ask(toolCall, 'auto-accept-edits');
    expect(request).toMatchObject({ requestType: 'tool_approval' });
  }
});

it('reports Goose as unconfigured when it has no provider and model, without prompting or authenticating', async () => {
  goose.configured = false;
  const result = await checkAcpSignIn(gooseAcp, { binaryPath: 'goose', cwd: '/work', env: {} });
  expect(result).toMatchObject({ status: 'unconfigured' });
  expect(result.message).toContain(GOOSE_LOGIN);
  const sent = servers.at(-1)!.received.map((m) => m.method);
  expect(sent).toEqual(['initialize', 'session/new']);
});

it('reports Goose as configured when it can create a session, again without prompting or authenticating', async () => {
  const result = await checkAcpSignIn(gooseAcp, { binaryPath: 'goose', cwd: '/work', env: {} });
  expect(result).toMatchObject({ status: 'authenticated' });
  expect(servers.at(-1)!.received.map((m) => m.method)).toEqual([
    'initialize',
    'session/new',
    'session/delete',
  ]);
  expect(servers.at(-1)!.received.find((m) => m.method === 'session/delete')?.params).toEqual({
    sessionId: 'native',
  });
});

it('does not take any other session failure for a missing configuration', async () => {
  goose.newError = { message: 'Internal error', data: 'database is locked' };
  await expect(
    checkAcpSignIn(gooseAcp, { binaryPath: 'goose', cwd: '/work', env: {} })
  ).rejects.toThrow('Internal error');
});

it('is registered with the launch, login command and environment the host needs', () => {
  const runtime = providerRuntime('goose');
  expect(runtime.loginCommand).toBe('goose configure');
  expect(runtime.inheritEnv).toEqual(['GOOSE_PROVIDER', 'GOOSE_MODEL', 'GOOSE_DISABLE_KEYRING']);
  expect(gooseAcp.launch({ binaryPath: '/bin/goose', cwd: '/work', env: { A: 'b' } })).toEqual({
    command: '/bin/goose',
    args: ['acp'],
    env: { A: 'b' },
  });
});

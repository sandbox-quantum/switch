import { beforeEach, expect, it, vi } from 'vitest';
import type { AcpToolCall } from '../acp/protocol';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';

const servers: FakeAppServer[] = [];
let defaults: { providerId: string | null; modelId: string | null };
let defaultsError = false;
vi.mock('../provider-process', () => ({
  spawnProvider: () => {
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } },
      authMethods: [{ id: 'goose-provider', name: 'Configure Provider' }],
    }));
    server.on('message', (message) => {
      if (message.method !== '_goose/unstable/defaults/read') return;
      server.send({
        id: message.id,
        ...(defaultsError
          ? { error: { code: -32601, message: 'Method not found' } }
          : { result: defaults }),
      });
    });
    server.replyAlways('session/new', () => ({
      sessionId: 'native',
      configOptions: [
        {
          id: 'model',
          type: 'select',
          currentValue: 'default',
          options: [{ value: 'qwen3:8b', name: 'Qwen' }],
        },
      ],
    }));
    server.replyAlways('session/load', () => ({}));
    server.replyAlways('session/set_mode', () => ({}));
    server.replyAlways('session/set_config_option', () => ({}));
    servers.push(server);
    return server;
  },
  stopProvider: (server: FakeAppServer) => server.kill(),
}));

const { createGooseAdapter, gooseAcp } = await import('./goose-acp');
beforeEach(() => {
  servers.length = 0;
  defaults = { providerId: null, modelId: null };
  defaultsError = false;
});

it('launches native stdio ACP with a safe initial mode and no interactive keyring', async () => {
  const env = { PATH: '/bin', GOOSE_MODE: 'auto', GOOSE_DISABLE_KEYRING: '0' };
  expect(await gooseAcp.launch({ binaryPath: '/bin/goose', cwd: process.cwd(), env })).toEqual({
    command: '/bin/goose',
    args: ['acp', '--with-builtin', 'developer'],
    env: { ...env, GOOSE_MODE: 'approve', GOOSE_DISABLE_KEYRING: '1' },
  });
  expect(env.GOOSE_MODE).toBe('auto');
  expect(gooseAcp.loginCommand).toBe('goose configure');
  expect(gooseAcp.inheritEnv).toEqual(
    expect.arrayContaining([
      'GOOSE_PROVIDER',
      'GOOSE_MODEL',
      'GOOSE_FAST_MODEL',
      'GOOSE_PATH_ROOT',
      'GOOSE_DISABLE_KEYRING',
      'GOOSE_ADDITIONAL_CONFIG_FILES',
      'OLLAMA_HOST',
    ])
  );
});

it.each([
  [null, null, 'unconfigured'],
  ['ollama', null, 'unconfigured'],
  [null, 'qwen3:8b', 'unconfigured'],
  [' ', 'qwen3:8b', 'unconfigured'],
  ['ollama', 'qwen3:8b', 'authenticated'],
] as const)(
  'checks defaults %s/%s without login, a session, or inference',
  async (providerId, modelId, status) => {
    defaults = { providerId, modelId };
    const handshake = vi.fn();
    const result = await gooseAcp.checkSignIn!({
      binaryPath: 'goose',
      cwd: process.cwd(),
      env: {},
      handshake,
    });
    expect(result.status).toBe(status);
    if (status === 'unconfigured') expect(result.message).toContain('goose configure');
    expect(servers[0]!.received.filter((m) => m.method).map((m) => m.method)).toEqual([
      'initialize',
      '_goose/unstable/defaults/read',
    ]);
    expect(handshake).not.toHaveBeenCalled();
    expect(servers[0]!.stdin.writableEnded).toBe(true);
  }
);

it('surfaces an unsupported readiness request and closes the process', async () => {
  defaultsError = true;
  await expect(
    gooseAcp.checkSignIn!({
      binaryPath: 'goose',
      cwd: process.cwd(),
      env: {},
      handshake: vi.fn(),
    })
  ).rejects.toThrow('Method not found');
  expect(servers[0]!.stdin.writableEnded).toBe(true);
});

it.each([
  ['approval-required', 'approve'],
  ['auto-accept-edits', 'smart_approve'],
  ['auto', 'smart_approve'],
  ['full-access', 'auto'],
] as const)(
  'sets %s through session/set_mode and applies the chosen model',
  async (runtimeMode, modeId) => {
    const adapter = createGooseAdapter();
    try {
      await adapter.startSession({
        sessionId: 's',
        cwd: process.cwd(),
        env: {},
        runtimeMode,
        mcpServers: {},
        connectorMcpServers: [],
        model: { id: 'qwen3:8b' },
      });
      expect(servers[0]!.received.find((m) => m.method === 'session/set_mode')?.params).toEqual({
        sessionId: 'native',
        modeId,
      });
      expect(
        servers[0]!.received.find((m) => m.method === 'session/set_config_option')?.params
      ).toMatchObject({
        sessionId: 'native',
        configId: 'model',
        value: 'qwen3:8b',
      });
    } finally {
      await adapter.stopAll();
    }
  }
);

it('identifies MCP servers and activity from Goose metadata rather than display titles', () => {
  const tool = (toolName: string, extensionName: unknown) => ({
    toolCallId: 'tool',
    _meta: { goose: { toolCall: { toolName, extensionName } } },
  });
  expect(gooseAcp.mcpServerOf?.(tool('echo__echo', 'echo'))).toBe('echo');
  expect(gooseAcp.mcpServerOf?.(tool('echo__echo', 42))).toBeUndefined();
  expect(gooseAcp.mcpServerOf?.({ toolCallId: 'tool', title: 'echo: echo' })).toBeUndefined();
  expect(
    gooseAcp.itemType?.({
      toolCallId: 'shell',
      title: 'shell · echo SWITCH_CONFORMANCE_OK > approved.txt',
      _meta: { goose: { toolCall: { toolName: 'shell' } } },
    })
  ).toBe('command_execution');
  expect(gooseAcp.itemType?.(tool('developer__shell', 'developer'))).toBe('command_execution');
  expect(gooseAcp.itemType?.(tool('developer__write', 'developer'))).toBe('file_change');
  expect(gooseAcp.itemType?.(tool('developer__edit', 'developer'))).toBe('file_change');
  expect(gooseAcp.itemType?.(tool('summon__delegate', 'summon'))).toBe('subagent');
  expect(gooseAcp.itemType?.(tool('echo__echo', 'echo'))).toBeUndefined();
});

it.each([
  ['todo__todo_write', 'todo: todo write', true, true],
  ['todo__todo_write', undefined, true, true],
  [undefined, 'todo: todo write', true, true],
  ['shell', 'shell', true, false],
  ['write', 'write', true, false],
  ['edit', 'edit', true, false],
  ['delegate', 'delegate', true, false],
  ['unknown', 'unknown', true, false],
  ['shell', 'todo: todo write', true, false],
  ['todo__todo_write_extra', 'todo: todo write', true, false],
  [undefined, 'todo: todo write extra', true, false],
  ['todo__todo_write', 'todo: todo write', false, false],
] as const)(
  'handles permission %s / %s (allow_once=%s, auto-allow=%s)',
  async (toolName, title, hasOnce, autoAllow) => {
    const adapter = createGooseAdapter();
    const events: ProviderRuntimeEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    try {
      await adapter.startSession({
        sessionId: 's',
        cwd: process.cwd(),
        env: {},
        runtimeMode: 'approval-required',
        mcpServers: {},
        connectorMcpServers: [],
      });
      await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'Run the requested tool.' });
      const server = servers[0]!;
      const toolCall: AcpToolCall = {
        toolCallId: 'tool',
        ...(title === undefined ? {} : { title }),
        ...(toolName === undefined ? {} : { _meta: { goose: { toolCall: { toolName } } } }),
      };
      server.send({
        id: 99,
        method: 'session/request_permission',
        params: {
          sessionId: 'native',
          toolCall,
          options: [
            { optionId: 'persistent', kind: 'allow_always', name: 'Always allow' },
            ...(hasOnce ? [{ optionId: 'single', kind: 'allow_once', name: 'Allow once' }] : []),
            { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
          ],
        },
      });
      await new Promise((resolve) => setImmediate(resolve));
      const requests = events.filter((event) => event.type === 'request.opened');
      const response = server.received.find((message) => message.id === 99);
      if (autoAllow) {
        expect(requests).toEqual([]);
        expect(response?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'single' } });
      } else {
        expect(requests).toHaveLength(1);
        expect(response).toBeUndefined();
        await adapter.respondToRequest('s', requests[0]!.requestId, 'decline');
        await new Promise((resolve) => setImmediate(resolve));
        expect(server.received.find((message) => message.id === 99)?.result).toEqual({
          outcome: { outcome: 'selected', optionId: 'reject' },
        });
      }
    } finally {
      await adapter.stopAll();
    }
  }
);

it.each(['accept', 'decline'] as const)(
  'answers Goose permissions with %s and the native option ID',
  async (decision) => {
    const adapter = createGooseAdapter();
    const events: ProviderRuntimeEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    try {
      await adapter.startSession({
        sessionId: 's',
        cwd: process.cwd(),
        env: {},
        runtimeMode: 'approval-required',
        mcpServers: {},
        connectorMcpServers: [],
      });
      await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'write a marker' });
      const server = servers[0]!;
      server.send({
        id: 99,
        method: 'session/request_permission',
        params: {
          sessionId: 'native',
          toolCall: { toolCallId: 'shell', title: 'developer: shell' },
          options: [
            { optionId: 'allow_once', kind: 'allow_once', name: 'allow_once' },
            { optionId: 'reject_once', kind: 'reject_once', name: 'reject_once' },
          ],
        },
      });
      const request = events.find((e) => e.type === 'request.opened');
      if (!request || request.type !== 'request.opened') throw new Error('Missing approval');
      await adapter.respondToRequest('s', request.requestId, decision);
      await new Promise((resolve) => setImmediate(resolve));
      expect(server.received.find((m) => m.id === 99)?.result).toEqual({
        outcome: {
          outcome: 'selected',
          optionId: decision === 'accept' ? 'allow_once' : 'reject_once',
        },
      });
    } finally {
      await adapter.stopAll();
    }
  }
);

it.each([
  {
    toolName: 'write',
    title: 'write · marker.txt',
    args: { path: 'marker.txt', content: 'SWITCH_CONFORMANCE_OK' },
    type: 'file_change',
    result: 'Created marker.txt (1 lines)',
  },
  {
    toolName: 'delegate',
    title: 'delegate',
    args: { instructions: 'Read README.md in the current directory and report its first line.' },
    type: 'subagent',
    result: 'The first line of `README.md` is:\n\n`# conformance scratch`',
  },
] as const)(
  'classifies the observed $toolName payload from its first event through completion',
  async ({ toolName, title, args, type, result }) => {
    const adapter = createGooseAdapter();
    const events: ProviderRuntimeEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    try {
      await adapter.startSession({
        sessionId: 's',
        cwd: process.cwd(),
        env: {},
        runtimeMode: 'full-access',
        mcpServers: {},
        connectorMcpServers: [],
      });
      await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'Run the requested tool.' });
      const server = servers[0]!;
      const update = (payload: Record<string, unknown>) =>
        server.notify('session/update', {
          sessionId: 'native',
          update: { toolCallId: 'observed-tool', ...payload },
        });
      update({
        sessionUpdate: 'tool_call',
        title,
        rawInput: args,
        _meta: { goose: { toolCall: { toolName } } },
      });
      // Later Goose updates omit kind and tool metadata; retain the initial classification.
      if (toolName === 'delegate')
        update({ sessionUpdate: 'tool_call_update', status: 'in_progress' });
      update({
        sessionUpdate: 'tool_call_update',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: result } }],
      });
      expect(events.find((event) => event.type === 'item.started')).toMatchObject({
        turnId: 't',
        item: { id: 'observed-tool', type, title, status: 'in_progress' },
      });
      expect(events.find((event) => event.type === 'item.completed')).toMatchObject({
        turnId: 't',
        item: { id: 'observed-tool', type, title, status: 'completed', text: result },
      });
    } finally {
      await adapter.stopAll();
    }
  }
);

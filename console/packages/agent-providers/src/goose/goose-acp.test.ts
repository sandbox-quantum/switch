import { beforeEach, expect, it, vi } from 'vitest';
import type { AcpToolCall } from '../acp/protocol';
import type { RuntimeMode } from '../adapter';
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
  expect(gooseAcp.inheritEnv).not.toContain('GOOSE_DISABLE_KEYRING');
  expect(gooseAcp.loginCommand).toBe('goose configure');
  expect(gooseAcp.inheritEnv).toEqual(
    expect.arrayContaining([
      'GOOSE_PROVIDER',
      'GOOSE_MODEL',
      'GOOSE_FAST_MODEL',
      'GOOSE_PATH_ROOT',
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
      request: vi.fn(),
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
      request: vi.fn(),
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
  [undefined, 'todo: todo write', true, false],
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
        ...(toolName === undefined
          ? {}
          : {
              _meta: {
                goose: {
                  toolCall: {
                    toolName,
                    extensionName: toolName === 'todo__todo_write' ? 'todo' : 'developer',
                  },
                },
              },
            }),
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
        expect(requests[0]).toMatchObject({
          options: [
            ...(hasOnce ? [{ decision: 'accept', label: 'Allow once' }] : []),
            { decision: 'decline', label: 'Reject' },
            { decision: 'cancel', label: 'Cancel' },
          ],
        });
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

// Goose 1.43.0 permission requests as observed on 2026-11-07: a bare title, kind
// `other` and no `_meta`; the preceding tool_call carries `shell · ls` and the metadata.
const observedShellPermission: AcpToolCall = {
  toolCallId: '18c12b3d-a84d-4ec0-abea-2a825443808d',
  kind: 'other',
  status: 'pending',
  title: 'shell',
  rawInput: { command: 'ls' },
};
const observedWritePermission: AcpToolCall = {
  toolCallId: '8abce35d-21e2-45fc-81ee-e7553946ac3f',
  kind: 'other',
  status: 'pending',
  title: 'write',
  rawInput: { content: 'hi', path: 'created.txt' },
};

async function openGoosePermission(
  runtimeMode: RuntimeMode,
  toolCall: Record<string, unknown>,
  preceding?: Record<string, unknown>
) {
  const adapter = createGooseAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  await adapter.startSession({
    sessionId: 's',
    cwd: process.cwd(),
    env: {},
    runtimeMode,
    mcpServers: {},
    connectorMcpServers: [],
  });
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'Run the requested tool.' });
  const server = servers.at(-1)!;
  if (preceding)
    server.notify('session/update', {
      sessionId: 'native',
      update: { sessionUpdate: 'tool_call', ...preceding },
    });
  server.send({
    id: 99,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall,
      options: [
        { optionId: 'allow_always', kind: 'allow_always', name: 'allow_always' },
        { optionId: 'allow_once', kind: 'allow_once', name: 'allow_once' },
        { optionId: 'reject_once', kind: 'reject_once', name: 'reject_once' },
        { optionId: 'reject_always', kind: 'reject_always', name: 'reject_always' },
      ],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  return { adapter, events, server };
}

// Only shell/write/todo identities and shapes are captured; edit and external
// extension payloads below are synthetic adversarial cases with the same shape.
it.each(['approval-required', 'auto-accept-edits'] as const)(
  'keeps metadata-less requests manual in %s despite earlier tool metadata',
  async (runtimeMode) => {
    for (const [title, toolName, extensionName] of [
      ['shell', 'shell', 'developer'],
      ['write', 'write', 'developer'],
      ['edit', 'edit', 'developer'],
      ['todo: todo write', 'todo__todo_write', 'todo'],
      ['write', 'write', 'external'],
      ['edit', 'edit', 'external'],
      ['todo: todo write', 'todo__todo_write', 'external'],
    ]) {
      const permission = {
        ...(toolName === 'shell' ? observedShellPermission : observedWritePermission),
        title,
        _meta: null,
      };
      const { adapter, events, server } = await openGoosePermission(runtimeMode, permission, {
        toolCallId: permission.toolCallId,
        title,
        _meta: { goose: { toolCall: { toolName, extensionName } } },
      });
      try {
        expect(events.find((event) => event.type === 'request.opened')).toMatchObject({
          requestType: 'tool_approval',
          title,
        });
        expect(server.received.find((message) => message.id === 99)).toBeUndefined();
      } finally {
        await adapter.stopAll();
      }
    }
  }
);

it.each(['approval-required', 'auto-accept-edits'] as const)(
  'checks extension and tool identity on the request in %s',
  async (runtimeMode) => {
    for (const [toolName, extensionName, requestType] of [
      ['shell', 'developer', 'command_execution_approval'],
      ['write', 'developer', 'file_change_approval'],
      ['edit', 'developer', 'file_change_approval'],
      ['todo__todo_write', 'todo', undefined],
      ['write', 'external', 'tool_approval'],
      ['edit', 'external', 'tool_approval'],
      ['todo__todo_write', 'external', 'tool_approval'],
    ] as const) {
      const title = toolName === 'todo__todo_write' ? 'todo: todo write' : toolName;
      const { adapter, events, server } = await openGoosePermission(runtimeMode, {
        ...observedWritePermission,
        title,
        _meta: { goose: { toolCall: { toolName, extensionName } } },
      });
      try {
        const autoAllow =
          requestType === undefined ||
          (runtimeMode === 'auto-accept-edits' && requestType === 'file_change_approval');
        if (autoAllow) {
          expect(events.filter((event) => event.type === 'request.opened')).toEqual([]);
          expect(server.received.find((message) => message.id === 99)?.result).toEqual({
            outcome: { outcome: 'selected', optionId: 'allow_once' },
          });
        } else {
          expect(events.find((event) => event.type === 'request.opened')).toMatchObject({
            requestType,
            title,
          });
          expect(server.received.find((message) => message.id === 99)).toBeUndefined();
        }
      } finally {
        await adapter.stopAll();
      }
    }
  }
);

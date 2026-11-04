import type * as fs from 'node:fs/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { checkAcpSignIn } from '../acp/acp-adapter';
import type { AcpPermissionRequest } from '../acp/protocol';
import { ProviderConversationUnavailableError, type RuntimeMode } from '../adapter';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';
import { EXECUTION_INHERIT_ENV } from '../host/agent-env';
import { providerRuntime } from '../providers/registry';
import { JsonRpcError } from '../transport/stdio-json-rpc';
import { createMistralVibeAdapter, mistralVibeAcp } from './mistral-vibe-acp';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));

const servers: FakeAppServer[] = [];
const wire = { auth: true as unknown, http: undefined as boolean | undefined, missing: false };
const configOptions = [
  {
    id: 'model',
    category: 'model',
    name: 'Model',
    type: 'select',
    currentValue: 'configured-model',
    options: [{ value: 'configured-model', name: 'Configured model' }],
  },
];
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      agentCapabilities: {
        loadSession: true,
        ...(wire.http === undefined ? {} : { mcpCapabilities: { http: wire.http } }),
      },
      authMethods: [{ id: 'browser-auth', name: 'Sign in' }],
    }));
    server.replyAlways('_auth/status', () => ({ authenticated: wire.auth }));
    server.replyAlways('session/new', () => ({ sessionId: 'native', configOptions }));
    server.on('message', (message) => {
      if (message.method !== 'session/load') return;
      if (wire.missing)
        server.sendRaw(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: -32602,
              message: 'Session not found: native',
              data: { session_id: 'native' },
            },
          })
        );
      else server.send({ id: message.id, result: { configOptions } });
    });
    server.replyAlways('session/set_mode', () => ({}));
    server.replyAlways('session/set_config_option', () => ({ configOptions }));
    servers.push(server);
    return server;
  }),
}));

const adapters: ReturnType<typeof createMistralVibeAdapter>[] = [];
beforeEach(() => {
  servers.length = 0;
  wire.auth = true;
  wire.http = undefined;
  wire.missing = false;
});
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.stopAll()));
});
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function setup(mode: RuntimeMode = 'approval-required', resume = false) {
  const adapter = createMistralVibeAdapter();
  adapters.push(adapter);
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    env: {},
    runtimeMode: mode,
    mcpServers: {
      switch: {
        transport: 'http',
        url: 'http://localhost:1234/mcp',
        headers: { 'X-Test': 'example' },
      },
    },
    connectorMcpServers: [],
    systemContext: 'Read the room context before replying.',
    model: { id: 'configured-model' },
    ...(resume ? { resume: { nativeSessionId: 'native' } } : {}),
  });
  return { adapter, events, server: servers.at(-1)! };
}

it('launches the ACP binary without CLI flags and preserves the supplied environment', () => {
  const env = { VIBE_HOME: '/profile' };
  expect(mistralVibeAcp.launch({ binaryPath: '/bin/vibe-acp', cwd: '/work', env })).toEqual({
    command: '/bin/vibe-acp',
    args: [],
    env,
  });
});

it.each([true, false, 'true', null])(
  'reports auth status %s without starting login',
  async (authenticated) => {
    wire.auth = authenticated;
    const result = await checkAcpSignIn(mistralVibeAcp, {
      binaryPath: 'vibe-acp',
      cwd: '/work',
      env: {},
    });
    expect(result.status).toBe(
      authenticated === true
        ? 'authenticated'
        : authenticated === false
          ? 'unauthenticated'
          : 'unknown'
    );
    if (authenticated === false) expect(result.message).toContain('vibe-acp --setup');
    expect(servers[0]!.received.map((message) => message.method)).toEqual([
      'initialize',
      '_auth/status',
    ]);
  }
);

it('registers a headless runtime and explicitly inherits the Vibe profile', () => {
  const runtime = providerRuntime('mistral-vibe');
  expect(runtime.loginCommand).toBe('vibe-acp --setup');
  expect(
    runtime.createAdapter({
      binaryPath: undefined,
      logger: undefined,
      skill: '',
      serviceSkills: [],
    }).provider
  ).toBe('mistral-vibe');
  expect(EXECUTION_INHERIT_ENV).toEqual(
    expect.arrayContaining(['VIBE_HOME', 'MISTRAL_API_KEY', 'DBUS_SESSION_BUS_ADDRESS'])
  );
  expect(EXECUTION_INHERIT_ENV).not.toContain('UNRELATED');
});

it.each([
  ['approval-required', 'ask'],
  ['auto-accept-edits', 'accept-edits'],
  ['auto', 'ask'],
  ['full-access', 'auto-approve'],
] as const)('sets %s using Vibe mode %s', async (mode, modeId) => {
  const { server } = await setup(mode);
  expect(server.received.find((message) => message.method === 'session/set_mode')?.params).toEqual({
    sessionId: 'native',
    modeId,
  });
});

it('uses advertised model choices and passes the selected model through ACP configuration', async () => {
  const { adapter, server } = await setup();
  expect(await adapter.listModels('s')).toMatchObject([
    { id: 'configured-model', label: 'Configured model' },
  ]);
  expect(
    server.received.find((message) => message.method === 'session/set_config_option')?.params
  ).toEqual({ sessionId: 'native', configId: 'model', value: 'configured-model' });
  expect(server.received.find((message) => message.method === 'session/new')?.params).toMatchObject(
    {
      mcpServers: [
        { type: 'http', name: 'switch', headers: [{ name: 'X-Test', value: 'example' }] },
      ],
    }
  );
  expect(server.received.some((message) => message.method === 'authenticate')).toBe(false);
});

it('honours an explicit refusal of HTTP MCP despite the compatibility fallback', async () => {
  wire.http = false;
  await expect(setup()).rejects.toThrow('does not declare MCP over HTTP');
  expect(servers[0]!.received.some((message) => message.method === 'session/new')).toBe(false);
});

it('loads the saved native session after a process restart', async () => {
  const { adapter } = await setup();
  await adapter.stopAll();
  const resumed = await setup('approval-required', true);
  expect(
    resumed.server.received.find((message) => message.method === 'session/load')?.params
  ).toMatchObject({ sessionId: 'native', cwd: '/work' });
  expect(resumed.server.received.some((message) => message.method === 'session/new')).toBe(false);
});

it('only recognizes Vibe session-not-found errors as a lost conversation', () => {
  const missing = new JsonRpcError(-32602, 'Session not found: native', { session_id: 'native' });
  expect(mistralVibeAcp.conversationUnavailable?.(missing)).toBe(true);
  expect(
    mistralVibeAcp.conversationUnavailable?.(new JsonRpcError(-32602, 'Invalid model', {}))
  ).toBe(false);
  expect(mistralVibeAcp.conversationUnavailable?.(new Error('Session not found: native'))).toBe(
    false
  );
});

it('reports a missing saved session through the host recovery error', async () => {
  wire.missing = true;
  await expect(setup('approval-required', true)).rejects.toBeInstanceOf(
    ProviderConversationUnavailableError
  );
  expect(servers[0]!.received.some((message) => message.method === 'session/new')).toBe(false);
});

const options: AcpPermissionRequest['options'] = [
  { optionId: 'allow_always_permanent', kind: 'allow_always', name: 'Always allow' },
  { optionId: 'allow_permanent_exact', kind: 'allow_always', name: 'Always allow path' },
  { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
  { optionId: 'allow_always', kind: 'allow_always', name: 'Allow for remainder of session' },
  { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' },
];
it.each([
  ['accept', 'allow_once'],
  ['acceptForSession', 'allow_always'],
  ['decline', 'reject_once'],
] as const)(
  'returns %s as the offered Vibe option and never persists a grant',
  async (decision, optionId) => {
    const { adapter, server, events } = await setup();
    await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'run a command' });
    server.send({
      id: 90,
      method: 'session/request_permission',
      params: {
        sessionId: 'native',
        toolCall: { toolCallId: 'call', kind: 'execute', title: 'Run command' },
        options,
      },
    });
    const event = events.find((event) => event.type === 'request.opened');
    if (!event || event.type !== 'request.opened') throw new Error('Missing approval');
    expect(event.requestType).toBe('command_execution_approval');
    expect(event.options.map((option) => option.label)).not.toContain('Always allow');
    await adapter.respondToRequest('s', event.requestId, decision);
    await flush();
    expect(server.received.find((message) => message.id === 90)?.result).toEqual({
      outcome: { outcome: 'selected', optionId },
    });
  }
);

it.each(['full-access', 'auto-accept-edits'] as const)(
  'auto-approves only once in %s',
  async (mode) => {
    const { adapter, server, events } = await setup(mode);
    await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'write a file' });
    server.send({
      id: 91,
      method: 'session/request_permission',
      params: {
        sessionId: 'native',
        toolCall: { toolCallId: 'edit', kind: 'edit' },
        options,
      },
    });
    await flush();
    expect(server.received.find((message) => message.id === 91)?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    });
    expect(events.some((event) => event.type === 'request.opened')).toBe(false);
  }
);

it('identifies only unambiguous registered MCP aliases from metadata', () => {
  const call = { toolCallId: 'call', _meta: { tool_name: 'mcp_google_workspace.search' } };
  expect(mistralVibeAcp.mcpServerOf?.(call, new Set(['google-workspace']))).toBe(
    'google-workspace'
  );
  expect(
    mistralVibeAcp.mcpServerOf?.(call, new Set(['google-workspace', 'google_workspace']))
  ).toBeUndefined();
  expect(
    mistralVibeAcp.mcpServerOf?.(
      { toolCallId: 'call', _meta: { tool_name: 'mcp_google_workspace_abcd.search' } },
      new Set(['google-workspace', 'google_workspace', 'google_workspace_abcd'])
    )
  ).toBeUndefined();
  expect(mistralVibeAcp.mcpServerOf?.(call, new Set())).toBeUndefined();
  expect(
    mistralVibeAcp.mcpServerOf?.(
      { toolCallId: 'call', title: 'mcp_switch.run' },
      new Set(['switch'])
    )
  ).toBeUndefined();
  expect(
    mistralVibeAcp.mcpServerOf?.(
      { toolCallId: 'call', _meta: { tool_name: 'mcp_$server.run' } },
      new Set(['$server'])
    )
  ).toBe('$server');
  expect(
    mistralVibeAcp.mcpServerOf?.(
      { toolCallId: 'call', _meta: { tool_name: 'mcp__server.run' } },
      new Set(['🔧server'])
    )
  ).toBe('🔧server');
  expect(
    mistralVibeAcp.mcpServerOf?.(
      { toolCallId: 'call', _meta: { tool_name: 42 } },
      new Set(['switch'])
    )
  ).toBeUndefined();
});

it('types Vibe subagent effects without mistaking ordinary tools for subagents', () => {
  expect(
    mistralVibeAcp.itemType?.({ toolCallId: 'child', _meta: { effect_kind: 'subagent' } })
  ).toBe('subagent');
  expect(
    mistralVibeAcp.itemType?.({ toolCallId: 'shell', _meta: { effect_kind: 'shell' } })
  ).toBeUndefined();
});

it.each([
  ['switch', false],
  ['connector', true],
] as const)('handles MCP permission metadata for %s', async (name, asks) => {
  const { adapter, server, events } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'read the room' });
  server.send({
    id: 93,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: { toolCallId: 'mcp', _meta: { tool_name: `mcp_${name}.read` } },
      options,
    },
  });
  await flush();
  expect(events.some((event) => event.type === 'request.opened')).toBe(asks);
  if (!asks)
    expect(server.received.find((message) => message.id === 93)?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    });
});

it('queues mid-turn messages, reports tool activity, and sends room context', async () => {
  const { adapter, server, events } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 'one', text: 'first room mention' });
  await adapter.sendTurn({ sessionId: 's', turnId: 'two', text: 'second room mention' });
  const prompts = () => server.received.filter((message) => message.method === 'session/prompt');
  expect(prompts()).toHaveLength(1);
  expect(JSON.stringify(prompts()[0]!.params)).toContain('Read the room context');
  server.send({
    method: 'session/update',
    params: {
      sessionId: 'native',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'shell',
        kind: 'execute',
        title: 'Shell',
        status: 'completed',
      },
    },
  });
  server.send({ id: prompts()[0]!.id, result: { stopReason: 'end_turn' } });
  await flush();
  expect(prompts()).toHaveLength(2);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'item.completed',
      item: expect.objectContaining({ type: 'command_execution', status: 'completed' }),
    })
  );
});

it('cancels pending approval when interrupted and accepts the following turn', async () => {
  const { adapter, server, events } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 'one', text: 'work' });
  server.send({
    id: 92,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: { toolCallId: 'shell', kind: 'execute' },
      options,
    },
  });
  await adapter.interruptTurn('s');
  await flush();
  expect(server.received.find((message) => message.id === 92)?.result).toEqual({
    outcome: { outcome: 'cancelled' },
  });
  expect(server.received.some((message) => message.method === 'session/cancel')).toBe(true);
  const prompt = server.received.find((message) => message.method === 'session/prompt')!;
  server.send({ id: prompt.id, result: { stopReason: 'cancelled' } });
  await flush();
  expect(events).toContainEqual(
    expect.objectContaining({ type: 'turn.completed', outcome: 'interrupted' })
  );
  await adapter.sendTurn({ sessionId: 's', turnId: 'two', text: 'continue' });
  expect(server.received.filter((message) => message.method === 'session/prompt')).toHaveLength(2);
});

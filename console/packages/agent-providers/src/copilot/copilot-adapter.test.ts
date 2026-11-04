import type * as fs from 'node:fs/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProviderSessionStartInput, RuntimeMode } from '../adapter';
import { FakeAppServer } from '../codex/fake-app-server';
import { checkProviderReadiness } from '../host/provider-readiness';
import { EventRecorder } from '../testing/event-recorder';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));

const servers: FakeAppServer[] = [];
const launches: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
const response = {
  error: null as { code: number; message: string } | null,
  config: false,
};
vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[], options: { env: Record<string, string> }) => {
    launches.push({ command, args, env: options.env });
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      // Copilot advertises this method even when already signed in.
      authMethods: [{ id: 'copilot-login' }],
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: true },
        promptCapabilities: { image: true, embeddedContext: true },
      },
    }));
    server.on('message', (message) => {
      if (!['session/new', 'session/load'].includes(message.method ?? '')) return;
      if (response.error) server.send({ id: message.id, error: response.error });
      else
        server.send({
          id: message.id,
          result: {
            sessionId: 'native',
            models: { availableModels: [{ modelId: 'fast', name: 'Fast' }] },
            ...(response.config
              ? {
                  configOptions: [
                    { id: 'model', type: 'select', options: [{ value: 'fast', name: 'Fast' }] },
                  ],
                }
              : {}),
          },
        });
    });
    server.replyAlways('session/set_model', () => ({}));
    server.replyAlways('session/set_config_option', () => ({}));
    servers.push(server);
    return server;
  },
}));

const { checkCopilotSignIn, copilotAcp, createCopilotAdapter } = await import('./copilot-adapter');
const adapters: ReturnType<typeof createCopilotAdapter>[] = [];
const flush = () => new Promise((resolve) => setImmediate(resolve));
const input = {
  sessionId: 's',
  cwd: '/work',
  runtimeMode: 'approval-required',
  env: { HOME: '/profile' },
  mcpServers: {},
  connectorMcpServers: [],
} satisfies ProviderSessionStartInput;

beforeEach(() => {
  servers.length = 0;
  launches.length = 0;
  response.error = null;
  response.config = false;
});
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.stopAll()));
});

async function start(overrides: Partial<ProviderSessionStartInput> = {}) {
  const adapter = createCopilotAdapter({ binaryPath: '/bin/copilot' });
  adapters.push(adapter);
  const recorder = new EventRecorder(adapter);
  const session = await adapter.startSession({ ...input, ...overrides });
  return { adapter, recorder, session, server: servers.at(-1)! };
}

it('launches ACP with exactly the supplied environment and never starts a login or bypass', async () => {
  await start();
  expect(launches).toEqual([
    { command: '/bin/copilot', args: ['--acp', '--stdio'], env: input.env },
  ]);
  expect(servers[0]!.received.map((message) => message.method)).toEqual([
    'initialize',
    'session/new',
  ]);
  expect(copilotAcp.authMethodId).toBeUndefined();
  expect(copilotAcp.sessionMode).toBeUndefined();
});

it('checks session access without prompting, authenticating, or trusting account metadata', async () => {
  const result = await checkCopilotSignIn({ binaryPath: 'copilot', cwd: '/work', env: {} });
  expect(result).toMatchObject({
    status: 'authenticated',
    models: [{ id: 'fast', name: 'Fast' }],
  });
  expect(servers[0]!.received.map((message) => message.method)).toEqual([
    'initialize',
    'session/new',
  ]);
  expect(servers[0]!.stdin.writableEnded).toBe(true);
});

it.each<Record<string, string>>([
  {},
  { COPILOT_GITHUB_TOKEN: 'invalid-example' },
  { COPILOT_PROVIDER_TYPE: 'openai' },
  { COPILOT_HOME: '/profile/custom-copilot' },
])('does not claim signed in from environment presence: %j', async (env) => {
  response.error = { code: -32000, message: 'Authentication required' };
  const result = await checkCopilotSignIn({ binaryPath: 'copilot', cwd: '/work', env });
  expect(result).toMatchObject({
    status: 'unauthenticated',
    message: expect.stringContaining('copilot login'),
  });
  expect(servers[0]!.stdin.writableEnded).toBe(true);
});

it('keeps configuration/transport failures unknown and does not disclose raw CLI output', async () => {
  response.error = { code: -32603, message: 'upstream diagnostic' };
  const result = await checkProviderReadiness({
    provider: 'copilot',
    binaryPath: 'copilot',
    cwd: '/work',
    env: {},
  });
  expect(result.status).toBe('unknown');
  expect(result.message).not.toContain('upstream diagnostic');
});

it('does not offer login as a fix for subscription or policy restrictions', async () => {
  response.error = { code: -32000, message: 'Access denied by policy settings' };
  expect(await checkCopilotSignIn({ binaryPath: 'copilot', cwd: '/work', env: {} })).toMatchObject({
    status: 'unconfigured',
    loginHelps: false,
  });
});

it('passes Copilot profile, token and BYOK configuration through the host allowlist', async () => {
  const { EXECUTION_INHERIT_ENV } = await import('../host/agent-env');
  for (const name of [
    'COPILOT_HOME',
    'COPILOT_GITHUB_TOKEN',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GH_HOST',
    'COPILOT_GH_HOST',
    'COPILOT_PROVIDER_BASE_URL',
    'COPILOT_PROVIDER_API_KEY',
    'COPILOT_PROVIDER_MODEL_ID',
    'COPILOT_PROVIDERS_CONFIG',
    'DBUS_SESSION_BUS_ADDRESS',
  ])
    expect(EXECUTION_INHERIT_ENV).toContain(name);
});

it.each([false, true])(
  'applies the selected model through ACP (config option: %s)',
  async (config) => {
    response.config = config;
    const { adapter, server } = await start({ model: { id: 'fast' } });
    expect(await adapter.listModels('s')).toMatchObject([{ id: 'fast' }]);
    const method = config ? 'session/set_config_option' : 'session/set_model';
    expect(server.received.find((message) => message.method === method)?.params).toMatchObject(
      config ? { configId: 'model', value: 'fast' } : { modelId: 'fast' }
    );
  }
);

it('resumes the exact conversation after replacing the adapter process', async () => {
  const first = await start();
  await first.adapter.stopAll();
  const second = await start({ resume: { nativeSessionId: first.session.nativeSessionId } });
  expect(
    second.server.received.find((message) => message.method === 'session/load')?.params
  ).toMatchObject({ sessionId: 'native' });
  expect(second.server.received.some((message) => message.method === 'session/new')).toBe(false);
});

const permissionOptions = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Always allow for this session', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
  { optionId: 'reject_always', name: 'Reject permanently', kind: 'reject_always' },
];

it.each([
  ['echo-switch_echo', ['echo'], 'other', 'echo'],
  ['service-echo-switch_echo', ['echo', 'service-echo'], 'other', 'service-echo'],
  ['echo-other-tool', ['echo', 'echo-other'], 'other', undefined],
  ['unregistered-tool', ['echo'], 'other', undefined],
  ['echo-shell', ['echo'], 'execute', undefined],
] as const)('identifies the MCP server conservatively for %s', (title, names, kind, expected) => {
  const update = { toolCallId: 'tool', title, kind, sessionUpdate: 'tool_call' };
  expect(copilotAcp.mcpServerOf?.(update, new Set(names))).toBe(expected);
  expect(
    copilotAcp.mcpServerOf?.({ toolCallId: 'permission', title, kind }, new Set(names))
  ).toBeUndefined();
});

it.each([false, true])('uses the earlier MCP tool identity (connector: %s)', async (connector) => {
  const { adapter, recorder, server } = await start({
    mcpServers: { echo: { transport: 'http', url: 'http://127.0.0.1:1234/mcp' } },
    connectorMcpServers: connector ? ['echo'] : [],
  });
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'echo' });
  server.notify('session/update', {
    sessionId: 'native',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-100',
      title: 'echo-switch_echo',
      kind: 'other',
      status: 'pending',
    },
  });
  ask(server, 100, 'other');
  await flush();
  expect(recorder.ofType('request.opened')).toHaveLength(connector ? 1 : 0);
  if (connector) {
    const request = recorder.ofType('request.opened')[0]!;
    expect(request.requestType).toBe('mcp_tool_approval');
    await adapter.respondToRequest('s', request.requestId, 'decline');
  }
  await flush();
  expect(server.received.find((message) => message.id === 100)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: connector ? 'reject_once' : 'allow_once' },
  });
});

function ask(server: FakeAppServer, id = 100, kind = 'execute') {
  server.send({
    id,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: { toolCallId: `tool-${id}`, title: 'Run shell command', kind },
      options: permissionOptions,
    },
  });
}

it.each([
  ['accept', 'allow_once'],
  ['decline', 'reject_once'],
  ['acceptForSession', 'allow_always'],
] as const)('answers %s using the exact Copilot option id', async (decision, optionId) => {
  const { adapter, recorder, server } = await start();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'run' });
  ask(server);
  const opened = await recorder.waitFor('request.opened');
  expect(opened.options.map((option) => option.decision)).toEqual([
    'accept',
    'acceptForSession',
    'decline',
    'cancel',
  ]);
  expect(server.received.find((message) => message.id === 100)).toBeUndefined();
  await adapter.respondToRequest('s', opened.requestId, decision);
  await flush();
  expect(server.received.find((message) => message.id === 100)?.result).toEqual({
    outcome: { outcome: 'selected', optionId },
  });
});

it.each([
  ['full-access', 'execute', false],
  ['auto-accept-edits', 'edit', false],
  ['auto-accept-edits', 'execute', true],
  ['auto', 'execute', true],
  ['approval-required', 'edit', true],
] satisfies Array<[RuntimeMode, string, boolean]>)(
  'uses Switch policy for %s / %s (asks: %s)',
  async (runtimeMode, kind, asks) => {
    const { adapter, recorder, server } = await start({ runtimeMode });
    await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'run' });
    ask(server, 100, kind);
    await flush();
    expect(recorder.ofType('request.opened')).toHaveLength(asks ? 1 : 0);
    if (!asks)
      expect(server.received.find((message) => message.id === 100)?.result).toEqual({
        outcome: { outcome: 'selected', optionId: 'allow_once' },
      });
  }
);

it('cancels pending permission on interrupt and queues a mid-turn message as a separate turn', async () => {
  const { adapter, recorder, server } = await start();
  await adapter.sendTurn({ sessionId: 's', turnId: 'one', text: '@copilot hello' });
  await server.waitFor('session/prompt');
  ask(server);
  await recorder.waitFor('request.opened');
  await adapter.sendTurn({ sessionId: 's', turnId: 'two', text: 'next message' });
  expect(server.received.filter((message) => message.method === 'session/prompt')).toHaveLength(1);
  server.on('message', (message) => {
    if (message.method === 'session/cancel') {
      const prompt = server.received.find((entry) => entry.method === 'session/prompt')!;
      server.send({ id: prompt.id, result: { stopReason: 'cancelled' } });
    }
  });
  await adapter.interruptTurn('s');
  await recorder.waitFor('turn.started', (event) => event.turnId === 'two');
  await flush();
  expect(server.received.find((message) => message.id === 100)?.result).toEqual({
    outcome: { outcome: 'cancelled' },
  });
  expect(recorder.ofType('turn.completed')).toContainEqual(
    expect.objectContaining({ turnId: 'one', outcome: 'interrupted' })
  );
  expect(server.received.filter((message) => message.method === 'session/prompt')).toHaveLength(2);
});

it('sends room instructions with the mention and reports tool activity and the reply', async () => {
  const { adapter, recorder, server } = await start({
    systemContext: 'Room context: project goals',
  });
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: '@copilot report status' });
  const prompt = await server.waitFor('session/prompt');
  expect(JSON.stringify(prompt.params)).toContain('Room context: project goals');
  expect(JSON.stringify(prompt.params)).toContain('@copilot report status');
  for (const [sessionUpdate, status] of [
    ['tool_call', 'in_progress'],
    ['tool_call_update', 'completed'],
  ])
    server.notify('session/update', {
      sessionId: 'native',
      update: { sessionUpdate, toolCallId: 'shell', kind: 'execute', title: 'Shell', status },
    });
  server.notify('session/update', {
    sessionId: 'native',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Ready.' } },
  });
  server.send({ id: prompt.id, result: { stopReason: 'end_turn' } });
  await recorder.waitFor('turn.completed');
  expect(recorder.ofType('item.started')).toContainEqual(
    expect.objectContaining({ item: expect.objectContaining({ type: 'command_execution' }) })
  );
  expect(recorder.ofType('item.completed')).toContainEqual(
    expect.objectContaining({ item: expect.objectContaining({ status: 'completed' }) })
  );
  expect(recorder.assistantText('t')).toBe('Ready.');
});

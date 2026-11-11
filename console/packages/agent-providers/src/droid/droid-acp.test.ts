import type * as fs from 'node:fs/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProviderSessionStartInput } from '../adapter';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';
import type * as providerProcess from '../provider-process';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));
vi.mock('../provider-process', async (original) => ({
  ...(await original<typeof providerProcess>()),
  execProvider: vi.fn(),
}));

const servers: FakeAppServer[] = [];
const spawned: Array<{ command: string; args: string[]; env: unknown }> = [];
const wire = {
  http: true,
  load: true,
  resume: true,
  selectModel: true,
  configModels: true,
  handshakeError: false,
  loadError: false,
};
const config = (currentValue = 'model-a') => [
  {
    id: 'model',
    type: 'select',
    currentValue,
    options: [
      { value: 'model-a', name: 'Model A' },
      { value: 'model-b', name: 'Model B' },
    ],
  },
];
vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[], options: { env: unknown }) => {
    spawned.push({ command, args, env: options.env });
    const server = new FakeAppServer();
    server.on('message', (message) => {
      if (message.method === 'initialize') {
        if (wire.handshakeError)
          server.send({ id: message.id, error: { code: -32603, message: 'initialize failed' } });
        else
          server.send({
            id: message.id,
            result: {
              protocolVersion: 1,
              agentCapabilities: {
                loadSession: wire.load,
                sessionCapabilities: wire.resume ? { resume: {} } : {},
                mcpCapabilities: { http: wire.http },
                promptCapabilities: { image: true, embeddedContext: true },
              },
              // Actual signed-out 1.4.1 initialize lists both methods.
              authMethods: [{ id: 'device-pairing' }, { id: 'factory-api-key' }],
            },
          });
      }
      if (['session/new', 'session/load', 'session/resume'].includes(message.method ?? '')) {
        if (message.method !== 'session/new' && wire.loadError)
          server.send({ id: message.id, error: { code: -32001, message: 'session not found' } });
        else
          server.send({
            id: message.id,
            result: {
              sessionId: message.params?.sessionId ?? `native-${servers.length}`,
              modes: { availableModes: [{ id: 'normal' }, { id: 'auto-high' }] },
              ...(wire.configModels
                ? { configOptions: config() }
                : {
                    models: {
                      availableModels: [{ modelId: 'model-a', name: 'Model A' }],
                      currentModelId: 'model-a',
                    },
                  }),
            },
          });
      }
    });
    server.replyAlways('session/set_mode', () => ({}));
    server.replyAlways('session/set_model', () => ({}));
    server.replyAlways('session/set_config_option', (params) => ({
      configOptions: config(wire.selectModel ? String(params.value) : 'model-a'),
    }));
    servers.push(server);
    return server;
  },
}));

const { createDroidAdapter, droidAcp, parseDroidDoctor } = await import('./droid-acp');
const { execProvider } = await import('../provider-process');
const { checkAcpSignIn } = await import('../acp/acp-adapter');
const { elicitationAnswer } = await import('../acp/elicitation');
const adapters: ReturnType<typeof createDroidAdapter>[] = [];
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  servers.length = 0;
  spawned.length = 0;
  Object.assign(wire, {
    http: true,
    load: true,
    resume: true,
    selectModel: true,
    configModels: true,
    handshakeError: false,
    loadError: false,
  });
  vi.mocked(execProvider).mockReset();
});
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.stopAll()));
});

async function start(overrides: Partial<ProviderSessionStartInput> = {}) {
  const adapter = createDroidAdapter({ binaryPath: '/tools/droid' });
  adapters.push(adapter);
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  const input: ProviderSessionStartInput = {
    sessionId: 's',
    cwd: '/work',
    runtimeMode: 'approval-required',
    env: { PATH: '/tools', HTTPS_PROXY: 'https://proxy.example.com' },
    mcpServers: {
      switch: { transport: 'http', url: 'http://localhost:1234/mcp', headers: {} },
      connector: { transport: 'stdio', command: 'node', args: ['connector.js'], env: {} },
    },
    connectorMcpServers: ['connector'],
    ...overrides,
  };
  const session = await adapter.startSession(input);
  return { adapter, session, input, events, server: servers.at(-1)! };
}

const doctor = (status: string, detail = '') =>
  JSON.stringify({ results: [{ id: 'auth.verify', status, detail }] });

it('launches the verified ACP command with exactly the supplied environment', async () => {
  const { input, server } = await start();
  expect(spawned).toEqual([
    { command: '/tools/droid', args: ['exec', '--output-format', 'acp-daemon'], env: input.env },
  ]);
  expect(server.received.map((message) => message.method)).toEqual([
    'initialize',
    'session/new',
    'session/set_mode',
  ]);
  expect(server.received[0]?.params).toMatchObject({
    clientCapabilities: { terminal: false, elicitation: { form: {} } },
  });
  expect(server.received[1]?.params).toMatchObject({
    mcpServers: [
      { type: 'http', name: 'switch', url: 'http://localhost:1234/mcp' },
      { name: 'connector', command: 'node' },
    ],
  });
});

it('uses a bounded non-interactive doctor check; never authenticates or creates a session', async () => {
  vi.mocked(execProvider).mockResolvedValue({ stdout: doctor('pass'), stderr: '' });
  const input = { binaryPath: '/tools/droid', cwd: '/work', env: { CUSTOM: 'preserved' } };
  expect(await checkAcpSignIn(droidAcp, input)).toMatchObject({ status: 'authenticated' });
  expect(execProvider).toHaveBeenCalledWith(
    input.binaryPath,
    ['doctor', '--checks', 'auth', '--json', '--timeout', '5000'],
    expect.objectContaining({ cwd: input.cwd, env: input.env, timeout: 20_000 })
  );
  expect(servers).toHaveLength(0);
});

it('handles nonzero doctor exits without exposing diagnostic output', async () => {
  vi.mocked(execProvider).mockRejectedValue({
    stdout: doctor('fail', 'FACTORY_API_KEY is set but the Factory API rejected it'),
    stderr: 'private diagnostic',
  });
  const result = await checkAcpSignIn(droidAcp, { binaryPath: 'droid', cwd: '/', env: {} });
  expect(result).toEqual({
    status: 'unauthenticated',
    message: 'Sign in on the execution machine with droid.',
    models: [],
  });
  vi.mocked(execProvider).mockRejectedValue(new Error('private diagnostic'));
  expect(await checkAcpSignIn(droidAcp, { binaryPath: 'droid', cwd: '/', env: {} })).toMatchObject({
    status: 'unknown',
    message: expect.not.stringContaining('private diagnostic'),
  });
});

it.each([
  [doctor('pass', 'private account data'), 'authenticated'],
  [doctor('warn', 'no usable credentials found (not logged in)'), 'unauthenticated'],
  [doctor('fail', 'network timeout'), 'unknown'],
  [doctor('warn', 'FACTORY_API_KEY validation was inconclusive'), 'unknown'],
  ['{"results":[{"id":"auth.credentials","status":"pass"}]}', 'unknown'],
  ['{"authMethods":[]}', 'unknown'],
  ['null', 'unknown'],
  ['not JSON', 'unknown'],
])('interprets doctor results conservatively (%s)', (output, status) => {
  const result = parseDroidDoctor(output);
  expect(result.status).toBe(status);
  expect(result.message).not.toContain('private account data');
});

it('surfaces handshake errors and refuses HTTP MCP without its advertised capability', async () => {
  wire.handshakeError = true;
  await expect(start()).rejects.toThrow('initialize failed');
  expect(servers[0]!.received.some((message) => message.method === 'authenticate')).toBe(false);
  wire.handshakeError = false;
  wire.http = false;
  await expect(start()).rejects.toThrow(/MCP over HTTP/);
  expect(servers[1]!.received.some((message) => message.method === 'session/new')).toBe(false);
});

it.each(['approval-required', 'full-access', 'auto', 'auto-accept-edits'] as const)(
  'keeps native auto-run off in %s',
  async (runtimeMode) => {
    const { server } = await start({ runtimeMode });
    expect(
      server.received.find((message) => message.method === 'session/set_mode')?.params
    ).toEqual({
      sessionId: 'native-1',
      modeId: 'normal',
    });
  }
);

it('refuses to start when Auto Off cannot be selected', () => {
  expect(() => droidAcp.sessionMode!('approval-required', undefined)).toThrow('normal');
  expect(() =>
    droidAcp.sessionMode!('approval-required', { availableModes: [{ id: 'auto-high' }] })
  ).toThrow('normal');
});

it('selects advertised models before the first prompt and rejects a silently ignored selection', async () => {
  const { adapter, server } = await start({ model: { id: 'model-b' } });
  expect(await adapter.listModels('s')).toMatchObject([
    { id: 'model-a', label: 'Model A' },
    { id: 'model-b', label: 'Model B' },
  ]);
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'hello' });
  await server.waitFor('session/prompt');
  const methods = server.received.map((message) => message.method);
  expect(methods.indexOf('session/set_config_option')).toBeLessThan(
    methods.indexOf('session/prompt')
  );
  await expect(adapter.setModel('s', { id: 'missing' })).rejects.toThrow('Unavailable model');
  wire.selectModel = false;
  await expect(adapter.setModel('s', { id: 'model-b' })).rejects.toThrow('did not select');
});

it('supports the legacy advertised model list without inventing model IDs', async () => {
  wire.configModels = false;
  const { adapter, server } = await start({ model: { id: 'model-a' } });
  expect(server.received.find((message) => message.method === 'session/set_model')?.params).toEqual(
    {
      sessionId: 'native-1',
      modelId: 'model-a',
    }
  );
  await expect(adapter.setModel('s', { id: 'missing' })).rejects.toThrow('Unavailable model');
});

const permissionOptions = [
  { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'proceed_auto_run_high', name: 'Allow & auto-run (high risk)', kind: 'allow_always' },
  { optionId: 'proceed_always_server', name: 'Always allow server tools', kind: 'allow_always' },
  { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
];
function permission(server: FakeAppServer, id = 101, meta?: Record<string, unknown>) {
  server.send({
    id,
    method: 'session/request_permission',
    params: {
      sessionId: 'native-1',
      toolCall: { toolCallId: 'tool', kind: 'execute', title: 'Run command', _meta: meta },
      options: permissionOptions,
    },
  });
}

it.each(['accept', 'decline'] as const)(
  'routes permission %s without persistent grants',
  async (decision) => {
    const { adapter, events, server } = await start();
    await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'run command' });
    permission(server);
    await flush();
    const request = events.find((event) => event.type === 'request.opened');
    if (!request || request.type !== 'request.opened') throw new Error('missing permission');
    expect(request.options.map((option) => option.decision)).toEqual([
      'accept',
      'decline',
      'cancel',
    ]);
    await expect(
      adapter.respondToRequest('s', request.requestId, 'acceptForSession')
    ).rejects.toThrow('not offered');
    await adapter.respondToRequest('s', request.requestId, decision);
    await flush();
    expect(server.received.find((message) => message.id === 101)?.result).toEqual({
      outcome: { outcome: 'selected', optionId: decision === 'accept' ? 'proceed_once' : 'cancel' },
    });
  }
);

it('auto-approves once in full access and for Switch MCP, but asks for connector tools', async () => {
  const { adapter, events, server } = await start();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'read room context' });
  permission(server, 101, { factory: { source: 'mcp', server: 'switch', tool: 'read_room' } });
  await flush();
  expect(server.received.find((message) => message.id === 101)?.result).toMatchObject({
    outcome: { optionId: 'proceed_once' },
  });
  expect(events.some((event) => event.type === 'request.opened')).toBe(false);
  permission(server, 102, { factory: { source: 'mcp', server: 'connector', tool: 'write' } });
  await flush();
  expect(events.find((event) => event.type === 'request.opened')).toMatchObject({
    requestType: 'mcp_tool_approval',
    connector: 'connector',
  });
  const full = await start({ runtimeMode: 'full-access', sessionId: 'full' });
  await full.adapter.sendTurn({ sessionId: 'full', turnId: 't', text: 'run command' });
  // The second process uses another native session ID.
  full.server.send({
    id: 103,
    method: 'session/request_permission',
    params: {
      sessionId: full.session.nativeSessionId,
      toolCall: { toolCallId: 'tool', kind: 'execute' },
      options: permissionOptions,
    },
  });
  await flush();
  expect(full.server.received.find((message) => message.id === 103)?.result).toMatchObject({
    outcome: { optionId: 'proceed_once' },
  });
});

it('never substitutes a persistent grant when full access is offered no allow-once choice', async () => {
  const { adapter, events, server } = await start({ runtimeMode: 'full-access' });
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'run command' });
  server.send({
    id: 101,
    method: 'session/request_permission',
    params: {
      sessionId: 'native-1',
      toolCall: { toolCallId: 'tool', kind: 'execute' },
      options: permissionOptions.filter((option) => option.kind === 'allow_always'),
    },
  });
  await flush();
  expect(server.received.find((message) => message.id === 101)).toBeUndefined();
  const request = events.find((event) => event.type === 'request.opened');
  if (!request || request.type !== 'request.opened') throw new Error('missing permission');
  expect(request.options).toEqual([{ decision: 'cancel', label: 'Cancel' }]);
  await adapter.respondToRequest('s', request.requestId, 'decline');
  await flush();
  expect(server.received.find((message) => message.id === 101)?.result).toEqual({
    outcome: { outcome: 'cancelled' },
  });
});

it('keeps room context and mentions, orders queued turns, and completes tool activity', async () => {
  const { adapter, events, server } = await start({ systemContext: 'Switch room instructions' });
  await adapter.sendTurn({ sessionId: 's', turnId: 'first', text: '@droid read context' });
  const prompt = await server.waitFor('session/prompt');
  await adapter.sendTurn({ sessionId: 's', turnId: 'second', text: 'next message' });
  expect(server.received.filter((message) => message.method === 'session/prompt')).toHaveLength(1);
  expect(prompt.params?.prompt).toEqual([
    { type: 'text', text: 'Switch room instructions\n\n@droid read context' },
  ]);
  for (const [sessionUpdate, status] of [
    ['tool_call', 'pending'],
    ['tool_call_update', 'completed'],
  ])
    server.notify('session/update', {
      sessionId: 'native-1',
      update: {
        sessionUpdate,
        toolCallId: 'tool',
        kind: 'execute',
        status,
        title: 'Run command',
        content: [{ type: 'content', content: { type: 'text', text: 'command output' } }],
      },
    });
  server.send({ id: prompt.id, result: { stopReason: 'end_turn' } });
  await flush();
  const prompts = server.received.filter((message) => message.method === 'session/prompt');
  expect(prompts[1]?.params?.prompt).toEqual([{ type: 'text', text: 'next message' }]);
  expect(events.find((event) => event.type === 'item.completed')).toMatchObject({
    item: { type: 'command_execution', status: 'completed', text: 'command output' },
  });
  server.send({ id: prompts[1]!.id, result: { stopReason: 'end_turn' } });
  await flush();
  expect(
    events.filter((event) => event.type === 'turn.completed').map((event) => event.turnId)
  ).toEqual(['first', 'second']);
});

it('cancels pending approvals, ignores late updates, and drains queued input after interrupt settles', async () => {
  const { adapter, events, server } = await start();
  await adapter.sendTurn({ sessionId: 's', turnId: 'first', text: 'work' });
  const prompt = await server.waitFor('session/prompt');
  await adapter.sendTurn({ sessionId: 's', turnId: 'second', text: 'after interrupt' });
  permission(server);
  await flush();
  await adapter.interruptTurn('s');
  permission(server, 102);
  server.notify('session/update', {
    sessionId: 'native-1',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late text' } },
  });
  await flush();
  expect(server.received.some((message) => message.method === 'session/cancel')).toBe(true);
  for (const id of [101, 102])
    expect(server.received.find((message) => message.id === id)?.result).toEqual({
      outcome: { outcome: 'cancelled' },
    });
  expect(events.some((event) => event.type === 'content.delta')).toBe(false);
  expect(server.received.filter((message) => message.method === 'session/prompt')).toHaveLength(1);
  server.send({ id: prompt.id, result: { stopReason: 'cancelled' } });
  await flush();
  expect(events.find((event) => event.type === 'turn.completed')).toMatchObject({
    turnId: 'first',
    outcome: 'interrupted',
  });
  expect(server.received.filter((message) => message.method === 'session/prompt')).toHaveLength(2);
});

it('answers Droid form elicitations and cancels them on interrupt', async () => {
  const { adapter, events, server } = await start();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'ask me' });
  const ask = (id: number) =>
    server.send({
      id,
      method: 'elicitation/create',
      params: {
        mode: 'form',
        requestedSchema: {
          properties: {
            question_0: {
              type: 'string',
              title: 'Choose',
              oneOf: [{ const: 'option_0', title: 'First' }],
            },
          },
        },
      },
    });
  ask(101);
  await flush();
  const question = events.find((event) => event.type === 'user-input.requested');
  if (!question || question.type !== 'user-input.requested') throw new Error('missing question');
  await adapter.respondToUserInput('s', question.requestId, { question_0: 'option_0' });
  await flush();
  expect(server.received.find((message) => message.id === 101)?.result).toEqual({
    action: 'accept',
    content: { question_0: 'option_0' },
  });
  ask(102);
  await flush();
  await adapter.interruptTurn('s');
  await flush();
  expect(server.received.find((message) => message.id === 102)?.result).toEqual({
    action: 'cancel',
  });
});

it.each(['string', 'array'])('encodes Droid custom answers for a %s question', (type) => {
  const choices = { oneOf: [{ const: 'option_0' }, { const: 'other' }] };
  const request = {
    requestedSchema: {
      properties: {
        question_0: type === 'array' ? { type, items: choices } : { type, ...choices },
        question_0_other: { type: 'string' },
      },
    },
  };
  expect(
    elicitationAnswer(request, [{ questionId: 'question_0', values: [], custom: 'purple' }])
  ).toEqual({
    action: 'accept',
    content: {
      question_0: type === 'array' ? ['other'] : 'other',
      question_0_other: 'purple',
    },
  });
});

it.each(['load', 'resume'] as const)(
  'recovers the native ID through %s in a fresh adapter process',
  async (method) => {
    const first = await start();
    await first.adapter.stopAll();
    wire.load = method === 'load';
    const next = await start({ resume: { nativeSessionId: first.session.nativeSessionId } });
    expect(servers).toHaveLength(2);
    expect(
      next.server.received.find((message) => message.method === `session/${method}`)?.params
    ).toMatchObject({
      sessionId: first.session.nativeSessionId,
      cwd: '/work',
    });
    expect(next.server.received.some((message) => message.method === 'session/new')).toBe(false);
  }
);

it('reports unavailable or failed native recovery instead of silently starting a new conversation', async () => {
  wire.load = false;
  wire.resume = false;
  await expect(start({ resume: { nativeSessionId: 'saved' } })).rejects.toThrow('cannot resume');
  wire.load = true;
  wire.loadError = true;
  await expect(start({ resume: { nativeSessionId: 'saved' } })).rejects.toThrow(
    'session not found'
  );
  expect(
    servers.every((server) => !server.received.some((message) => message.method === 'session/new'))
  ).toBe(true);
});

it('settles running and queued turns once when the process exits', async () => {
  const { adapter, events, server } = await start();
  for (const turnId of ['first', 'second'])
    await adapter.sendTurn({ sessionId: 's', turnId, text: turnId });
  server.kill();
  await flush();
  expect(adapter.hasSession('s')).toBe(false);
  expect(events.filter((event) => event.type === 'turn.completed')).toMatchObject([
    { turnId: 'first', outcome: 'error' },
    { turnId: 'second', outcome: 'error' },
  ]);
});

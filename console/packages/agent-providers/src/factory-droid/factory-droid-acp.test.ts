import type * as fs from 'node:fs/promises';
import { beforeEach, expect, it, vi } from 'vitest';
import type { RuntimeMode } from '../adapter';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';
import type * as providerProcess from '../provider-process';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));
const servers: FakeAppServer[] = [];
const spawned: Array<{ command: string; args: string[] }> = [];
/** `session/new` as droid 1.5.0 builds it, trimmed to what Switch reads. */
const droidSession = {
  sessionId: 'native',
  modes: {
    currentModeId: 'normal',
    availableModes: [
      { id: 'normal', name: 'Auto (Off)' },
      { id: 'spec', name: 'Spec' },
      { id: 'auto-low', name: 'Auto (Low)' },
      { id: 'auto-medium', name: 'Auto (Medium)' },
      { id: 'auto-high', name: 'Auto (High)' },
    ],
  },
  models: {
    currentModelId: 'gpt-6.1-sol',
    availableModels: [
      { modelId: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' },
      { modelId: 'claude-sonnet-5', name: 'Sonnet 5' },
    ],
  },
  configOptions: [
    {
      id: 'autonomy_level',
      name: 'Autonomy Level',
      category: 'mode',
      type: 'select',
      currentValue: 'normal',
      options: [{ value: 'normal', name: 'Auto (Off)' }],
    },
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'gpt-6.1-sol',
      options: [
        { value: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' },
        { value: 'claude-sonnet-5', name: 'Sonnet 5' },
      ],
    },
  ],
};
vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[]) => {
    spawned.push({ command, args });
    const server = new FakeAppServer();
    // droid 1.5.0's `initialize`, trimmed.
    server.replyAlways('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { resume: {} },
        promptCapabilities: { image: true, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
      },
      authMethods: [
        { id: 'device-pairing', name: 'Login' },
        { id: 'factory-api-key', name: 'Factory API Key' },
      ],
    }));
    server.replyAlways('session/new', () => droidSession);
    server.replyAlways('session/load', () => ({ modes: droidSession.modes }));
    server.replyAlways('session/set_mode', () => ({}));
    server.replyAlways('session/set_config_option', () => ({}));
    servers.push(server);
    return server;
  },
}));
const doctor = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: readonly string[] }>,
  answer: async (): Promise<{ stdout: string; stderr: string }> => ({ stdout: '', stderr: '' }),
}));
vi.mock('../provider-process', async (original) => ({
  ...(await original<typeof providerProcess>()),
  execProvider: (command: string, args: readonly string[]) => {
    doctor.calls.push({ command, args });
    return doctor.answer();
  },
}));
const { factoryDroidAcp, parseDroidDoctor, createFactoryDroidAdapter } =
  await import('./factory-droid-acp');

beforeEach(() => {
  servers.length = 0;
  spawned.length = 0;
  doctor.calls.length = 0;
});

async function setup(input: { runtimeMode?: RuntimeMode; resume?: string; model?: string } = {}) {
  const adapter = createFactoryDroidAdapter();
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
const modeOf = (server: FakeAppServer) =>
  server.received.find((m) => m.method === 'session/set_mode')?.params;

it('starts droid exec over ACP with no sign-in call, in its read-only autonomy, with the HTTP MCP server', async () => {
  const { server, session } = await setup();
  expect(spawned.at(-1)).toEqual({ command: 'droid', args: ['exec', '--output-format', 'acp'] });
  expect(session.nativeSessionId).toBe('native');
  expect(server.received.some((m) => m.method === 'authenticate')).toBe(false);
  expect(server.received.find((m) => m.method === 'session/new')?.params).toMatchObject({
    mcpServers: [
      {
        type: 'http',
        name: 'switch',
        url: 'http://127.0.0.1:4567/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer per-session' }],
      },
    ],
  });
  expect(modeOf(server)).toEqual({ sessionId: 'native', modeId: 'normal' });
});

it.each([
  ['auto-accept-edits', 'auto-low'],
  ['auto', 'auto-medium'],
  ['full-access', 'auto-high'],
] as const)('puts a %s session in Droid’s %s autonomy', async (runtimeMode, modeId) => {
  const { server } = await setup({ runtimeMode });
  expect(modeOf(server)).toEqual({ sessionId: 'native', modeId });
});

it('resumes the exact native session through session/load', async () => {
  const { server, session } = await setup({ resume: 'saved', runtimeMode: 'full-access' });
  expect(session.nativeSessionId).toBe('saved');
  expect(server.received.find((m) => m.method === 'session/load')?.params).toMatchObject({
    sessionId: 'saved',
    cwd: '/work',
  });
  expect(modeOf(server)).toEqual({ sessionId: 'saved', modeId: 'auto-high' });
});

it('lists the models of its model option and selects the chosen one', async () => {
  const { adapter, server } = await setup({ model: 'claude-sonnet-5' });
  expect((await adapter.listModels('s')).map((model) => model.id)).toEqual([
    'gpt-6.1-sol',
    'claude-sonnet-5',
  ]);
  expect(server.received.find((m) => m.method === 'session/set_config_option')?.params).toEqual({
    sessionId: 'native',
    configId: 'model',
    value: 'claude-sonnet-5',
  });
});

it('asks for a Droid permission in the room and answers with the option chosen', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  // droid 1.5.0's options for an Execute call.
  const options = [
    { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
    {
      optionId: 'proceed_auto_run_low',
      name: 'Allow & auto-run (low risk)',
      kind: 'allow_always',
    },
    { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' },
  ];
  for (const id of [70, 71])
    server.send({
      id,
      method: 'session/request_permission',
      params: {
        sessionId: 'native',
        toolCall: { toolCallId: `call-${id}`, title: 'ls', kind: 'execute' },
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
    expect(event.options.map((o) => o.decision)).toEqual([
      'accept',
      'acceptForSession',
      'decline',
      'cancel',
    ]);
    await adapter.respondToRequest('s', event.requestId, decision);
  }
  await flush();
  expect([70, 71].map((id) => server.received.find((m) => m.id === id)?.result)).toEqual([
    { outcome: { outcome: 'selected', optionId: 'proceed_once' } },
    { outcome: { outcome: 'selected', optionId: 'cancel' } },
  ]);
});

it('reads the MCP server of a tool call from Droid’s _meta, and nothing else', () => {
  const call = (meta: unknown) =>
    factoryDroidAcp.mcpServerOf!({ toolCallId: 'c', _meta: meta as Record<string, unknown> });
  expect(call({ factory: { source: 'mcp', server: 'switch', tool: 'send' } })).toBe('switch');
  expect(call({ factory: { source: 'connector', server: 'slack', tool: 'post' } })).toBeUndefined();
  expect(call(undefined)).toBeUndefined();
});

/** `droid doctor --checks auth --json` from droid 1.5.0, its auth checks only. */
const report = (verify: { status: string; detail: string }) =>
  JSON.stringify({ ok: true, results: [{ id: 'auth.verify', category: 'auth', ...verify }] });

it('reads the sign-in from Droid’s doctor report', () => {
  expect(
    parseDroidDoctor(report({ status: 'pass', detail: 'authenticated as a@b.c' }), false)
  ).toMatchObject({ status: 'authenticated' });
  expect(
    parseDroidDoctor(
      report({ status: 'warn', detail: 'no usable credentials found (not logged in)' }),
      false
    )
  ).toEqual({
    status: 'unauthenticated',
    message: 'Sign in on the execution machine with droid.',
    models: [],
  });
  // A key is only checked against the API with connectivity probes too.
  const inconclusive = report({
    status: 'warn',
    detail: 'FACTORY_API_KEY validation was inconclusive because connectivity was not checked',
  });
  expect(parseDroidDoctor(inconclusive, true)).toMatchObject({ status: 'authenticated' });
  expect(
    parseDroidDoctor(
      report({ status: 'fail', detail: 'FACTORY_API_KEY is set but the Factory API rejected it' }),
      true
    )
  ).toMatchObject({ status: 'unauthenticated' });
  expect(parseDroidDoctor('', false)).toMatchObject({ status: 'unknown' });
});

it('checks the sign-in with the doctor, never starting a session or a sign-in', async () => {
  doctor.answer = async () => ({
    stdout: report({ status: 'warn', detail: 'no usable credentials found (not logged in)' }),
    stderr: '',
  });
  const handshake = vi.fn(async () => ({}));
  const request = vi.fn();
  await expect(
    factoryDroidAcp.checkSignIn!({
      binaryPath: '/bin/droid',
      cwd: '/work',
      env: {},
      handshake,
      request,
    })
  ).resolves.toMatchObject({ status: 'unauthenticated' });
  expect(doctor.calls).toEqual([
    { command: '/bin/droid', args: ['doctor', '--checks', 'auth', '--json'] },
  ]);
  expect(handshake).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});

// Form emitted by Droid 1.6.0 for an AskUser multiple-choice question.
const droidForm = {
  sessionId: 'native',
  mode: 'form',
  message: 'Droid needs your answers to continue.',
  requestedSchema: {
    type: 'object',
    properties: {
      question_1: {
        type: 'string',
        title: 'Color',
        description: 'Which color?',
        oneOf: [
          { const: 'option_0', title: 'red' },
          { const: 'option_1', title: 'green' },
          { const: 'option_2', title: 'blue' },
          { const: 'other', title: 'Other answer' },
        ],
      },
      question_1_other: {
        type: 'string',
        title: 'Color: Other answer',
        description: 'Enter your answer here if you select Other answer.',
      },
    },
    required: ['question_1'],
  },
};

it('announces elicitation and answers Droid with the selected option ID', async () => {
  const { adapter, server, events } = await setup();
  expect(adapter.capabilities.userInput).toBe(true);
  expect(server.received[0]?.params).toMatchObject({
    clientCapabilities: { elicitation: { form: {} } },
  });
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'ask' });
  server.send({ id: 300, method: 'elicitation/create', params: droidForm });
  await flush();
  const event = events.find((e) => e.type === 'user-input.requested');
  if (!event || event.type !== 'user-input.requested') throw new Error('No question');
  expect(event.questions).toEqual([
    {
      id: 'question_1',
      header: 'Color',
      question: 'Which color?',
      options: [
        { value: 'option_0', label: 'red' },
        { value: 'option_1', label: 'green' },
        { value: 'option_2', label: 'blue' },
      ],
      multiSelect: false,
      allowCustomAnswer: true,
    },
  ]);
  await adapter.respondToUserInput('s', event.requestId, { question_1: 'option_1' });
  await flush();
  expect(server.received.find((m) => m.id === 300)?.result).toEqual({
    action: 'accept',
    content: { question_1: 'option_1' },
  });
  expect(events.filter((e) => e.type === 'user-input.resolved')).toHaveLength(1);
});

it('answers Droid custom input with the Other sentinel and companion text', async () => {
  const { adapter, server, events } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'ask' });
  server.send({ id: 301, method: 'elicitation/create', params: droidForm });
  await flush();
  const event = events.find((e) => e.type === 'user-input.requested');
  if (!event || event.type !== 'user-input.requested') throw new Error('No question');
  await adapter.respondToUserInput('s', event.requestId, { question_1: 'purple' });
  await flush();
  expect(server.received.find((m) => m.id === 301)?.result).toEqual({
    action: 'accept',
    content: { question_1: 'other', question_1_other: 'purple' },
  });
});

it('maps multi-select Droid options and a typed answer into the right fields', async () => {
  const { adapter, server, events } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'ask' });
  const { oneOf, ...property } = droidForm.requestedSchema.properties.question_1;
  server.send({
    id: 302,
    method: 'elicitation/create',
    params: {
      ...droidForm,
      requestedSchema: {
        properties: {
          ...droidForm.requestedSchema.properties,
          question_1: { ...property, type: 'array', items: { anyOf: oneOf } },
        },
      },
    },
  });
  await flush();
  const event = events.find((e) => e.type === 'user-input.requested');
  if (!event || event.type !== 'user-input.requested') throw new Error('No question');
  expect(event.questions[0]).toMatchObject({ multiSelect: true, allowCustomAnswer: true });
  await adapter.respondToUserInput('s', event.requestId, { question_1: ['option_0', 'purple'] });
  await flush();
  expect(server.received.find((m) => m.id === 302)?.result).toEqual({
    action: 'accept',
    content: { question_1: ['option_0', 'other'], question_1_other: 'purple' },
  });
});

it('keeps multiple questions separate including free text', async () => {
  const { adapter, server, events } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'ask' });
  server.send({
    id: 303,
    method: 'elicitation/create',
    params: {
      ...droidForm,
      requestedSchema: {
        properties: {
          ...droidForm.requestedSchema.properties,
          question_2: { type: 'string', title: 'Why?', description: 'Explain your choice.' },
        },
      },
    },
  });
  await flush();
  const event = events.find((e) => e.type === 'user-input.requested');
  if (!event || event.type !== 'user-input.requested') throw new Error('No question');
  expect(event.questions.map((q) => q.id)).toEqual(['question_1', 'question_2']);
  await adapter.respondToUserInput('s', event.requestId, {
    question_1: 'option_2',
    question_2: 'It is calm',
  });
  await flush();
  expect(server.received.find((m) => m.id === 303)?.result).toEqual({
    action: 'accept',
    content: { question_1: 'option_2', question_2: 'It is calm' },
  });
});

it('declines malformed forms and non-form elicitations without opening questions', async () => {
  const { adapter, server, events } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'ask' });
  const forms: unknown[] = [
    null,
    { mode: 'url' },
    { requestedSchema: { properties: { q: null } } },
    { requestedSchema: { properties: { q: { oneOf: [null] } } } },
  ];
  forms.forEach((params, n) =>
    server.send({
      id: 310 + n,
      method: 'elicitation/create',
      params: params as Record<string, unknown>,
    })
  );
  await flush();
  for (const id of [310, 311, 312, 313])
    expect(server.received.find((m) => m.id === id)?.result).toEqual({ action: 'decline' });
  expect(events.filter((e) => e.type === 'user-input.requested')).toHaveLength(0);
});

it('cancels multiple pending forms on interrupt and outside a turn', async () => {
  const { adapter, server, events } = await setup();
  server.send({ id: 320, method: 'elicitation/create', params: droidForm });
  await flush();
  expect(server.received.find((m) => m.id === 320)?.result).toEqual({ action: 'cancel' });
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'ask' });
  for (const id of [321, 322]) server.send({ id, method: 'elicitation/create', params: droidForm });
  await flush();
  expect(events.filter((e) => e.type === 'user-input.requested')).toHaveLength(2);
  await adapter.interruptTurn('s');
  await flush();
  for (const id of [321, 322])
    expect(server.received.find((m) => m.id === id)?.result).toEqual({ action: 'cancel' });
  expect(events.filter((e) => e.type === 'user-input.resolved')).toHaveLength(2);
});

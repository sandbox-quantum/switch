import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { checkAcpSignIn } from '../acp/acp-adapter';
import type { AcpElicitationRequest } from '../acp/elicitation';
import type { McpServerSpec, RuntimeMode } from '../adapter';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';
import type * as providerProcess from '../provider-process';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));
const servers: FakeAppServer[] = [];
/** What `kimi acp` 2.5.0 answers, from its acp-server source. */
vi.mock('node:child_process', () => ({
  spawn: () => {
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {}, fork: {} },
        mcpCapabilities: { http: true, sse: true },
      },
      authMethods: [{ id: 'login', type: 'terminal', name: 'Login with Kimi account' }],
      agentInfo: { name: 'Kimi Code CLI', version: '2.5.0' },
    }));
    server.replyAlways('session/new', () => ({
      sessionId: 'native',
      configOptions: [
        {
          type: 'select',
          id: 'model',
          currentValue: 'kimi-for-coding',
          options: [{ value: 'kimi-for-coding', name: 'kimi-for-coding' }],
        },
        {
          type: 'select',
          id: 'mode',
          currentValue: 'default',
          options: ['default', 'plan', 'auto', 'yolo'].map((value) => ({ value, name: value })),
        },
      ],
      modes: {
        currentModeId: 'default',
        availableModes: [{ id: 'default' }, { id: 'plan' }, { id: 'auto' }, { id: 'yolo' }],
      },
    }));
    server.replyAlways('session/set_mode', () => ({}));
    servers.push(server);
    return server;
  },
}));
/** What `kimi provider list --json` prints, and the arguments and environment of each run of it. */
const kimi = {
  providers: {} as Record<string, unknown>,
  models: {} as Record<string, unknown>,
  /** Answers in place of the list, or throws as a failed run does. */
  answer: undefined as (() => { stdout: string; stderr: string }) | undefined,
  runs: [] as Array<{ args: readonly string[]; env?: NodeJS.ProcessEnv }>,
};
vi.mock('../provider-process', async (original) => ({
  ...(await original<typeof providerProcess>()),
  execProvider: async (
    _command: string,
    args: readonly string[],
    options: { env?: NodeJS.ProcessEnv }
  ) => {
    kimi.runs.push({ args, env: options.env });
    return (
      kimi.answer?.() ?? {
        stdout: JSON.stringify({ providers: kimi.providers, models: kimi.models }),
        stderr: '',
      }
    );
  },
}));
const { createKimiCodeAdapter, kimiCodeAcp, kimiCodeQuestions } = await import('./kimi-code-acp');
beforeEach(() => {
  servers.length = 0;
  kimi.providers = {};
  kimi.models = {};
  kimi.answer = undefined;
  kimi.runs.length = 0;
});
afterEach(() => {
  for (const server of servers) server.kill();
});
const httpSwitch: Record<string, McpServerSpec> = {
  switch: {
    transport: 'http',
    url: 'http://127.0.0.1:4567/mcp',
    headers: { Authorization: 'Bearer per-session' },
  },
};
/** The options of an approval Kimi asks for. */
const approval = [
  { optionId: 'approve_once', name: 'Approve once', kind: 'allow_once' },
  { optionId: 'approve_always', name: 'Approve for this session', kind: 'allow_always' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];
async function setup(
  runtimeMode: RuntimeMode = 'approval-required',
  mcpServers: Record<string, McpServerSpec> = {}
) {
  const adapter = createKimiCodeAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode,
    env: {},
    mcpServers,
    connectorMcpServers: [],
  });
  const server = servers.at(-1)!;
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  const toolCall = (toolCallId: string, title: string, kind = 'other') =>
    server.notify('session/update', {
      sessionId: 'native',
      update: { sessionUpdate: 'tool_call', toolCallId, title, kind, status: 'in_progress' },
    });
  const askPermission = (id: number, call: Record<string, unknown>, options = approval) =>
    server.send({
      id,
      method: 'session/request_permission',
      params: { sessionId: 'native', toolCall: call, options },
    });
  return { adapter, events, server, toolCall, askPermission };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

it('launches kimi acp with the environment it is given, no update of its own, to stop on closed input', async () => {
  const launch = await kimiCodeAcp.launch({
    binaryPath: 'kimi',
    cwd: '/work',
    env: { PATH: '/usr/bin' },
  });
  expect(launch).toEqual({
    command: 'kimi',
    args: ['acp'],
    env: { PATH: '/usr/bin', KIMI_CODE_NO_AUTO_UPDATE: '1' },
    exitsOnClosedInput: true,
  });
  expect(kimiCodeAcp.inheritEnv).toEqual(
    expect.arrayContaining([
      'KIMI_CODE_HOME',
      'KIMI_SHELL_PATH',
      'KIMI_MODEL_NAME',
      'KIMI_MODEL_API_KEY',
    ])
  );
});

it("puts auto mode and full access in Kimi's yolo, never its auto, which refuses questions", () => {
  expect(kimiCodeAcp.sessionMode?.('approval-required', undefined)).toBe('default');
  expect(kimiCodeAcp.sessionMode?.('auto-accept-edits', undefined)).toBe('default');
  expect(kimiCodeAcp.sessionMode?.('auto', undefined)).toBe('yolo');
  expect(kimiCodeAcp.sessionMode?.('full-access', undefined)).toBe('yolo');
});

it('starts a session with its HTTP MCP servers and mode, without authenticate', async () => {
  const { adapter, server } = await setup('approval-required', httpSwitch);
  expect(server.received.slice(0, 3).map((m) => m.method)).toEqual([
    'initialize',
    'session/new',
    'session/set_mode',
  ]);
  expect(server.received[0]?.params).toMatchObject({
    clientCapabilities: { elicitation: { form: {} } },
  });
  expect(server.received[1]?.params).toMatchObject({
    mcpServers: [
      {
        name: 'switch',
        type: 'http',
        url: 'http://127.0.0.1:4567/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer per-session' }],
      },
    ],
  });
  expect(server.received[2]?.params).toEqual({ sessionId: 'native', modeId: 'default' });
  expect(await adapter.listModels('s')).toMatchObject([{ id: 'kimi-for-coding' }]);
});

it("answers sign-in from Kimi's providers and models, without running kimi acp", async () => {
  const home = mkdtempSync(join(tmpdir(), 'kimi-code-'));
  let env: Record<string, string> = { KIMI_CODE_HOME: join(home, '.kimi-code') };
  const check = (providers: Record<string, unknown>, models: Record<string, unknown> = {}) => {
    kimi.providers = providers;
    kimi.models = models;
    return checkAcpSignIn(kimiCodeAcp, { binaryPath: 'kimi', cwd: '/work', env });
  };
  const status = async (providers: Record<string, unknown>, models?: Record<string, unknown>) =>
    (await check(providers, models)).status;
  const local = { local: { type: 'openai', baseUrl: 'http://127.0.0.1:9/v1' } };
  const fromEnv = { mistral: { type: 'openai', apiKeyEnv: 'MISTRAL_API_KEY' } };
  const managed = {
    'managed:kimi-code': {
      type: 'kimi',
      apiKey: '',
      oauth: { storage: 'file', key: 'oauth/kimi-code' },
    },
  };
  try {
    expect(await check({})).toMatchObject({
      status: 'unauthenticated',
      message: expect.stringContaining('kimi login'),
    });
    expect(await status({ moonshot: { type: 'kimi', apiKey: 'placeholder' } })).toBe(
      'authenticated'
    );
    expect(await status({ moonshot: { type: 'kimi', apiKey: ' ' } })).toBe('unauthenticated');
    expect(await status({ moonshot: { type: 'kimi', env: { KIMI_API_KEY: 'placeholder' } } })).toBe(
      'authenticated'
    );
    expect(await status({ moonshot: { type: 'kimi', env: { KIMI_BASE_URL: 'http://x' } } })).toBe(
      'unauthenticated'
    );
    expect(await status(local)).toBe('unauthenticated');
    expect(await status(local, { k2: { provider: 'local', apiKey: 'placeholder' } })).toBe(
      'authenticated'
    );
    expect(await status(fromEnv)).toBe('unauthenticated');
    env = { ...env, MISTRAL_API_KEY: 'placeholder' };
    expect(await status(fromEnv)).toBe('authenticated');
    expect(await status(managed)).toBe('unauthenticated');
    mkdirSync(join(home, '.kimi-code', 'credentials'), { recursive: true });
    writeFileSync(join(home, '.kimi-code', 'credentials', 'kimi-code.json'), '{}');
    expect(await status(managed)).toBe('authenticated');
    env = { HOME: home };
    expect(await status(managed)).toBe('authenticated');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  for (const run of kimi.runs)
    expect(run).toEqual({
      args: ['provider', 'list', '--json'],
      env: expect.objectContaining({ KIMI_CODE_NO_AUTO_UPDATE: '1' }),
    });
  expect(servers).toHaveLength(0);
});

it('reports what went wrong when Kimi cannot list its providers', async () => {
  const check = () => checkAcpSignIn(kimiCodeAcp, { binaryPath: 'kimi', cwd: '/work', env: {} });
  kimi.answer = () => {
    throw Object.assign(new Error('Command failed: kimi provider list --json'), {
      stderr: "EEXIST: file already exists, mkdir '/home/a/.kimi-code'\n",
    });
  };
  expect(await check()).toMatchObject({
    status: 'unknown',
    message: "kimi provider list failed: EEXIST: file already exists, mkdir '/home/a/.kimi-code'",
  });
  kimi.answer = () => ({ stdout: 'Usage: kimi [options] [command]', stderr: '' });
  expect((await check()).status).toBe('unknown');
  kimi.answer = () => ({ stdout: '{"providers":{}}', stderr: '' });
  expect(await check()).toMatchObject({
    status: 'unknown',
    message: 'kimi provider list printed no providers this check can read.',
  });
});

/** The form `kimi acp` 2.5.0 sent for two questions, one of several choices. */
const form = {
  sessionId: 'native',
  toolCallId: 't1:ask',
  mode: 'form',
  message: 'Which color?\nWhich sizes?',
  requestedSchema: {
    type: 'object',
    properties: {
      q0: {
        type: 'string',
        title: 'Which color?',
        oneOf: ['red', 'green', 'blue'].map((color) => ({ const: color, title: color })),
      },
      q1: {
        type: 'array',
        title: 'Which sizes?',
        minItems: 1,
        items: {
          anyOf: ['small', 'medium', 'large'].map((size) => ({ const: size, title: size })),
        },
      },
    },
    required: ['q0', 'q1'],
  },
};

it("asks all of the questions in Kimi's form at once, in full access too", async () => {
  const { adapter, events, server } = await setup('full-access');
  server.send({ id: 69, method: 'elicitation/create', params: form });
  await flush();
  const request = events.find((e) => e.type === 'user-input.requested');
  if (!request || request.type !== 'user-input.requested') throw new Error('missing question');
  expect(request.questions).toEqual([
    {
      id: 'q0',
      question: 'Which color?',
      options: ['red', 'green', 'blue'].map((color) => ({ value: color, label: color })),
      multiSelect: false,
      allowCustomAnswer: false,
    },
    {
      id: 'q1',
      question: 'Which sizes?',
      options: ['small', 'medium', 'large'].map((size) => ({ value: size, label: size })),
      multiSelect: true,
      allowCustomAnswer: false,
    },
  ]);
  await adapter.respondToUserInput('s', request.requestId, {
    q0: 'green',
    q1: ['small', 'large'],
  });
  await flush();
  expect(server.received.find((m) => m.id === 69)?.result).toEqual({
    action: 'accept',
    content: { q0: 'green', q1: ['small', 'large'] },
  });
});

it('asks each question of a form by its text, with the header the model gave it beside it', async () => {
  const titled = (titles: string[], message = form.message) => ({
    ...form,
    message,
    requestedSchema: {
      properties: {
        q0: { ...form.requestedSchema.properties.q0, title: titles[0] },
        q1: { ...form.requestedSchema.properties.q1, title: titles[1] },
      },
    },
  });
  const asked = (request: AcpElicitationRequest) =>
    kimiCodeQuestions(request).map(({ question, header }) => ({ question, header }));
  const { adapter, events, server } = await setup();
  server.send({ id: 72, method: 'elicitation/create', params: titled(['Color', '']) });
  await flush();
  const request = events.find((e) => e.type === 'user-input.requested');
  if (!request || request.type !== 'user-input.requested') throw new Error('missing question');
  expect(request.questions.map(({ question, header }) => ({ question, header }))).toEqual([
    { question: 'Which color?', header: 'Color' },
    { question: 'Which sizes?', header: undefined },
  ]);
  await adapter.respondToUserInput('s', request.requestId, { q0: 'red', q1: ['small'] });
  await flush();
  expect(server.received.find((m) => m.id === 72)?.result).toEqual({
    action: 'accept',
    content: { q0: 'red', q1: ['small'] },
  });
  // A question that breaks lines itself leaves only the headers to go by.
  expect(asked(titled(['Color', 'Sizes'], 'Which\ncolor?\nWhich sizes?'))).toEqual([
    { question: 'Color', header: undefined },
    { question: 'Sizes', header: undefined },
  ]);
  expect(kimiCodeQuestions({ ...form, mode: 'url' })).toEqual([]);
});

it('asks a question Kimi sends as a permission request, in full access too', async () => {
  const { adapter, events, server, askPermission } = await setup('full-access');
  askPermission(
    70,
    {
      toolCallId: 't1:ask',
      title: 'AskUserQuestion',
      content: [{ type: 'content', content: { type: 'text', text: 'Which color?' } }],
    },
    [
      { optionId: 'q0_opt_0', name: 'red', kind: 'allow_once' },
      { optionId: 'q0_opt_1', name: 'green', kind: 'allow_once' },
      { optionId: 'q0_skip', name: 'Skip', kind: 'reject_once' },
    ]
  );
  await flush();
  const request = events.find((e) => e.type === 'user-input.requested');
  if (!request || request.type !== 'user-input.requested') throw new Error('missing question');
  expect(request.questions).toMatchObject([
    {
      question: 'Which color?',
      options: [
        { value: 'q0_opt_0', label: 'red' },
        { value: 'q0_opt_1', label: 'green' },
        { value: 'q0_skip', label: 'Skip' },
      ],
    },
  ]);
  await adapter.respondToUserInput('s', request.requestId, { 't1:ask': 'q0_opt_1' });
  await flush();
  expect(server.received.find((m) => m.id === 70)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'q0_opt_1' },
  });
  expect(events.some((e) => e.type === 'request.opened')).toBe(false);
});

it("asks a person for Kimi's approvals, showing what it asks to run", async () => {
  const { adapter, events, server, toolCall, askPermission } = await setup();
  toolCall('t1:bash', 'Running: echo hi', 'execute');
  askPermission(71, {
    toolCallId: 't1:bash',
    title: 'Bash',
    content: [
      {
        type: 'content',
        content: { type: 'text', text: 'Requesting approval to Running: echo hi' },
      },
    ],
  });
  await flush();
  const request = events.find((e) => e.type === 'request.opened');
  if (!request || request.type !== 'request.opened') throw new Error('missing approval');
  expect(request).toMatchObject({
    requestType: 'command_execution_approval',
    title: 'Bash',
    detail: 'Requesting approval to Running: echo hi',
  });
  expect(request.options.map((o) => o.label)).toEqual([
    'Approve once',
    'Approve for this session',
    'Reject',
    'Cancel',
  ]);
  await adapter.respondToRequest('s', request.requestId, 'decline');
  await flush();
  expect(server.received.find((m) => m.id === 71)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'reject' },
  });
});

it("allows a registered server's MCP tools once without asking, and asks about another's", async () => {
  const { events, server, toolCall, askPermission } = await setup('approval-required', httpSwitch);
  toolCall('t1:rooms', 'mcp__switch__list_rooms');
  askPermission(72, { toolCallId: 't1:rooms', title: 'mcp__switch__list_rooms' });
  await flush();
  expect(events.find((e) => e.type === 'item.started')).toMatchObject({
    item: { id: 't1:rooms', type: 'mcp_tool_call' },
  });
  expect(server.received.find((m) => m.id === 72)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'approve_once' },
  });
  expect(events.some((e) => e.type === 'request.opened')).toBe(false);
  askPermission(73, { toolCallId: 't1:other', title: 'mcp__other__list_rooms' });
  await flush();
  expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(1);
});

it('types calls to the Agent and AgentSwarm tools as subagents', async () => {
  const { events, toolCall } = await setup();
  const titles = {
    lazy: 'Agent',
    lazySwarm: 'AgentSwarm',
    explore: 'Launching explore agent: Read the README',
    background: 'Launching background coder agent: Fix the build',
    swarm: 'Launching agent swarm: Review the change',
    shell: 'Running: ls',
  };
  for (const [id, title] of Object.entries(titles))
    toolCall(id, title, id === 'shell' ? 'execute' : 'other');
  await flush();
  const types = Object.fromEntries(
    events.flatMap((e) => (e.type === 'item.started' ? [[e.item.id, e.item.type]] : []))
  );
  expect(types).toEqual({
    lazy: 'subagent',
    lazySwarm: 'subagent',
    explore: 'subagent',
    background: 'subagent',
    swarm: 'subagent',
    shell: 'command_execution',
  });
});

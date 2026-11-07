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
/** `session/new` as vibe-acp 3.1.0 answers it, trimmed to what Switch reads. */
const vibeSession = {
  sessionId: 'native',
  modes: {
    currentModeId: 'accept-edits',
    availableModes: [
      { id: 'ask', name: 'Ask' },
      { id: 'accept-edits', name: 'Accept Edits' },
      { id: 'auto-approve', name: 'Auto Approve' },
    ],
  },
  configOptions: [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'mistral-medium-3.5',
      options: [
        { value: 'mistral-medium-3.5', name: 'Mistral Medium 3.5' },
        { value: 'devstral-small', name: 'Devstral Small' },
      ],
    },
  ],
};
vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[]) => {
    spawned.push({ command, args });
    const server = new FakeAppServer();
    // vibe-acp 3.1.0 offers its browser sign-in and declares no MCP transports.
    server.replyAlways('initialize', () => ({
      agentCapabilities: { loadSession: true },
      authMethods: [{ id: 'browser-auth', name: 'Sign in through Mistral AI Studio' }],
    }));
    server.replyAlways('session/new', () => vibeSession);
    server.replyAlways('session/load', () => ({ modes: vibeSession.modes }));
    server.replyAlways('session/set_mode', () => ({}));
    server.replyAlways('session/set_config_option', () => ({}));
    servers.push(server);
    return server;
  },
}));
const { mistralVibeAcp, vibeQuestions, vibeSessionMode, createMistralVibeAdapter } =
  await import('./mistral-vibe-acp');

beforeEach(() => {
  servers.length = 0;
  spawned.length = 0;
});

async function setup(input: { runtimeMode?: RuntimeMode; resume?: string; model?: string } = {}) {
  const adapter = createMistralVibeAdapter();
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

it('maps each runtime mode onto the Vibe mode with that permission level', () => {
  const modes = vibeSession.modes;
  expect(vibeSessionMode('approval-required', modes)).toBe('ask');
  expect(vibeSessionMode('auto-accept-edits', modes)).toBe('accept-edits');
  expect(vibeSessionMode('full-access', modes)).toBe('auto-approve');
  // No classifier advertised: edits run, commands still ask.
  expect(vibeSessionMode('auto', modes)).toBe('accept-edits');
  expect(
    vibeSessionMode('auto', {
      ...modes,
      availableModes: [...modes.availableModes, { id: 'smart-approve', name: 'Smart Approve' }],
    })
  ).toBe('smart-approve');
});

it('starts vibe-acp with no sign-in call, out of its accept-edits default, with the HTTP MCP server', async () => {
  const { server, session } = await setup();
  expect(spawned.at(-1)).toEqual({ command: 'vibe-acp', args: [] });
  expect(session.nativeSessionId).toBe('native');
  expect(server.received.some((m) => m.method === 'authenticate')).toBe(false);
  expect(server.received.find((m) => m.method === 'initialize')?.params).toMatchObject({
    clientCapabilities: { elicitation: { form: {} } },
  });
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
  expect(server.received.find((m) => m.method === 'session/set_mode')?.params).toEqual({
    sessionId: 'native',
    modeId: 'ask',
  });
});

it('resumes the exact native session through session/load', async () => {
  const { server, session } = await setup({ resume: 'saved', runtimeMode: 'full-access' });
  expect(session.nativeSessionId).toBe('saved');
  expect(server.received.find((m) => m.method === 'session/load')?.params).toMatchObject({
    sessionId: 'saved',
    cwd: '/work',
  });
  expect(server.received.find((m) => m.method === 'session/set_mode')?.params).toEqual({
    sessionId: 'saved',
    modeId: 'auto-approve',
  });
});

it('lists the models of its model option and selects the chosen one', async () => {
  const { adapter, server } = await setup({ model: 'devstral-small' });
  expect((await adapter.listModels('s')).map((model) => model.id)).toEqual([
    'mistral-medium-3.5',
    'devstral-small',
  ]);
  expect(server.received.find((m) => m.method === 'session/set_config_option')?.params).toEqual({
    sessionId: 'native',
    configId: 'model',
    value: 'devstral-small',
  });
});

it('answers Vibe permission requests with its once and session options, never its permanent one', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  // vibe-acp 3.1.0's options for a tool with no path scopes.
  const options = [
    { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
    {
      optionId: 'allow_always',
      name: 'Allow for remainder of this session',
      kind: 'allow_always',
    },
    { optionId: 'allow_always_permanent', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
  ];
  for (const id of [70, 71, 72])
    server.send({
      id,
      method: 'session/request_permission',
      params: { sessionId: 'native', toolCall: { toolCallId: `call-${id}` }, options },
    });
  await flush();
  const opened = events.filter((e) => e.type === 'request.opened');
  expect(opened).toHaveLength(3);
  for (const [event, decision] of [
    [opened[0], 'accept'],
    [opened[1], 'acceptForSession'],
    [opened[2], 'decline'],
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
  expect([70, 71, 72].map((id) => server.received.find((m) => m.id === id)?.result)).toEqual([
    { outcome: { outcome: 'selected', optionId: 'allow_once' } },
    { outcome: { outcome: 'selected', optionId: 'allow_always' } },
    { outcome: { outcome: 'selected', optionId: 'reject_once' } },
  ]);
});

it('runs the session’s own MCP tools without asking, and asks for any other tool', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  // vibe-acp 3.1.0's announcement of a call to the `switch` server's tool.
  for (const [toolCallId, toolName] of [
    ['mcp-call', 'mcp_switch.list_rooms'],
    ['other-call', 'mcp_elsewhere.list_rooms'],
  ])
    server.notify('session/update', {
      sessionId: 'native',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId,
        title: toolName,
        kind: 'other',
        status: 'in_progress',
        rawInput: {},
        _meta: { tool_name: toolName, effect_kind: 'tool' },
      },
    });
  const options = [
    { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
  ];
  for (const [id, toolCallId] of [
    [80, 'mcp-call'],
    [81, 'other-call'],
  ] as const)
    server.send({
      id,
      method: 'session/request_permission',
      params: { sessionId: 'native', toolCall: { toolCallId }, options },
    });
  await flush();
  expect(server.received.find((m) => m.id === 80)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'allow_once' },
  });
  expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(1);
  expect(mistralVibeAcp.mcpServerOf?.({ toolCallId: 'x', _meta: { tool_name: 'bash' } })).toBe(
    undefined
  );
});

it('shows a spawned Vibe agent as a subagent', () => {
  // vibe-acp 3.1.0's announcement of `agents.spawn`, trimmed.
  const spawn = {
    toolCallId: 'spawn',
    title: 'Starting readme_reader',
    kind: 'think',
    _meta: { tool_name: 'agents.spawn', effect_kind: 'subagent', agent: 'generic' },
  };
  expect(mistralVibeAcp.itemType?.(spawn)).toBe('subagent');
  expect(
    mistralVibeAcp.itemType?.({ toolCallId: 'read', _meta: { effect_kind: 'file_read' } })
  ).toBe(undefined);
});

/** `elicitation/create` as vibe-acp 3.1.0 sends it for `ask_user_question`. */
const vibeQuestion = {
  message: 'User input required',
  mode: 'form',
  sessionId: 'native',
  requestedSchema: {
    type: 'object',
    required: ['q0', 'q1'],
    properties: {
      q0: {
        type: 'string',
        title: 'Color',
        description: 'Which color?',
        oneOf: [
          { const: 'red', title: 'red' },
          { const: 'green', title: 'green' },
        ],
      },
      q1: {
        type: 'array',
        description: 'Which sizes?',
        items: { anyOf: [{ const: 'S' }, { const: 'M' }] },
      },
    },
  },
};

it('asks Vibe questions with the question text, its header and its options', () => {
  expect(vibeQuestions(vibeQuestion)).toEqual([
    {
      id: 'q0',
      header: 'Color',
      question: 'Which color?',
      options: [
        { value: 'red', label: 'red' },
        { value: 'green', label: 'green' },
      ],
      multiSelect: false,
      allowCustomAnswer: true,
    },
    {
      id: 'q1',
      question: 'Which sizes?',
      options: [
        { value: 'S', label: 'S' },
        { value: 'M', label: 'M' },
      ],
      multiSelect: true,
      allowCustomAnswer: true,
    },
  ]);
  expect(vibeQuestions({ ...vibeQuestion, mode: 'url' })).toEqual([]);
});

it('answers a Vibe question in the room with the labels Vibe offered, or the typed text', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'question' });
  server.send({ id: 80, method: 'elicitation/create', params: vibeQuestion });
  await flush();
  const event = events.find((e) => e.type === 'user-input.requested');
  if (!event || event.type !== 'user-input.requested') throw new Error('Missing question');
  await adapter.respondToUserInput('s', event.requestId, { q0: 'teal', q1: ['S', 'M'] });
  await flush();
  expect(server.received.find((m) => m.id === 80)?.result).toEqual({
    action: 'accept',
    content: { q0: 'teal', q1: ['S', 'M'] },
  });
});

it('checks the sign-in with Vibe’s own auth status, never signing it in', async () => {
  const requests: string[] = [];
  const check = (authenticated: boolean) =>
    mistralVibeAcp.checkSignIn!({
      binaryPath: 'vibe-acp',
      cwd: '/work',
      env: {},
      handshake: async () => ({}),
      request: async <T>(method: string) => {
        requests.push(method);
        return { authenticated, authState: authenticated ? 'process_env' : 'signed_out' } as T;
      },
    });
  await expect(check(true)).resolves.toMatchObject({ status: 'authenticated' });
  await expect(check(false)).resolves.toMatchObject({
    status: 'unauthenticated',
    message: 'Sign in on the execution machine with vibe --setup.',
  });
  expect(requests).toEqual(['_auth/status', '_auth/status']);
});

import type * as fs from 'node:fs/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { elicitationAnswer, elicitationQuestions } from '../acp/elicitation';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  mkdir: async () => undefined,
  writeFile: async () => undefined,
  realpath: async (path: string) => path,
}));
const servers: FakeAppServer[] = [];
/** What the fake agent declares in `initialize`. */
const acp = {
  http: true,
  signedOut: false,
  listSignedOut: false,
  newError: 'Authentication required',
};
const spawned: Array<{ command: string; args: string[] }> = [];
vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[]) => {
    spawned.push({ command, args });
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      agentCapabilities: {
        sessionCapabilities: { resume: {} },
        ...(acp.http ? { mcpCapabilities: { http: true } } : {}),
      },
    }));
    server.replyAlways('authenticate', () => ({}));
    server.on('message', (message: { id?: number; method?: string }) => {
      if (message.method !== 'session/list' || message.id === undefined) return;
      server.send(
        acp.listSignedOut
          ? { id: message.id, error: { code: -32000, message: 'Authentication required' } }
          : { id: message.id, result: { sessions: [] } }
      );
    });
    server.on('message', (message: { id?: number; method?: string }) => {
      if (message.method !== 'session/new' || message.id === undefined) return;
      server.send(
        acp.signedOut
          ? { id: message.id, error: { code: -32000, message: acp.newError } }
          : {
              id: message.id,
              result: {
                sessionId: 'native',
                configOptions: [
                  { id: 'model', type: 'select', options: [{ value: 'model-a', name: 'Model A' }] },
                ],
              },
            }
      );
    });
    server.replyAlways('session/resume', () => ({}));
    server.replyAlways('session/set_mode', () => ({}));
    server.replyAlways('session/set_config_option', () => ({}));
    servers.push(server);
    return server;
  },
}));
const { antigravityAcp, createAntigravityAdapter } = await import('./antigravity-adapter');
beforeEach(() => {
  servers.length = 0;
  spawned.length = 0;
  acp.signedOut = false;
  acp.listSignedOut = false;
  acp.newError = 'Authentication required';
  acp.http = true;
});
async function setup(
  resume = false,
  switchRegistered = true,
  { binaryPath, env = {} }: { binaryPath?: string; env?: Record<string, string> } = {}
) {
  const adapter = createAntigravityAdapter(binaryPath ? { binaryPath } : {});
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  const session = await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: 'approval-required',
    env,
    mcpServers: switchRegistered
      ? {
          switch: {
            transport: 'stdio',
            command: 'node',
            args: ['server.js'],
            env: { MODE: 'test' },
          },
        }
      : {},
    connectorMcpServers: [],
    ...(resume ? { resume: { nativeSessionId: 'acp:native' } } : {}),
  });
  const server = servers.at(-1)!;
  return { adapter, events, server, session };
}
afterEach(() => {
  for (const server of servers) server.kill();
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

it('registers session MCP servers and resumes the exact native session', async () => {
  const { server, session } = await setup(true);
  expect(session.nativeSessionId).toBe('acp:native');
  expect(server.received.find((m) => m.method === 'session/resume')?.params).toMatchObject({
    sessionId: 'native',
    mcpServers: [
      {
        name: 'switch',
        command: 'node',
        args: ['server.js'],
        env: [{ name: 'MODE', value: 'test' }],
      },
    ],
  });
});

it('preserves tool metadata through sparse updates and ignores replay and other sessions', async () => {
  const { adapter, events, server } = await setup();
  const update = (sessionId: string, update: Record<string, unknown>) =>
    server.notify('session/update', { sessionId, update });
  update('native', {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'replay' },
  });
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'hello' });
  update('other', {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'wrong' },
  });
  update('native', {
    sessionUpdate: 'tool_call',
    toolCallId: 'tool',
    kind: 'execute',
    title: 'Run build',
    status: 'in_progress',
  });
  update('native', {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tool',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'OK' } }],
  });
  expect(events.filter((e) => e.type === 'content.delta')).toEqual([]);
  expect(events.find((e) => e.type === 'item.completed')).toMatchObject({
    item: {
      id: 'tool',
      type: 'command_execution',
      title: 'Run build',
      status: 'completed',
      text: 'OK',
    },
  });
});

it('answers the offered permission ID and excludes persistent permissions', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'write' });
  server.send({
    id: 99,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: { kind: 'edit', title: 'Edit marker', toolCallId: 'edit' },
      options: [
        { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'save', name: 'Allow for future sessions', kind: 'allow_always' },
        { optionId: 'session', name: 'Allow this session', kind: 'allow_always' },
      ],
    },
  });
  const request = events.find((e) => e.type === 'request.opened');
  if (!request || request.type !== 'request.opened') throw new Error('missing approval');
  expect(request.options.map((o) => o.label)).not.toContain('Allow for future sessions');
  await adapter.respondToRequest('s', request.requestId, 'acceptForSession');
  await flush();
  expect(server.received.find((m) => m.id === 99)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'session' },
  });
});

it('interrupts the native turn, cancels pending approvals and waits for cancellation before draining', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 'one', text: 'first' });
  await adapter.sendTurn({ sessionId: 's', turnId: 'two', text: 'second' });
  const prompt = await server.waitFor('session/prompt');
  server.send({
    id: 98,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: { title: 'Run', kind: 'execute', toolCallId: 'tool' },
      options: [],
    },
  });
  await adapter.interruptTurn('s');
  await flush();
  expect(server.received.find((m) => m.method === 'session/cancel')?.params).toEqual({
    sessionId: 'native',
  });
  expect(server.received.find((m) => m.id === 98)?.result).toEqual({
    outcome: { outcome: 'cancelled' },
  });
  expect(server.received.filter((m) => m.method === 'session/prompt')).toHaveLength(1);
  server.send({ id: prompt.id, result: { stopReason: 'cancelled' } });
  await flush();
  expect(events.find((e) => e.type === 'turn.completed')).toMatchObject({
    turnId: 'one',
    outcome: 'interrupted',
  });
  expect(server.received.filter((m) => m.method === 'session/prompt')).toHaveLength(2);
});

it('settles active and queued turns on process exit without starting another prompt', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 'one', text: 'first' });
  await adapter.sendTurn({ sessionId: 's', turnId: 'two', text: 'second' });
  server.kill('SIGKILL');
  await flush();
  expect(adapter.hasSession('s')).toBe(false);
  expect(events.filter((e) => e.type === 'turn.completed').map((e) => e.outcome)).toEqual([
    'error',
    'error',
  ]);
  expect(server.received.filter((m) => m.method === 'session/prompt')).toHaveLength(1);
});

it('finishes streamed assistant messages so the transcript stops showing writing', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'hello' });
  const prompt = await server.waitFor('session/prompt');
  server.notify('session/update', {
    sessionId: 'native',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } },
  });
  server.send({ id: prompt.id, result: { stopReason: 'end_turn' } });
  await flush();
  const delta = events.find((e) => e.type === 'content.delta');
  if (!delta || delta.type !== 'content.delta') throw new Error('missing delta');
  const started = events.findIndex(
    (event) => event.type === 'item.started' && event.item.id === delta.itemId
  );
  expect(started).toBeGreaterThanOrEqual(0);
  expect(started).toBeLessThan(events.indexOf(delta));
  expect(events.find((e) => e.type === 'item.completed')).toMatchObject({
    item: { id: delta.itemId, type: 'assistant_message', status: 'completed', text: 'Hello' },
  });
});

it('serializes turns submitted synchronously by completion listeners', async () => {
  const { adapter, server, events } = await setup();
  adapter.subscribe((e) => {
    if (e.type === 'turn.completed' && e.turnId === 'one') {
      void adapter.sendTurn({ sessionId: 's', turnId: 'two', text: 'second' });
      void adapter.sendTurn({ sessionId: 's', turnId: 'three', text: 'third' });
    }
  });
  await adapter.sendTurn({ sessionId: 's', turnId: 'one', text: 'first' });
  const prompt = server.received.find((m) => m.method === 'session/prompt')!;
  server.send({ id: prompt.id, result: { stopReason: 'end_turn' } });
  await flush();
  expect(server.received.filter((m) => m.method === 'session/prompt')).toHaveLength(2);
  expect(events.at(-1)).toMatchObject({ type: 'session.state.changed', status: 'running' });
});

it('runs Google’s agy as `agy acp`, signed in by agy itself', async () => {
  const { server } = await setup();
  expect(spawned).toEqual([{ command: 'agy', args: ['acp'] }]);
  expect(server.received.slice(0, 2).map((m) => m.method)).toEqual(['initialize', 'session/new']);
});
it('signs agy in with the Gemini API key only when agy could not sign itself in', async () => {
  acp.listSignedOut = true;
  const { server } = await setup(false, true, { env: { GEMINI_API_KEY: 'placeholder' } });
  expect(server.received.slice(0, 4).map((m) => m.method)).toEqual([
    'initialize',
    'session/list',
    'authenticate',
    'session/new',
  ]);
  expect(server.received[2]?.params).toEqual({ methodId: 'gemini-api-key' });
});
it('leaves a signed-in agy on its own sign-in when GEMINI_API_KEY is also set', async () => {
  // agy keeps the method it is sent: authenticating would replace the
  // user's Google sign-in with the key for every later run.
  const { server } = await setup(false, true, { env: { GEMINI_API_KEY: 'placeholder' } });
  expect(server.received.slice(0, 3).map((m) => m.method)).toEqual([
    'initialize',
    'session/list',
    'session/new',
  ]);
  expect(server.received.some((m) => m.method === 'authenticate')).toBe(false);
});
it('authenticates a legacy antigravity-acp install once before creating the session', async () => {
  const { server } = await setup(false, true, { binaryPath: '/home/u/.local/bin/antigravity-acp' });
  expect(spawned).toEqual([{ command: '/home/u/.local/bin/antigravity-acp', args: [] }]);
  expect(server.received.slice(0, 3).map((m) => m.method)).toEqual([
    'initialize',
    'authenticate',
    'session/new',
  ]);
  expect(server.received[1]?.params).toEqual({ methodId: 'oauth-personal' });
});
it('picks the session mode among the modes agy advertises', () => {
  const agy = {
    availableModes: [{ id: 'default' }, { id: 'accept-edits' }, { id: 'plan' }],
  };
  expect(antigravityAcp.sessionMode?.('approval-required', agy)).toBe('default');
  expect(antigravityAcp.sessionMode?.('auto-accept-edits', agy)).toBe('accept-edits');
  expect(antigravityAcp.sessionMode?.('auto', agy)).toBe('accept-edits');
  // Full access is the adapter approving every request, in agy's default mode.
  expect(antigravityAcp.sessionMode?.('full-access', agy)).toBe('default');
});
it('keeps the legacy runtime’s auto-edit and yolo modes', () => {
  const legacy = { availableModes: [{ id: 'default' }, { id: 'auto_edit' }, { id: 'yolo' }] };
  expect(antigravityAcp.sessionMode?.('approval-required', legacy)).toBe('default');
  expect(antigravityAcp.sessionMode?.('auto-accept-edits', legacy)).toBe('auto_edit');
  expect(antigravityAcp.sessionMode?.('auto', legacy)).toBe('auto_edit');
  expect(antigravityAcp.sessionMode?.('full-access', legacy)).toBe('yolo');
});
it('sends no mode when the session advertised none, whichever runtime it is', () => {
  expect(antigravityAcp.sessionMode?.('auto', undefined)).toBeUndefined();
  expect(antigravityAcp.sessionMode?.('full-access', { availableModes: [] })).toBeUndefined();
});
it('tells each runtime’s own sign-in command', () => {
  expect(antigravityAcp.loginCommandFor?.('/home/u/.local/bin/agy')).toBe('agy acp --login');
  expect(antigravityAcp.loginCommandFor?.('C:\\Users\\u\\AppData\\Local\\agy\\bin\\agy.exe')).toBe(
    'agy acp --login'
  );
  expect(antigravityAcp.loginCommandFor?.('/home/u/.local/bin/antigravity-acp')).toBe(
    'antigravity-acp --login'
  );
});
it('tells a signed-out agy session how to sign in', async () => {
  acp.signedOut = true;
  await expect(
    createAntigravityAdapter().startSession({
      sessionId: 'signed-out',
      cwd: '/work',
      runtimeMode: 'approval-required',
      env: {},
      mcpServers: {},
      connectorMcpServers: [],
    })
  ).rejects.toThrow('Sign in on the execution machine with agy acp --login.');
});
it('does not send someone to sign in for an MCP server’s or tool’s authorization failing', async () => {
  acp.signedOut = true;
  acp.newError = 'authorization denied for MCP server github';
  const start = createAntigravityAdapter().startSession({
    sessionId: 'mcp-auth',
    cwd: '/work',
    runtimeMode: 'approval-required',
    env: {},
    mcpServers: {},
    connectorMcpServers: [],
  });
  await expect(start).rejects.toThrow('authorization denied for MCP server github');
  await expect(start).rejects.not.toThrow('Sign in on the execution machine');
});
it('points a signed-out legacy session at the legacy sign-in command', async () => {
  acp.signedOut = true;
  await expect(
    createAntigravityAdapter({ binaryPath: '/home/u/.local/bin/antigravity-acp' }).startSession({
      sessionId: 'legacy-signed-out',
      cwd: '/work',
      runtimeMode: 'approval-required',
      env: {},
      mcpServers: {},
      connectorMcpServers: [],
    })
  ).rejects.toThrow('Sign in on the execution machine with antigravity-acp --login.');
});
it('refuses legacy CLI conversation IDs before starting a process', async () => {
  await expect(
    createAntigravityAdapter().startSession({
      sessionId: 'legacy',
      cwd: '/work',
      runtimeMode: 'approval-required',
      env: {},
      mcpServers: {},
      connectorMcpServers: [],
      resume: { nativeSessionId: 'old-cli' },
    })
  ).rejects.toThrow('previous Antigravity CLI');
  expect(servers).toHaveLength(0);
});
it('gets models from ACP initialization and uses native config selection', async () => {
  const { adapter, server } = await setup();
  expect(await adapter.listModels('s')).toMatchObject([{ id: 'model-a' }]);
  await adapter.setModel('s', { id: 'model-a' });
  expect(server.received.find((m) => m.method === 'session/set_config_option')?.params).toEqual({
    sessionId: 'native',
    configId: 'model',
    value: 'model-a',
  });
});
it('answers native questions with the offered option ID', async () => {
  const { adapter, server, events } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'question' });
  server.send({
    id: 99,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: { toolCallId: 'interaction_1', title: 'Choose' },
      options: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }],
    },
  });
  const event = events.find((e) => e.type === 'user-input.requested');
  if (!event || event.type !== 'user-input.requested') throw new Error('Missing question');
  await expect(
    adapter.respondToUserInput('s', event.requestId, { interaction_1: 'invented' })
  ).rejects.toThrow('offered');
  await adapter.respondToUserInput('s', event.requestId, { interaction_1: 'yes' });
  await flush();
  expect(server.received.find((m) => m.id === 99)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'yes' },
  });
});

// What agy 1.5 sends for its ask_question tool, recorded from `agy acp`.
const agyQuestion = {
  sessionId: 'native',
  toolCallId: 'call_1',
  mode: 'form',
  message: 'The agent has a question.',
  requestedSchema: {
    type: 'object',
    properties: {
      q1: {
        type: 'string',
        title: 'Which color?',
        oneOf: [
          { const: '1', title: 'red' },
          { const: '2', title: 'green' },
          { const: '3', title: 'blue' },
        ],
      },
      q1_other: {
        type: 'string',
        title: 'Other',
        description: 'Optional free-form answer to: Which color?',
      },
    },
  },
};
it('announces form elicitation and answers agy questions through it', async () => {
  const { adapter, server, events } = await setup();
  expect(server.received[0]?.params).toMatchObject({
    clientCapabilities: { elicitation: { form: {} } },
  });
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'question' });
  server.send({ id: 98, method: 'elicitation/create', params: agyQuestion });
  await flush();
  const event = events.find((e) => e.type === 'user-input.requested');
  if (!event || event.type !== 'user-input.requested') throw new Error('Missing question');
  expect(event.questions).toEqual([
    {
      id: 'q1',
      question: 'Which color?',
      options: [
        { value: '1', label: 'red' },
        { value: '2', label: 'green' },
        { value: '3', label: 'blue' },
      ],
      multiSelect: false,
      allowCustomAnswer: true,
    },
  ]);
  await adapter.respondToUserInput('s', event.requestId, { q1: '2' });
  await flush();
  expect(server.received.find((m) => m.id === 98)?.result).toEqual({
    action: 'accept',
    content: { q1: '2' },
  });
});
it('sends a typed answer to agy as the question’s Other field', async () => {
  // Measured against agy 1.5.1: it takes `q1_other` with `q1` left out.
  const { adapter, server, events } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'question' });
  server.send({ id: 96, method: 'elicitation/create', params: agyQuestion });
  await flush();
  const event = events.find((e) => e.type === 'user-input.requested');
  if (!event || event.type !== 'user-input.requested') throw new Error('Missing question');
  await adapter.respondToUserInput('s', event.requestId, { q1: 'purple' });
  await flush();
  expect(server.received.find((m) => m.id === 96)?.result).toEqual({
    action: 'accept',
    content: { q1_other: 'purple' },
  });
});
it('refuses typed text for a question that offers none', async () => {
  const { adapter, server, events } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'question' });
  const { q1 } = agyQuestion.requestedSchema.properties;
  server.send({
    id: 95,
    method: 'elicitation/create',
    params: { ...agyQuestion, requestedSchema: { type: 'object', properties: { q1 } } },
  });
  await flush();
  const event = events.find((e) => e.type === 'user-input.requested');
  if (!event || event.type !== 'user-input.requested') throw new Error('Missing question');
  expect(event.questions[0]?.allowCustomAnswer).toBe(false);
  await expect(adapter.respondToUserInput('s', event.requestId, { q1: 'purple' })).rejects.toThrow(
    'choose one of the offered answers'
  );
});
it('asks a form’s free-text fields too, rather than declining the form', () => {
  const request = {
    message: 'Details?',
    requestedSchema: {
      properties: {
        name: { type: 'string', title: 'Your name' },
        count: { type: 'integer', title: 'How many?' },
      },
    },
  };
  expect(elicitationQuestions(request)).toEqual([
    {
      id: 'name',
      question: 'Your name',
      options: [],
      multiSelect: false,
      allowCustomAnswer: true,
    },
    {
      id: 'count',
      question: 'How many?',
      options: [],
      multiSelect: false,
      allowCustomAnswer: true,
    },
  ]);
  expect(
    elicitationAnswer(request, [
      { questionId: 'name', values: [], custom: 'Ada' },
      { questionId: 'count', values: [], custom: '3' },
    ])
  ).toEqual({ action: 'accept', content: { name: 'Ada', count: 3 } });
});
it('answers with the values the schema offered, numbers and booleans included', () => {
  const request = {
    requestedSchema: {
      properties: {
        size: { type: 'number', title: 'Size', enum: [1, 2] },
        level: { type: 'integer', oneOf: [{ const: 5, title: 'High' }] },
        ok: { type: 'boolean', title: 'Proceed?' },
      },
    },
  };
  expect(elicitationQuestions(request).map((q) => q.options)).toEqual([
    [
      { value: '1', label: '1' },
      { value: '2', label: '2' },
    ],
    [{ value: '5', label: 'High' }],
    [
      { value: 'true', label: 'Yes' },
      { value: 'false', label: 'No' },
    ],
  ]);
  expect(
    elicitationAnswer(request, [
      { questionId: 'size', values: ['2'] },
      { questionId: 'level', values: ['5'] },
      { questionId: 'ok', values: ['false'] },
    ])
  ).toEqual({ action: 'accept', content: { size: 2, level: 5, ok: false } });
});
it('leaves out a question answered with nothing rather than sending undefined', () => {
  const request = agyQuestion;
  expect(elicitationAnswer(request, [{ questionId: 'q1', values: [] }])).toEqual({
    action: 'accept',
    content: {},
  });
});
it('answers several choices for an array field', () => {
  const questions = elicitationQuestions({
    requestedSchema: {
      properties: {
        q1: { type: 'array', title: 'Which?', items: { anyOf: [{ const: 'a' }, { const: 'b' }] } },
      },
    },
  });
  expect(questions[0]).toMatchObject({
    multiSelect: true,
    options: [{ value: 'a' }, { value: 'b' }],
  });
  expect(
    elicitationAnswer(
      {
        requestedSchema: {
          properties: {
            q1: { type: 'array', items: { anyOf: [{ const: 'a' }, { const: 'b' }] } },
          },
        },
      },
      [{ questionId: 'q1', values: ['a', 'b'] }]
    )
  ).toEqual({
    action: 'accept',
    content: { q1: ['a', 'b'] },
  });
});
it('cancels an elicitation the turn ends before answering', async () => {
  const { adapter, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'question' });
  server.send({ id: 97, method: 'elicitation/create', params: agyQuestion });
  await flush();
  await adapter.interruptTurn('s');
  await flush();
  expect(server.received.find((m) => m.id === 97)?.result).toEqual({ action: 'cancel' });
});

it('auto-approves Switch MCP calls with bypass off using provider metadata', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'connect' });
  const options = [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }];
  server.send({
    id: 90,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: {
        toolCallId: 'call',
        kind: 'other',
        _meta: { is_mcp_tool_call: true, mcp: { server: 'switch', tool: 'connect_to_room' } },
      },
      options,
    },
  });
  await flush();
  expect(server.received.find((m) => m.id === 90)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'once' },
  });
  expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(0);
  for (const [id, toolCall] of [
    [91, { toolCallId: 'unidentified', title: 'switch_connect_to_room', kind: 'execute' }],
    [
      92,
      {
        toolCallId: 'other-server',
        _meta: { is_mcp_tool_call: true, mcp: { server: 'other', tool: 'connect_to_room' } },
      },
    ],
  ] as const) {
    server.send({
      id,
      method: 'session/request_permission',
      params: {
        sessionId: 'native',
        toolCall,
        options,
      },
    });
  }
  expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(2);
});

it('keeps approval for Switch metadata when Switch was not registered by the session', async () => {
  const { adapter, events, server } = await setup(false, false);
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'connect' });
  server.send({
    id: 93,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: {
        toolCallId: 'call',
        _meta: { is_mcp_tool_call: true, mcp: { server: 'switch', tool: 'connect_to_room' } },
      },
      options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }],
    },
  });
  expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(1);
});

const httpSwitch = {
  switch: {
    transport: 'http' as const,
    url: 'http://127.0.0.1:4567/mcp',
    headers: { Authorization: 'Bearer per-session' },
  },
};

it('registers an HTTP MCP server with its headers when the agent declares HTTP', async () => {
  const adapter = createAntigravityAdapter();
  await adapter.startSession({
    sessionId: 'http',
    cwd: '/work',
    runtimeMode: 'approval-required',
    env: {},
    mcpServers: httpSwitch,
    connectorMcpServers: [],
  });
  expect(servers.at(-1)!.received.find((m) => m.method === 'session/new')?.params).toMatchObject({
    mcpServers: [
      {
        name: 'switch',
        type: 'http',
        url: 'http://127.0.0.1:4567/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer per-session' }],
      },
    ],
  });
});

it('refuses to start a session whose HTTP MCP servers the agent cannot reach', async () => {
  acp.http = false;
  const adapter = createAntigravityAdapter();
  await expect(
    adapter.startSession({
      sessionId: 'no-http',
      cwd: '/work',
      runtimeMode: 'approval-required',
      env: {},
      mcpServers: httpSwitch,
      connectorMcpServers: [],
    })
  ).rejects.toThrow('Antigravity does not declare MCP over HTTP');
  expect(servers.at(-1)!.received.some((m) => m.method === 'session/new')).toBe(false);
});

it('auto-approves calls to any MCP server the session registered, not only Switch', async () => {
  const adapter = createAntigravityAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  await adapter.startSession({
    sessionId: 'echo',
    cwd: '/work',
    runtimeMode: 'approval-required',
    env: {},
    mcpServers: { echo: { transport: 'stdio', command: 'node', args: ['echo.js'] } },
    connectorMcpServers: [],
  });
  const server = servers.at(-1)!;
  await adapter.sendTurn({ sessionId: 'echo', turnId: 't', text: 'echo' });
  server.send({
    id: 94,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: {
        toolCallId: 'call',
        _meta: { is_mcp_tool_call: true, mcp: { server: 'echo', tool: 'echo' } },
      },
      options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }],
    },
  });
  await flush();
  expect(server.received.find((m) => m.id === 94)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'once' },
  });
  expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(0);
});

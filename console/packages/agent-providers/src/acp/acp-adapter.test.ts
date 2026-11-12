import type * as fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { beforeEach, expect, it, vi } from 'vitest';
import { ProviderConversationUnavailableError } from '../adapter';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';
import type { AcpProviderHooks } from './hooks';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
  readFile: async (_path: string, encoding?: string) =>
    encoding ? 'file text' : Buffer.from('bytes'),
}));
const servers: FakeAppServer[] = [];
/** What the fake agent answers; each test shapes it before starting a session. */
const agent: {
  capabilities: Record<string, unknown>;
  session: Record<string, unknown>;
} = { capabilities: {}, session: {} };
const spawned: Array<{ command: string; args: string[] }> = [];
vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[]) => {
    spawned.push({ command, args });
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({ agentCapabilities: agent.capabilities }));
    for (const method of ['session/new', 'session/load', 'session/resume'])
      server.replyAlways(method, () => ({ sessionId: 'native', ...agent.session }));
    for (const method of ['session/set_mode', 'session/set_model', 'session/set_config_option'])
      server.replyAlways(method, () => ({}));
    servers.push(server);
    return server;
  },
}));
const { createAcpAdapter } = await import('./acp-adapter');
const { antigravityAcp } = await import('../antigravity/antigravity-adapter');
const { cursorAcp } = await import('../cursor/cursor-adapter');

/** The least a new ACP provider has to say about itself. */
const dummy: AcpProviderHooks = {
  provider: 'dummy',
  label: 'Dummy ACP',
  defaultBinary: 'dummy-acp',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env }) => ({ command: binaryPath, args: ['--acp'], env }),
  loginCommand: 'dummy-acp login',
};

beforeEach(() => {
  servers.length = 0;
  spawned.length = 0;
  agent.capabilities = {};
  agent.session = {};
});

async function start(
  hooks: AcpProviderHooks = dummy,
  input: Partial<Parameters<ReturnType<typeof createAcpAdapter>['startSession']>[0]> = {}
) {
  const adapter = createAcpAdapter(hooks, {});
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  const session = await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: 'approval-required',
    env: {},
    mcpServers: {},
    connectorMcpServers: [],
    ...input,
  });
  return { adapter, events, session, server: servers.at(-1)! };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

it('runs a provider from nothing but its launch hook, with no sign-in or mode calls', async () => {
  const { server, session } = await start();
  expect(spawned).toEqual([{ command: 'dummy-acp', args: ['--acp'] }]);
  expect(session).toEqual({ provider: 'dummy', sessionId: 's', nativeSessionId: 'native' });
  expect(server.received.map((m) => m.method)).toEqual(['initialize', 'session/new']);
});

it('resumes with session/load when the agent advertises it, and session/resume otherwise', async () => {
  agent.capabilities = { loadSession: true, sessionCapabilities: { resume: {} } };
  const loaded = await start(dummy, { resume: { nativeSessionId: 'saved' } });
  expect(loaded.server.received.find((m) => m.method === 'session/load')?.params).toMatchObject({
    sessionId: 'saved',
  });
  agent.capabilities = { sessionCapabilities: { resume: {} } };
  const resumed = await start(dummy, { resume: { nativeSessionId: 'saved' } });
  expect(resumed.server.received.some((m) => m.method === 'session/load')).toBe(false);
  expect(resumed.server.received.find((m) => m.method === 'session/resume')?.params).toMatchObject({
    sessionId: 'saved',
  });
});

it('asks for a fresh conversation when the agent cannot resume', async () => {
  await expect(start(dummy, { resume: { nativeSessionId: 'saved' } })).rejects.toBeInstanceOf(
    ProviderConversationUnavailableError
  );
});

it('selects models through the models list when the agent offers no model config option', async () => {
  agent.session = { models: { availableModels: [{ modelId: 'fast', name: 'Fast' }] } };
  const { adapter, server } = await start();
  expect(await adapter.listModels('s')).toEqual([{ id: 'fast', label: 'Fast', options: {} }]);
  await adapter.setModel('s', { id: 'fast' });
  expect(server.received.find((m) => m.method === 'session/set_model')?.params).toEqual({
    sessionId: 'native',
    modelId: 'fast',
  });
});

it('selects models through the model config option, refusing one it does not offer', async () => {
  agent.session = {
    models: { availableModels: [{ modelId: 'ignored', name: 'Ignored' }] },
    configOptions: [{ id: 'model', type: 'select', options: [{ value: 'deep', name: 'Deep' }] }],
  };
  const { adapter, server } = await start();
  expect(await adapter.listModels('s')).toMatchObject([{ id: 'deep' }]);
  await expect(adapter.setModel('s', { id: 'ignored' })).rejects.toThrow('Unavailable model');
  await adapter.setModel('s', { id: 'deep' });
  expect(server.received.find((m) => m.method === 'session/set_config_option')?.params).toEqual({
    sessionId: 'native',
    configId: 'model',
    value: 'deep',
  });
  expect(server.received.some((m) => m.method === 'session/set_model')).toBe(false);
});

it('sends attachments as the agent advertises it can take them, else as resource links', async () => {
  agent.capabilities = { promptCapabilities: { image: true } };
  const { adapter, server } = await start();
  await adapter.sendTurn({
    sessionId: 's',
    turnId: 't',
    text: 'look',
    attachments: [
      { path: '/work/shot.png', mimeType: 'image/png' },
      { path: '/work/notes.txt', mimeType: 'text/plain' },
      { path: '/work/voice.wav', mimeType: 'audio/wav' },
    ],
  });
  const prompt = (await server.waitFor('session/prompt')).params?.prompt as Array<
    Record<string, unknown>
  >;
  expect(prompt.map((block) => block.type)).toEqual([
    'text',
    'image',
    'resource_link',
    'resource_link',
  ]);
  expect(prompt[2]).toEqual({
    type: 'resource_link',
    uri: pathToFileURL('/work/notes.txt').href,
    name: 'notes.txt',
    mimeType: 'text/plain',
  });
});

it('embeds file contents when the agent takes embedded context', async () => {
  agent.capabilities = { promptCapabilities: { embeddedContext: true } };
  const { adapter, server } = await start();
  await adapter.sendTurn({
    sessionId: 's',
    turnId: 't',
    text: 'read',
    attachments: [{ path: '/work/notes.txt', mimeType: 'text/plain' }],
  });
  const prompt = (await server.waitFor('session/prompt')).params?.prompt as Array<
    Record<string, unknown>
  >;
  expect(prompt[1]).toEqual({
    type: 'resource',
    resource: {
      uri: pathToFileURL('/work/notes.txt').href,
      mimeType: 'text/plain',
      text: 'file text',
    },
  });
});

it('starts a tool call again under the type a later update gives it, and only then', async () => {
  const hooks: AcpProviderHooks = {
    ...dummy,
    itemType: (toolCall) => (toolCall._meta?.kind === 'agent' ? 'subagent' : undefined),
  };
  const { adapter, events, server } = await start(hooks);
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  for (const update of [
    { sessionUpdate: 'tool_call', status: 'pending', title: 'Tool', kind: 'other' },
    {
      sessionUpdate: 'tool_call_update',
      status: 'in_progress',
      title: 'Agent',
      _meta: { kind: 'agent' },
    },
    { sessionUpdate: 'tool_call_update', status: 'in_progress', title: 'Agent: working' },
    { sessionUpdate: 'tool_call_update', status: 'completed' },
  ])
    server.notify('session/update', {
      sessionId: 'native',
      update: { toolCallId: 'call', ...update },
    });
  await flush();
  expect(
    events.flatMap((e) =>
      e.type.startsWith('item.') && 'item' in e && e.item.id === 'call'
        ? [`${e.type}:${e.item.type}`]
        : []
    )
  ).toEqual([
    'item.started:tool_call',
    'item.started:subagent',
    'item.updated:subagent',
    'item.completed:subagent',
  ]);
});

it('auto-approves a tool the hooks place on any session-registered MCP server', async () => {
  const hooks: AcpProviderHooks = {
    ...dummy,
    mcpServerOf: (toolCall) => toolCall._meta?.server as string | undefined,
  };
  const { adapter, events, server } = await start(hooks, {
    mcpServers: { echo: { transport: 'stdio', command: 'node', args: ['echo.js'] } },
    connectorMcpServers: [],
  });
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  const options = [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }];
  for (const [id, server_] of [
    [70, 'echo'],
    [71, 'elsewhere'],
  ] as const)
    server.send({
      id,
      method: 'session/request_permission',
      params: {
        sessionId: 'native',
        toolCall: { toolCallId: `call-${id}`, _meta: { server: server_ } },
        options,
      },
    });
  await flush();
  expect(server.received.find((m) => m.id === 70)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'once' },
  });
  expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(1);
});

it('asks mcpServerOf about a request with its own call, then with the call as it was last placed', async () => {
  const asked: Array<[string | undefined, string[], string | undefined]> = [];
  const hooks: AcpProviderHooks = {
    ...dummy,
    // Copilot CLI's shape: a tool is announced as `<server>-<tool>` and
    // requested as `<tool>`, so a request is placed only when the two agree.
    mcpServerOf: (toolCall, servers, request) => {
      if (request) asked.push([toolCall.title, [...servers], request.title]);
      return [...servers].find(
        (name) =>
          toolCall.title?.startsWith(`${name}-`) &&
          (!request || toolCall.title.slice(name.length + 1) === request.title)
      );
    },
  };
  const stdio = { transport: 'stdio' as const, command: 'node', args: ['server.js'] };
  const { adapter, events, server } = await start(hooks, {
    mcpServers: { switch: stdio, acme: stdio },
    connectorMcpServers: ['acme'],
  });
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  const update = (sessionUpdate: string, toolCallId: string, title?: string) =>
    server.notify('session/update', {
      sessionId: 'native',
      update: {
        sessionUpdate,
        toolCallId,
        kind: 'other',
        status: 'pending',
        ...(title && { title }),
      },
    });
  const ask = (id: number, toolCallId: string, title: string) =>
    server.send({
      id,
      method: 'session/request_permission',
      params: {
        sessionId: 'native',
        toolCall: { toolCallId, title, kind: 'other' },
        options: [{ optionId: 'once', name: 'Allow', kind: 'allow_once' }],
      },
    });
  // Placed on Switch's server by an update, and kept through one naming nothing.
  update('tool_call', 'call-1', 'lights');
  update('tool_call_update', 'call-1', 'switch-lights');
  update('tool_call_update', 'call-1');
  ask(90, 'call-1', 'lights');
  // Announced on the connector, with a tool whose own name starts `switch-`.
  update('tool_call', 'call-2', 'acme-switch-lights');
  ask(91, 'call-2', 'switch-lights');
  await flush();
  expect(server.received.find((m) => m.id === 90)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'once' },
  });
  expect(server.received.some((m) => m.id === 91 && 'result' in m)).toBe(false);
  expect(events.filter((e) => e.type === 'request.opened')).toMatchObject([
    { requestType: 'mcp_tool_approval', connector: 'acme' },
  ]);
  expect(asked).toEqual([
    ['lights', ['switch', 'acme'], 'lights'],
    ['switch-lights', ['switch', 'acme'], 'lights'],
    ['switch-lights', ['switch', 'acme'], 'switch-lights'],
    ['acme-switch-lights', ['switch', 'acme'], 'switch-lights'],
  ]);
});

it.each([
  [
    'Cursor',
    cursorAcp.mcpServerOf,
    (server?: string) => ({ rawInput: server ? { providerIdentifier: server } : {} }),
  ],
  [
    'Antigravity',
    antigravityAcp.mcpServerOf,
    (server?: string) => ({ _meta: server ? { is_mcp_tool_call: true, mcp: { server } } : {} }),
  ],
] as const)(
  "places a %s request by the server only a later update of its call names, after the request's own",
  async (_provider, mcpServerOf, naming) => {
    const stdio = { transport: 'stdio' as const, command: 'node', args: ['server.js'] };
    const { adapter, events, server } = await start(
      { ...dummy, mcpServerOf },
      { mcpServers: { switch: stdio, gws: stdio }, connectorMcpServers: ['gws'] }
    );
    await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
    const update = (sessionUpdate: string, toolCallId: string, named?: string) =>
      server.notify('session/update', {
        sessionId: 'native',
        update: {
          sessionUpdate,
          toolCallId,
          title: 'search',
          kind: 'other',
          status: 'pending',
          ...naming(named),
        },
      });
    const ask = (id: number, toolCallId: string, named?: string) =>
      server.send({
        id,
        method: 'session/request_permission',
        params: {
          sessionId: 'native',
          toolCall: { toolCallId, title: 'search', kind: 'other', ...naming(named) },
          options: [{ optionId: 'once', name: 'Allow', kind: 'allow_once' }],
        },
      });
    // Each call is announced on no server, named by the next update, and the
    // update after that names none again.
    for (const [toolCallId, named] of [
      ['call-1', 'switch'],
      ['call-2', 'gws'],
      ['call-3', 'gws'],
    ] as const) {
      update('tool_call', toolCallId);
      update('tool_call_update', toolCallId, named);
      update('tool_call_update', toolCallId);
    }
    ask(101, 'call-1');
    ask(102, 'call-2');
    // A server the request names itself comes first, as it always has.
    ask(103, 'call-3', 'switch');
    await flush();
    const allowed = { outcome: { outcome: 'selected', optionId: 'once' } };
    expect(server.received.find((m) => m.id === 101)?.result).toEqual(allowed);
    expect(server.received.some((m) => m.id === 102 && 'result' in m)).toBe(false);
    expect(server.received.find((m) => m.id === 103)?.result).toEqual(allowed);
    expect(events.filter((e) => e.type === 'request.opened')).toMatchObject([
      { requestType: 'mcp_tool_approval', connector: 'gws' },
    ]);
  }
);

it('offers allow-for-session, maps it to the agent option, and answers decline with cancelled when no reject is offered', async () => {
  const { adapter, events, server } = await start();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  const ask = (id: number, options: Array<Record<string, string>>) =>
    server.send({
      id,
      method: 'session/request_permission',
      params: { sessionId: 'native', toolCall: { toolCallId: `t${id}`, kind: 'execute' }, options },
    });
  ask(60, [
    { optionId: 'once', name: 'Allow', kind: 'allow_once' },
    { optionId: 'always', name: 'Allow for this session', kind: 'allow_always' },
  ]);
  await flush();
  const opened = events.filter((e) => e.type === 'request.opened');
  const first = opened[0];
  if (first?.type !== 'request.opened') throw new Error('No approval');
  expect(first.requestType).toBe('command_execution_approval');
  expect(first.title).toBe('Dummy ACP needs permission');
  expect(first.options.map((o) => o.decision)).toEqual(['accept', 'acceptForSession', 'cancel']);
  await adapter.respondToRequest('s', first.requestId, 'acceptForSession');
  ask(61, [{ optionId: 'once', name: 'Allow', kind: 'allow_once' }]);
  await flush();
  const second = events.filter((e) => e.type === 'request.opened')[1];
  if (second?.type !== 'request.opened') throw new Error('No approval');
  await adapter.respondToRequest('s', second.requestId, 'decline');
  await flush();
  expect(server.received.find((m) => m.id === 60)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'always' },
  });
  expect(server.received.find((m) => m.id === 61)?.result).toEqual({
    outcome: { outcome: 'cancelled' },
  });
});

const declining: AcpProviderHooks = { ...dummy, declineEndsTurn: true };

it.each([
  ['completes a turn its provider ends once a call is declined', declining, 'decline', 'completed'],
  [
    'still reports a cancelled turn as interrupted without the hook',
    dummy,
    'decline',
    'interrupted',
  ],
  [
    'reports a turn Switch interrupted as interrupted, hook or not',
    declining,
    'interrupt',
    'interrupted',
  ],
  [
    'reports a turn cancelled with no decline in it as failed, hook or not',
    declining,
    'none',
    'error',
  ],
  [
    'reports a turn cancelled after an approved call as failed, hook or not',
    declining,
    'accept',
    'error',
  ],
] as const)('%s', async (_name, hooks, action, outcome) => {
  const { adapter, events, server } = await start(hooks);
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  const prompt = await server.waitFor('session/prompt');
  if (action === 'decline' || action === 'accept') {
    server.send(askFor(70, 'call'));
    await flush();
    const opened = events.find((e) => e.type === 'request.opened');
    if (opened?.type !== 'request.opened') throw new Error('No approval');
    await adapter.respondToRequest('s', opened.requestId, action);
  }
  if (action === 'interrupt') await adapter.interruptTurn('s');
  server.send({ id: prompt.id, result: { stopReason: 'cancelled' } });
  await flush();
  await flush();
  const done = events.find((e) => e.type === 'turn.completed');
  if (done?.type !== 'turn.completed') throw new Error('The turn did not end');
  expect(done.outcome).toBe(outcome);
});

it("starts each turn without the last one's decline", async () => {
  const { adapter, events, server } = await start(declining);
  await adapter.sendTurn({ sessionId: 's', turnId: 't1', text: 'go' });
  const first = await server.waitFor('session/prompt');
  server.send(askFor(71, 'call'));
  await flush();
  const opened = events.find((e) => e.type === 'request.opened');
  if (opened?.type !== 'request.opened') throw new Error('No approval');
  await adapter.respondToRequest('s', opened.requestId, 'decline');
  server.send({ id: first.id, result: { stopReason: 'end_turn' } });
  await flush();
  server.received.length = 0;
  await adapter.sendTurn({ sessionId: 's', turnId: 't2', text: 'again' });
  const second = await server.waitFor('session/prompt');
  server.send({ id: second.id, result: { stopReason: 'cancelled' } });
  await flush();
  await flush();
  const done = events.filter((e) => e.type === 'turn.completed');
  expect(done.map((e) => (e.type === 'turn.completed' ? e.outcome : null))).toEqual([
    'completed',
    'error',
  ]);
});

it('approves without asking in full access, approves only edits in auto-accept-edits, and asks in auto', async () => {
  for (const [runtimeMode, kind, prompted] of [
    ['full-access', 'execute', 0],
    ['auto-accept-edits', 'edit', 0],
    ['auto-accept-edits', 'execute', 1],
    ['auto', 'edit', 1],
    ['auto', 'execute', 1],
  ] as const) {
    const { adapter, events, server } = await start(dummy, { runtimeMode });
    await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
    server.send({
      id: 50,
      method: 'session/request_permission',
      params: {
        sessionId: 'native',
        toolCall: { toolCallId: 'x', kind },
        options: [{ optionId: 'once', name: 'Allow', kind: 'allow_once' }],
      },
    });
    await flush();
    expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(prompted);
  }
});

const announce = (toolCallId: string, title: string, rawInput?: Record<string, unknown>) => ({
  method: 'session/update',
  params: {
    sessionId: 'native',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId,
      title,
      kind: 'other',
      status: 'in_progress',
      ...(rawInput ? { rawInput } : {}),
    },
  },
});
const askFor = (id: number, toolCallId: string) => ({
  id,
  method: 'session/request_permission',
  params: {
    sessionId: 'native',
    toolCall: { toolCallId },
    options: [
      { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
  },
});
const typed: AcpProviderHooks = {
  ...dummy,
  itemType: (call) =>
    call.title === 'bash'
      ? 'command_execution'
      : call.title === 'write'
        ? 'file_change'
        : undefined,
};

it('describes and decides a permission request naming only its tool call by the call announced', async () => {
  const { adapter, events, server } = await start(typed);
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  server.send(announce('a', 'bash'));
  server.send(askFor(90, 'a'));
  await flush();
  const opened = events.find((e) => e.type === 'request.opened');
  if (opened?.type !== 'request.opened') throw new Error('No approval');
  expect(opened.requestType).toBe('command_execution_approval');
  expect(opened.title).toBe('bash');

  for (const [title, prompted] of [
    ['write', 0],
    ['bash', 1],
  ] as const) {
    const edits = await start(typed, { runtimeMode: 'auto-accept-edits' });
    await edits.adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
    edits.server.send(announce('b', title));
    edits.server.send(askFor(91, 'b'));
    await flush();
    expect(edits.events.filter((e) => e.type === 'request.opened')).toHaveLength(prompted);
  }
});

it('titles tool calls and their approvals with the hooks, keeping the title on later updates', async () => {
  const titled: AcpProviderHooks = {
    ...typed,
    toolTitle: (call) =>
      typeof call.rawInput?.command === 'string' ? call.rawInput.command : undefined,
  };
  const { adapter, events, server } = await start(titled);
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  server.send(announce('a', 'bash', { command: 'npm test' }));
  server.send(askFor(92, 'a'));
  await flush();
  expect(events.find((e) => e.type === 'request.opened')).toMatchObject({ title: 'npm test' });
  server.send({
    method: 'session/update',
    params: {
      sessionId: 'native',
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed' },
    },
  });
  await flush();
  expect(events.find((e) => e.type === 'item.completed')).toMatchObject({
    item: { id: 'a', type: 'command_execution', title: 'npm test', status: 'completed' },
  });
  // An update repeating the bare tool name does not undo the hook's title.
  server.send(announce('b', 'bash', { command: 'npm run build' }));
  server.send({
    method: 'session/update',
    params: {
      sessionId: 'native',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'b',
        title: 'bash',
        status: 'completed',
      },
    },
  });
  await flush();
  expect(events.filter((e) => e.type === 'item.completed').at(-1)).toMatchObject({
    item: { id: 'b', title: 'npm run build' },
  });
});

it("keeps a permission request's own kind and title over the announced call's", async () => {
  const { adapter, events, server } = await start(typed, { runtimeMode: 'auto-accept-edits' });
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  server.send(announce('a', 'write'));
  server.send({
    id: 93,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: { toolCallId: 'a', kind: 'execute', title: 'Run the migration' },
      options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }],
    },
  });
  await flush();
  expect(events.find((e) => e.type === 'request.opened')).toMatchObject({
    requestType: 'command_execution_approval',
    title: 'Run the migration',
  });
});

it('tells the launch hook the runtime mode, and nothing during a sign-in check', async () => {
  const seen: Array<string | undefined> = [];
  const hooks: AcpProviderHooks = {
    ...dummy,
    launch: ({ binaryPath, env, runtimeMode }) => {
      seen.push(runtimeMode);
      return { command: binaryPath, args: [], env };
    },
  };
  await start(hooks, { runtimeMode: 'auto' });
  const { checkAcpSignIn } = await import('./acp-adapter');
  await checkAcpSignIn(hooks, { binaryPath: 'dummy-acp', cwd: '/work', env: {} });
  expect(seen).toEqual(['auto', undefined]);
});

it('reads a permission request that names only its call from the call announced before it', async () => {
  const { adapter, events, server } = await start(dummy, { runtimeMode: 'auto-accept-edits' });
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  for (const [id, toolCallId, kind, title] of [
    [55, 'patch', 'edit', 'Edit a.ts'],
    [56, 'shell', 'execute', 'echo hi'],
  ] as const) {
    server.notify('session/update', {
      sessionId: 'native',
      update: { sessionUpdate: 'tool_call', toolCallId, kind, title, status: 'pending' },
    });
    server.send({
      id,
      method: 'session/request_permission',
      params: {
        sessionId: 'native',
        toolCall: { toolCallId },
        options: [{ optionId: 'once', name: 'Allow', kind: 'allow_once' }],
      },
    });
  }
  await flush();
  expect(server.received.find((m) => m.id === 55)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'once' },
  });
  expect(events.filter((e) => e.type === 'request.opened')).toMatchObject([
    { requestType: 'command_execution_approval', title: 'echo hi' },
  ]);
});

it('lets vendor extensions ask questions and add items, and cancels them outside a turn', async () => {
  const hooks: AcpProviderHooks = {
    ...dummy,
    extensions: (context, on) => {
      on.request('_dummy/ask', () =>
        context.askQuestions(
          [
            {
              id: 'pick',
              question: 'Pick',
              options: [
                { label: 'A', value: 'a' },
                { label: 'B', value: 'b' },
              ],
              multiSelect: true,
              allowCustomAnswer: false,
            },
          ],
          (selected) => ({ picked: selected[0]!.values })
        )
      );
      on.notification('_dummy/note', () =>
        context.completeItem({ id: 'note', type: 'tool_call', status: 'completed', title: 'Note' })
      );
    },
  };
  const { adapter, events, server } = await start(hooks);
  server.send({ id: 40, method: '_dummy/ask', params: {} });
  await flush();
  expect(server.received.find((m) => m.id === 40)?.result).toEqual({
    outcome: { outcome: 'cancelled' },
  });
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  server.notify('_dummy/note', {});
  server.send({ id: 41, method: '_dummy/ask', params: {} });
  await flush();
  const asked = events.find((e) => e.type === 'user-input.requested');
  if (asked?.type !== 'user-input.requested') throw new Error('No question');
  await expect(adapter.respondToUserInput('s', asked.requestId, { pick: ['z'] })).rejects.toThrow(
    'offered'
  );
  await adapter.respondToUserInput('s', asked.requestId, { pick: ['a', 'b'] });
  await flush();
  expect(server.received.find((m) => m.id === 41)?.result).toEqual({ picked: ['a', 'b'] });
  expect(events.find((e) => e.type === 'item.completed')).toMatchObject({
    turnId: 't',
    item: { id: 'note', title: 'Note' },
  });
});

it('fills a stdio MCP server environment from the session for its envVars', async () => {
  const { server } = await start(dummy, {
    env: { TOKEN: 'secret', OTHER: 'unused' },
    mcpServers: {
      tools: {
        transport: 'stdio',
        command: 'node',
        args: [],
        env: { MODE: 'x' },
        envVars: ['TOKEN', 'MISSING'],
      },
    },
  });
  expect(server.received.find((m) => m.method === 'session/new')?.params?.mcpServers).toEqual([
    {
      name: 'tools',
      command: 'node',
      args: [],
      env: [
        { name: 'TOKEN', value: 'secret' },
        { name: 'MODE', value: 'x' },
      ],
    },
  ]);
});

it.each([
  ['approval-required', 'switch', false],
  ['approval-required', 'other', false],
  ['approval-required', 'atlassian', true],
  ['approval-required', 'gws', true],
  ['auto-accept-edits', 'switch', false],
  ['auto-accept-edits', 'other', false],
  ['auto-accept-edits', 'atlassian', true],
  ['auto-accept-edits', 'gws', true],
  ['auto', 'switch', false],
  ['auto', 'other', false],
  ['auto', 'atlassian', true],
  ['auto', 'gws', true],
  ['full-access', 'switch', false],
  ['full-access', 'atlassian', false],
  ['full-access', 'gws', false],
] as const)(
  "in %s a tool on %s asks: %s (Switch's own never does)",
  async (runtimeMode, toolServer, asks) => {
    const stdio = { transport: 'stdio' as const, command: 'node', args: ['server.js'] };
    const hooks: AcpProviderHooks = {
      ...dummy,
      mcpServerOf: (toolCall) => toolCall._meta?.server as string | undefined,
    };
    const { adapter, events, server } = await start(hooks, {
      runtimeMode,
      mcpServers: { switch: stdio, atlassian: stdio, gws: stdio, other: stdio },
      connectorMcpServers: ['atlassian', 'gws'],
    });
    await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
    server.send({
      id: 80,
      method: 'session/request_permission',
      params: {
        sessionId: 'native',
        toolCall: { toolCallId: 'call-80', title: 'search', _meta: { server: toolServer } },
        options: [{ optionId: 'once', name: 'Allow', kind: 'allow_once' }],
      },
    });
    await flush();
    const opened = events.filter((e) => e.type === 'request.opened');
    if (!asks) {
      expect(opened).toEqual([]);
      expect(server.received.find((m) => m.id === 80)?.result).toEqual({
        outcome: { outcome: 'selected', optionId: 'once' },
      });
      return;
    }
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ requestType: 'mcp_tool_approval', connector: toolServer });
    expect(server.received.some((m) => m.id === 80 && m.result)).toBe(false);
  }
);

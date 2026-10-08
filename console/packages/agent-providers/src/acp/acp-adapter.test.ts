import type * as fs from 'node:fs/promises';
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
    uri: 'file:///work/notes.txt',
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
    resource: { uri: 'file:///work/notes.txt', mimeType: 'text/plain', text: 'file text' },
  });
});

it('auto-approves a tool the hooks place on any session-registered MCP server', async () => {
  const hooks: AcpProviderHooks = {
    ...dummy,
    mcpServerOf: (toolCall) => toolCall._meta?.server as string | undefined,
  };
  const { adapter, events, server } = await start(hooks, {
    mcpServers: { echo: { transport: 'stdio', command: 'node', args: ['echo.js'] } },
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

it('approves without asking in full access, and approves only edits in auto-accept-edits', async () => {
  for (const [runtimeMode, kind, prompted] of [
    ['full-access', 'execute', 0],
    ['auto-accept-edits', 'edit', 0],
    ['auto-accept-edits', 'execute', 1],
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

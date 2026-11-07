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
const spawned: Array<{ command: string; args: readonly string[] }> = [];
vi.mock('node:child_process', () => ({
  spawn: (command: string, args: readonly string[]) => {
    spawned.push({ command, args });
    const server = new FakeAppServer();
    // What goose 1.56.0 answers, trimmed to what the adapter reads.
    server.replyAlways('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        mcpCapabilities: { http: true, sse: false },
        sessionCapabilities: { list: {}, delete: {}, close: {} },
      },
      authMethods: [{ id: 'goose-provider', name: 'Configure Provider' }],
    }));
    server.replyAlways('session/new', () => ({ sessionId: '20261027_1', ...SESSION }));
    server.replyAlways('session/load', () => SESSION);
    server.replyAlways('session/set_mode', () => ({}));
    server.replyAlways('session/set_config_option', () => ({}));
    servers.push(server);
    return server;
  },
}));
const { createGooseAdapter, gooseAcp } = await import('./goose-acp');

const SESSION = {
  modes: {
    currentModeId: 'auto',
    availableModes: ['auto', 'approve', 'smart_approve', 'chat'].map((id) => ({ id, name: id })),
  },
  configOptions: [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'gpt-4o',
      options: [
        { value: 'gpt-4o', name: 'gpt-4o' },
        { value: 'gpt-4o-mini', name: 'gpt-4o-mini' },
      ],
    },
  ],
};
/** Goose's options, in its order, each named by its own id. */
const GOOSE_OPTIONS = ['allow_always', 'allow_once', 'reject_once', 'reject_always'].map((id) => ({
  optionId: id,
  name: id,
  kind: id,
}));

beforeEach(() => {
  servers.length = 0;
  spawned.length = 0;
});
async function setup(input: { resume?: boolean; model?: string; runtimeMode?: RuntimeMode } = {}) {
  const adapter = createGooseAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  const session = await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: input.runtimeMode ?? 'approval-required',
    env: { HOME: '/home/test' },
    mcpServers: {
      switch: { transport: 'stdio', command: 'node', args: ['server.js'], env: {} },
    },
    connectorMcpServers: [],
    ...(input.resume ? { resume: { nativeSessionId: '20261027_1' } } : {}),
    ...(input.model ? { model: { id: input.model } } : {}),
  });
  const server = servers.at(-1)!;
  return { adapter, events, server, session };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A tool call the way Goose announces it, then its permission request, which drops `_meta`. */
function toolCallThenAsk(
  server: FakeAppServer,
  id: number,
  call: { toolCallId: string; title: string; toolName: string; extensionName: string }
) {
  server.notify('session/update', {
    sessionId: '20261027_1',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: call.toolCallId,
      title: call.title,
      rawInput: {},
      _meta: {
        goose: { toolCall: { toolName: call.toolName, extensionName: call.extensionName } },
      },
    },
  });
  server.send({
    id,
    method: 'session/request_permission',
    params: {
      sessionId: '20261027_1',
      toolCall: {
        toolCallId: call.toolCallId,
        kind: 'other',
        status: 'pending',
        title: call.title,
      },
      options: GOOSE_OPTIONS,
    },
  });
}

it('runs goose acp, never calls authenticate, and sets the mode for the runtime mode', async () => {
  const { server } = await setup();
  expect(spawned.at(-1)).toMatchObject({ command: 'goose', args: ['acp'] });
  expect(server.received.some((m) => m.method === 'authenticate')).toBe(false);
  expect(server.received.find((m) => m.method === 'session/set_mode')?.params).toEqual({
    sessionId: '20261027_1',
    modeId: 'approve',
  });
});

it("maps each runtime mode onto Goose's permission levels", () => {
  expect(
    (['full-access', 'auto', 'auto-accept-edits', 'approval-required'] as const).map((mode) =>
      gooseAcp.sessionMode?.(mode, undefined)
    )
  ).toEqual(['auto', 'smart_approve', 'approve', 'approve']);
});

it('resumes the exact native session with the session MCP servers, then sets its mode', async () => {
  const { server, session } = await setup({ resume: true, runtimeMode: 'full-access' });
  expect(session.nativeSessionId).toBe('20261027_1');
  expect(server.received.find((m) => m.method === 'session/load')?.params).toMatchObject({
    sessionId: '20261027_1',
    mcpServers: [{ name: 'switch', command: 'node', args: ['server.js'] }],
  });
  expect(server.received.find((m) => m.method === 'session/set_mode')?.params).toMatchObject({
    modeId: 'auto',
  });
});

it('chooses the model through its model config option', async () => {
  const { adapter, server } = await setup({ model: 'gpt-4o-mini' });
  expect((await adapter.listModels('s')).map((m) => m.id)).toEqual(['gpt-4o', 'gpt-4o-mini']);
  expect(server.received.find((m) => m.method === 'session/set_config_option')?.params).toEqual({
    sessionId: '20261027_1',
    configId: 'model',
    value: 'gpt-4o-mini',
  });
});

it('allows tools on session MCP servers without asking, from the server named in the tool call', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'list rooms' });
  toolCallThenAsk(server, 90, {
    toolCallId: 'call_mcp',
    title: 'switch: list rooms',
    toolName: 'switch__list_rooms',
    extensionName: 'switch',
  });
  await flush();
  expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(0);
  expect(server.received.find((m) => m.id === 90)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'allow_once' },
  });
  expect(events.find((e) => e.type === 'item.started')).toMatchObject({
    item: { id: 'call_mcp', type: 'mcp_tool_call' },
  });
});

it('asks about a tool on an MCP server the session did not register', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'search' });
  toolCallThenAsk(server, 91, {
    toolCallId: 'call_other',
    title: 'github: search',
    toolName: 'github__search',
    extensionName: 'github',
  });
  await flush();
  expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(1);
});

it('asks before a shell command, without offering the allow_always Goose would keep', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'run it' });
  toolCallThenAsk(server, 92, {
    toolCallId: 'call_shell',
    title: 'shell · echo ok > ok.txt',
    toolName: 'shell',
    extensionName: 'developer',
  });
  await flush();
  const request = events.find((e) => e.type === 'request.opened');
  if (!request || request.type !== 'request.opened') throw new Error('missing approval');
  expect(request.requestType).toBe('command_execution_approval');
  expect(request.title).toBe('shell · echo ok > ok.txt');
  expect(request.options.map((o) => o.decision)).toEqual(['accept', 'decline', 'cancel']);
  await expect(
    adapter.respondToRequest('s', request.requestId, 'acceptForSession')
  ).rejects.toThrow(/not offered/);
  await adapter.respondToRequest('s', request.requestId, 'decline');
  await flush();
  expect(server.received.find((m) => m.id === 92)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'reject_once' },
  });
});

it('runs edits without asking in auto-accept-edits, and still asks before a command', async () => {
  const { adapter, events, server } = await setup({ runtimeMode: 'auto-accept-edits' });
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'edit and run' });
  toolCallThenAsk(server, 93, {
    toolCallId: 'call_write',
    title: 'write · /work/a.txt',
    toolName: 'write',
    extensionName: 'developer',
  });
  toolCallThenAsk(server, 94, {
    toolCallId: 'call_edit',
    title: 'edit · /work/a.txt',
    toolName: 'edit',
    extensionName: 'developer',
  });
  toolCallThenAsk(server, 95, {
    toolCallId: 'call_shell',
    title: 'shell · rm -rf build',
    toolName: 'shell',
    extensionName: 'developer',
  });
  await flush();
  for (const id of [93, 94])
    expect(server.received.find((m) => m.id === id)?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    });
  const opened = events.filter((e) => e.type === 'request.opened');
  expect(opened).toHaveLength(1);
  expect(opened[0]).toMatchObject({ title: 'shell · rm -rf build' });
});

it('leaves the request it was given unchanged', () => {
  const request = {
    sessionId: 'native',
    toolCall: { toolCallId: 'c', kind: 'other', title: 'write · a.txt' },
    options: GOOSE_OPTIONS,
  };
  const restated = gooseAcp.permissionRequest?.(request);
  expect(restated?.toolCall.kind).toBe('edit');
  expect(restated?.options.map((o) => o.kind)).toEqual([
    'allow_once',
    'reject_once',
    'reject_always',
  ]);
  expect(request.toolCall.kind).toBe('other');
  expect(request.options).toHaveLength(4);
});

it('types the developer tools and delegate, and keeps other built-in tools plain', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'work' });
  for (const [toolCallId, toolName, extensionName] of [
    ['shell', 'shell', 'developer'],
    ['write', 'write', 'developer'],
    ['tree', 'tree', 'developer'],
    ['analyze', 'analyze', 'analyze'],
    ['delegate', 'delegate', 'summon'],
  ])
    server.notify('session/update', {
      sessionId: '20261027_1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId,
        title: toolName,
        _meta: { goose: { toolCall: { toolName, extensionName } } },
      },
    });
  server.notify('session/update', {
    sessionId: '20261027_1',
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'delegate',
      status: 'completed',
      _meta: { goose: { subagentSessionId: '20261027_2' } },
    },
  });
  await flush();
  const types = Object.fromEntries(
    events.flatMap((e) => (e.type === 'item.started' ? [[e.item.id, e.item.type]] : []))
  );
  expect(types).toEqual({
    shell: 'command_execution',
    write: 'file_change',
    tree: 'tool_call',
    analyze: 'tool_call',
    delegate: 'subagent',
  });
  expect(events.find((e) => e.type === 'item.completed')).toMatchObject({
    item: { id: 'delegate', type: 'subagent', status: 'completed' },
  });
});

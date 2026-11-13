import type * as fs from 'node:fs/promises';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { ProviderConversationUnavailableError } from '../adapter';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));
const servers: FakeAppServer[] = [];
const spawned: Array<{ args: string[]; env: Record<string, string> }> = [];
// What OpenHands CLI 1.16.0 answers, as recorded from `openhands acp`.
vi.mock('node:child_process', () => ({
  spawn: (_command: string, args: string[], options: { env: Record<string, string> }) => {
    spawned.push({ args, env: options.env });
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: true, sse: true },
        promptCapabilities: { audio: false, embeddedContext: true, image: true },
      },
      agentInfo: { name: 'OpenHands CLI ACP Agent', version: '1.16.0' },
      authMethods: [{ id: 'oauth', name: 'OAuth with OpenHands Cloud', _meta: { type: 'agent' } }],
    }));
    server.replyAlways('session/new', () => ({
      sessionId: args[1] === '--resume' ? args[2] : '80d11f7b-d591-43e9-b578-599318b6f854',
      modes: {
        availableModes: [{ id: 'always-ask' }, { id: 'always-approve' }, { id: 'llm-approve' }],
        currentModeId: 'always-ask',
      },
    }));
    server.replyAlways('session/set_mode', () => ({}));
    servers.push(server);
    return server;
  },
}));
const { createOpenhandsAdapter, openhandsAcp, openhandsMcpServers, openhandsModel } =
  await import('./openhands-acp');

const NATIVE = '80d11f7b-d591-43e9-b578-599318b6f854';
const relay = { transport: 'stdio' as const, command: '/node', args: ['/host.mjs', '--mcp-relay'] };
beforeEach(() => {
  servers.length = 0;
  spawned.length = 0;
});
async function setup(resume?: string, home = '/home/a', systemContext?: string) {
  const adapter = createOpenhandsAdapter({ mcpRelay: relay });
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: 'approval-required',
    env: { HOME: home },
    mcpServers: {
      switch: { transport: 'http', url: 'http://127.0.0.1:4000/mcp', headers: { A: 'b' } },
    },
    connectorMcpServers: [],
    ...(resume ? { resume: { nativeSessionId: resume } } : {}),
    ...(systemContext ? { systemContext } : {}),
  });
  return { adapter, events, server: servers.at(-1)! };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const confirm = (server: FakeAppServer, id: number) =>
  server.send({
    id,
    method: 'session/request_permission',
    params: {
      sessionId: NATIVE,
      toolCall: {
        toolCallId: `confirmation-${NATIVE}`,
        kind: 'other',
        status: 'pending',
        title: 'Confirm Agent Actions',
      },
      options: [
        { kind: 'allow_once', name: 'Yes, proceed', optionId: 'accept' },
        { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
        {
          kind: 'allow_always',
          name: "Always proceed (don't ask again)",
          optionId: 'always_proceed',
        },
        {
          kind: 'allow_once',
          name: 'Auto-confirm LOW/MEDIUM risk, ask for HIGH risk action',
          optionId: 'risk_based',
        },
      ],
    },
  });

it('puts each runtime mode in the OpenHands confirmation mode that enforces it', () => {
  expect(
    (['full-access', 'auto', 'approval-required', 'auto-accept-edits'] as const).map((mode) =>
      openhandsAcp.sessionMode?.(mode, undefined)
    )
  ).toEqual(['always-approve', 'llm-approve', 'always-ask', 'always-ask']);
});

it('starts a session without signing in, with the Switch tools relayed over stdio', async () => {
  const { server } = await setup();
  expect(spawned).toEqual([
    { args: ['acp'], env: { HOME: '/home/a', OPENHANDS_SUPPRESS_BANNER: '1' } },
  ]);
  expect(server.received.map((m) => m.method)).toEqual([
    'initialize',
    'session/new',
    'session/set_mode',
  ]);
  expect(server.received[1]?.params?.mcpServers).toMatchObject([
    { name: 'switch', command: '/node', args: ['/host.mjs', '--mcp-relay'] },
  ]);
  expect(
    (server.received[1]?.params?.mcpServers as Array<{ env: unknown[] }> | undefined)?.[0]?.env
  ).toContainEqual({ name: 'SWITCH_MCP_RELAY_RENAMED', value: '["kind"]' });
  expect(server.received[2]?.params).toEqual({ sessionId: NATIVE, modeId: 'always-ask' });
});

it('resumes a saved conversation by launching with it and starting it with the session MCP servers', async () => {
  const home = await mkdtemp(join(tmpdir(), 'openhands-'));
  const saved = join(home, '.openhands', 'conversations', NATIVE.replaceAll('-', ''));
  try {
    await mkdir(saved, { recursive: true });
    await writeFile(join(saved, 'base_state.json'), '{}');
    const { server } = await setup(NATIVE, home);
    expect(spawned[0]?.args).toEqual(['acp', '--resume', NATIVE]);
    expect(server.received.map((m) => m.method)).toEqual([
      'initialize',
      'session/new',
      'session/set_mode',
    ]);
    expect(server.received[1]?.params?.mcpServers).toHaveLength(1);
  } finally {
    await rm(home, { recursive: true });
  }
});

it('asks for a fresh conversation when OpenHands has not saved the one to resume', async () => {
  await expect(setup('5d0c39e2-6b1f-4a8e-9f3d-2c7b8e1a4f60')).rejects.toBeInstanceOf(
    ProviderConversationUnavailableError
  );
  expect(spawned[0]?.args).toEqual(['acp']);
});

it('offers the confirmation OpenHands asks before each step, without its risk-based policy', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'run it' });
  confirm(server, 0);
  confirm(server, 1);
  await flush();
  const [first, second] = events.filter((e) => e.type === 'request.opened');
  if (first?.type !== 'request.opened' || second?.type !== 'request.opened')
    throw new Error('No confirmation');
  expect(first).toMatchObject({ requestType: 'tool_approval', title: 'Confirm Agent Actions' });
  expect(first.options.map((o) => o.decision)).toEqual([
    'accept',
    'decline',
    'acceptForSession',
    'cancel',
  ]);
  await adapter.respondToRequest('s', first.requestId, 'accept');
  await adapter.respondToRequest('s', second.requestId, 'decline');
  await flush();
  expect(
    server.received.filter((m) => m.id !== undefined && !m.method).map((m) => m.result)
  ).toEqual([
    { outcome: { outcome: 'selected', optionId: 'accept' } },
    { outcome: { outcome: 'selected', optionId: 'reject' } },
  ]);
});

it('runs the Switch tools without asking, and titles a confirmation with the action it is for', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'reply' });
  const announce = (update: Record<string, unknown>) =>
    server.notify('session/update', { sessionId: NATIVE, update });
  // An MCP tool call as OpenHands CLI 1.16.0 announces it, then confirms it.
  announce({
    sessionUpdate: 'tool_call',
    toolCallId: '14KBFfrSX',
    kind: 'other',
    status: 'in_progress',
    title: 'post_message: {"text": "Hi"}',
    rawInput: { data: { text: 'Hi' }, kind: 'MCPToolAction' },
  });
  confirm(server, 0);
  await flush();
  expect(server.received.find((m) => m.id === 0 && !m.method)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'accept' },
  });
  expect(events.find((e) => e.type === 'item.started')).toMatchObject({
    item: { id: '14KBFfrSX', type: 'mcp_tool_call' },
  });
  announce({ sessionUpdate: 'tool_call_update', toolCallId: '14KBFfrSX', status: 'completed' });
  announce({
    sessionUpdate: 'tool_call',
    toolCallId: 'call_9',
    kind: 'execute',
    status: 'in_progress',
    title: '$ uname -a',
    rawInput: { command: 'uname -a', kind: 'TerminalAction' },
  });
  confirm(server, 1);
  await flush();
  expect(events.filter((e) => e.type === 'request.opened')).toMatchObject([
    { requestType: 'command_execution_approval', title: '$ uname -a' },
  ]);
});

it('asks before an MCP tool when OpenHands has MCP servers of its own it may be on', async () => {
  const home = await mkdtemp(join(tmpdir(), 'openhands-'));
  try {
    await mkdir(join(home, '.openhands'));
    await writeFile(
      join(home, '.openhands', 'mcp.json'),
      JSON.stringify({
        mcpServers: { github: { command: 'github-mcp' }, old: { command: 'x', enabled: false } },
      })
    );
    expect(await openhandsMcpServers({ HOME: home })).toEqual(['github']);
    const { adapter, events, server } = await setup(undefined, home);
    await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'reply' });
    server.notify('session/update', {
      sessionId: NATIVE,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'm1',
        kind: 'other',
        status: 'in_progress',
        title: 'post_message: {"text": "Hi"}',
        rawInput: { data: { text: 'Hi' }, kind: 'MCPToolAction' },
      },
    });
    confirm(server, 0);
    await flush();
    expect(events.filter((e) => e.type === 'request.opened')).toMatchObject([
      { requestType: 'tool_approval', title: 'post_message: {"text": "Hi"}' },
    ]);
  } finally {
    await rm(home, { recursive: true });
  }
});

it('lists the model set in OpenHands as its only one, and refuses another', async () => {
  const home = await mkdtemp(join(tmpdir(), 'openhands-'));
  try {
    await mkdir(join(home, '.openhands'));
    await writeFile(
      join(home, '.openhands', 'agent_settings.json'),
      '{"llm": {"model": "mistral/devstral-latest"}}'
    );
    const { adapter } = await setup(undefined, home);
    expect(await adapter.listModels('s')).toEqual([
      { id: 'mistral/devstral-latest', label: 'mistral/devstral-latest', options: {} },
    ]);
    await adapter.setModel('s', { id: 'mistral/devstral-latest' });
    await expect(adapter.setModel('s', { id: 'openai/gpt-5' })).rejects.toThrow(
      'OpenHands CLI runs mistral/devstral-latest, the model set in its own settings, and cannot run openai/gpt-5.'
    );
  } finally {
    await rm(home, { recursive: true });
  }
});

it('answers a confirmation an interrupt cuts off with an error, which OpenHands stops on', async () => {
  const { adapter, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'run it' });
  confirm(server, 0);
  await flush();
  await adapter.interruptTurn('s');
  confirm(server, 1);
  await flush();
  expect(
    server.received.filter((m) => m.id !== undefined && !m.method).map((m) => m.error?.message)
  ).toEqual(['Error: The turn was interrupted.', 'Error: The turn was interrupted.']);
});

it('sends a first prompt over the 64 KiB line OpenHands reads in parts, each in one line', async () => {
  const { adapter, server } = await setup(
    undefined,
    '/home/a',
    'Switch context line.\n'.repeat(4000)
  );
  server.replyAlways('session/prompt', () => ({ stopReason: 'end_turn' }));
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'hello' });
  const prompts = () => server.received.filter((m) => m.method === 'session/prompt');
  await vi.waitFor(() => expect(prompts()).toHaveLength(2));
  for (const message of prompts())
    expect(Buffer.byteLength(`${JSON.stringify(message)}\n`)).toBeLessThanOrEqual(64 * 1024);
});

it('shows the task tool as a subagent', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'delegate' });
  server.notify('session/update', {
    sessionId: NATIVE,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_8',
      kind: 'other',
      status: 'in_progress',
      title: 'task: {"description": "Read the README"}',
      rawInput: {
        description: 'Read the README',
        subagent_type: 'general-purpose',
        kind: 'TaskAction',
      },
    },
  });
  await flush();
  expect(events.find((e) => e.type === 'item.started')).toMatchObject({
    item: { id: 'call_8', type: 'subagent' },
  });
});

it('is signed in when the settings its sessions start from name a model, read without running it', async () => {
  const handshake = () => Promise.reject(new Error('the CLI is never run'));
  const check = (env: Record<string, string>) =>
    openhandsAcp.checkSignIn!({
      binaryPath: 'openhands',
      cwd: '/work',
      env,
      handshake,
      request: handshake,
      connection: () => {
        throw new Error('the CLI is never run');
      },
    });
  const home = await mkdtemp(join(tmpdir(), 'openhands-'));
  const persisted = join(home, 'persisted');
  try {
    expect((await check({ HOME: home })).status).toBe('unauthenticated');
    await mkdir(join(home, '.openhands'));
    await writeFile(
      join(home, '.openhands', 'agent_settings.json'),
      '{"llm": {"model": "gemini/gemini-2.5-flash"}}'
    );
    expect(await check({ HOME: home })).toMatchObject({
      status: 'authenticated',
      message: 'Signed in. Sessions run gemini/gemini-2.5-flash, the model set in OpenHands.',
    });
    await mkdir(persisted);
    await writeFile(join(persisted, 'agent_settings.json'), '{"llm": {"model": "openai/gpt-5"}}');
    expect(await openhandsModel({ HOME: home, OPENHANDS_PERSISTENCE_DIR: persisted })).toBe(
      'openai/gpt-5'
    );
    await writeFile(join(persisted, 'agent_settings.json'), '{"llm": {"model": ');
    expect(
      await openhandsModel({ HOME: home, OPENHANDS_PERSISTENCE_DIR: persisted })
    ).toBeUndefined();
  } finally {
    await rm(home, { recursive: true });
  }
});

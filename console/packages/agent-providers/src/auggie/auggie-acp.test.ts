import type * as fs from 'node:fs/promises';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RuntimeMode } from '../adapter';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));
const servers: FakeAppServer[] = [];
const spawned: Array<{ command: string; args: string[] }> = [];
/**
 * `session/new` as auggie 0.37.0 answers it. The modes are what it sends; the
 * models list is empty without an account, so these two stand in for it.
 */
const auggieSession = {
  sessionId: 'native',
  modes: {
    currentModeId: 'default',
    availableModes: [
      { id: 'default', name: 'Default' },
      { id: 'ask', name: 'Ask' },
    ],
  },
  models: {
    availableModels: [
      { modelId: 'model-a', name: 'Model A' },
      { modelId: 'model-b', name: 'Model B' },
    ],
    currentModelId: 'model-a',
  },
};
vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[]) => {
    spawned.push({ command, args });
    const server = new FakeAppServer();
    // auggie 0.37.0 offers no auth method to a client without terminal auth.
    server.replyAlways('initialize', () => ({
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
      authMethods: [],
    }));
    server.replyAlways('session/new', () => auggieSession);
    server.replyAlways('session/load', () => ({
      modes: auggieSession.modes,
      models: auggieSession.models,
    }));
    server.replyAlways('session/set_model', () => ({}));
    servers.push(server);
    return server;
  },
}));
const { AUGGIE_ASK_FIRST_TOOLS, auggieAcp, createAuggieAdapter } = await import('./auggie-acp');

beforeEach(() => {
  servers.length = 0;
  spawned.length = 0;
});

async function setup(input: { runtimeMode?: RuntimeMode; resume?: string; model?: string } = {}) {
  const adapter = createAuggieAdapter();
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

/** Auggie 0.37.0's permission request for a tool an `ask-user` rule matched. */
function toolPermission(id: number, kind: string) {
  return {
    id,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: { toolCallId: `call-${id}`, title: 'Run `ls`', kind },
      options: [
        { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
      ],
    },
  };
}

/** The request auggie 0.37.0 sends after `session/new` to index the workspace. */
function indexingPermission(id: number) {
  return {
    id,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: {
        toolCallId: 'workspace-indexing-permission',
        title: 'Workspace Indexing Permission',
      },
      options: [
        { optionId: 'always-enable', name: 'Always index', kind: 'allow_always' },
        { optionId: 'always-disable', name: 'Never index', kind: 'reject_always' },
        { optionId: 'session-enable', name: 'Index for this session', kind: 'allow_once' },
        { optionId: 'session-disable', name: 'Skip for this session', kind: 'reject_once' },
      ],
    },
  };
}

it('starts auggie --acp asking before edits and commands, with the HTTP MCP server, no sign-in call and its default mode', async () => {
  const { server, session } = await setup();
  expect(spawned.at(-1)).toEqual({
    command: 'auggie',
    args: [
      '--acp',
      ...AUGGIE_ASK_FIRST_TOOLS.flatMap((tool) => ['--permission', `${tool}:ask-user`]),
    ],
  });
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
  // Auggie's modes are workflows, not permission levels.
  expect(server.received.some((m) => m.method === 'session/set_mode')).toBe(false);
});

it('resumes the exact native session through session/load', async () => {
  const { server, session } = await setup({ resume: 'saved' });
  expect(session.nativeSessionId).toBe('saved');
  expect(server.received.find((m) => m.method === 'session/load')?.params).toMatchObject({
    sessionId: 'saved',
    cwd: '/work',
  });
});

it('lists the session’s models and selects the chosen one with session/set_model', async () => {
  const { adapter, server } = await setup({ model: 'model-b' });
  expect((await adapter.listModels('s')).map((model) => model.id)).toEqual(['model-a', 'model-b']);
  expect(server.received.find((m) => m.method === 'session/set_model')?.params).toEqual({
    sessionId: 'native',
    modelId: 'model-b',
  });
});

it('puts an Auggie permission request to the room, and answers its Allow or Deny', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  server.send(toolPermission(70, 'execute'));
  server.send(toolPermission(71, 'edit'));
  await flush();
  const opened = events.filter((e) => e.type === 'request.opened');
  expect(opened).toHaveLength(2);
  for (const [event, decision] of [
    [opened[0], 'accept'],
    [opened[1], 'decline'],
  ] as const) {
    if (event?.type !== 'request.opened') throw new Error('No approval');
    expect(event.options.map((o) => o.decision)).toEqual(['accept', 'decline', 'cancel']);
    await adapter.respondToRequest('s', event.requestId, decision);
  }
  await flush();
  expect([70, 71].map((id) => server.received.find((m) => m.id === id)?.result)).toEqual([
    { outcome: { outcome: 'selected', optionId: 'allow_once' } },
    { outcome: { outcome: 'selected', optionId: 'reject_once' } },
  ]);
});

it('allows everything Auggie asks in full access, and edits only in auto-accept-edits', async () => {
  const full = await setup({ runtimeMode: 'full-access' });
  await full.adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  full.server.send(toolPermission(72, 'execute'));
  await flush();
  expect(full.events.some((e) => e.type === 'request.opened')).toBe(false);
  expect(full.server.received.find((m) => m.id === 72)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'allow_once' },
  });

  const edits = await setup({ runtimeMode: 'auto-accept-edits' });
  await edits.adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  edits.server.send(toolPermission(73, 'edit'));
  edits.server.send(toolPermission(74, 'execute'));
  await flush();
  expect(edits.server.received.find((m) => m.id === 73)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'allow_once' },
  });
  expect(edits.events.filter((e) => e.type === 'request.opened')).toHaveLength(1);
});

it('never grants workspace indexing, in a turn or out of one, even in full access', async () => {
  const { adapter, events, server } = await setup({ runtimeMode: 'full-access' });
  server.send(indexingPermission(80));
  await flush();
  expect(server.received.find((m) => m.id === 80)?.result).toEqual({
    outcome: { outcome: 'cancelled' },
  });
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  server.send(indexingPermission(81));
  await flush();
  expect(server.received.find((m) => m.id === 81)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'session-disable' },
  });
  expect(events.some((e) => e.type === 'request.opened')).toBe(false);
});

let home: string | undefined;
afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
  home = undefined;
});

const session = JSON.stringify({
  accessToken: 'token',
  tenantURL: 'https://tenant.example/',
  scopes: ['email'],
});
const check = (env: Record<string, string>) =>
  auggieAcp.checkSignIn!({
    binaryPath: 'auggie',
    cwd: '/work',
    env,
    handshake: async () => {
      throw new Error('the check must not start auggie');
    },
    request: async () => {
      throw new Error('the check must not ask auggie anything');
    },
  });

it('finds the session auggie login saved, without starting Auggie', async () => {
  home = await mkdtemp(join(tmpdir(), 'auggie-home-'));
  await expect(check({ HOME: home })).resolves.toMatchObject({
    status: 'unauthenticated',
    message: 'Sign in on the execution machine with auggie login.',
  });
  await mkdir(join(home, '.augment'));
  // Auggie itself refuses a session without a token, a tenant or scopes.
  await writeFile(join(home, '.augment', 'session.json'), '{"accessToken":"token"}');
  await expect(check({ HOME: home })).resolves.toMatchObject({ status: 'unauthenticated' });
  await writeFile(join(home, '.augment', 'session.json'), session);
  await expect(check({ HOME: home })).resolves.toMatchObject({ status: 'authenticated' });
  expect(spawned).toEqual([]);
});

it('takes a session in AUGMENT_SESSION_AUTH as signed in, and passes it through', async () => {
  home = await mkdtemp(join(tmpdir(), 'auggie-home-'));
  await expect(check({ HOME: home, AUGMENT_SESSION_AUTH: session })).resolves.toMatchObject({
    status: 'authenticated',
    message: 'Signs in with the session in AUGMENT_SESSION_AUTH.',
  });
  await expect(check({ HOME: home, AUGMENT_SESSION_AUTH: 'not json' })).resolves.toMatchObject({
    status: 'unauthenticated',
  });
  expect(auggieAcp.inheritEnv).toEqual(['AUGMENT_SESSION_AUTH']);
});

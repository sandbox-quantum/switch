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
/** `initialize` as Copilot CLI 1.0.107 answers it, signed in or not. */
const copilotInitialize = {
  protocolVersion: 1,
  agentCapabilities: {
    auth: { logout: {} },
    loadSession: true,
    mcpCapabilities: { http: true, sse: true },
    promptCapabilities: { image: true, audio: false, embeddedContext: true },
    sessionCapabilities: { close: {}, list: {} },
  },
  agentInfo: { name: 'Copilot', title: 'Copilot', version: '1.0.107' },
  authMethods: [
    {
      id: 'copilot-login',
      name: 'Log in with Copilot CLI',
      description: 'Run `copilot login` in the terminal',
    },
  ],
};
const copilotSession = {
  sessionId: 'native',
  models: {
    currentModelId: 'auto',
    availableModels: [
      { modelId: 'auto', name: 'Auto' },
      { modelId: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
    ],
  },
};
/** Whether the fake CLI is signed in; signed out, `session/new` is refused as 1.0.107 refuses it. */
const state = { signedIn: true };
vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[]) => {
    spawned.push({ command, args });
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => copilotInitialize);
    server.on('message', (message: { id?: number; method?: string }) => {
      if (message.method !== 'session/new' || message.id === undefined) return;
      server.send(
        state.signedIn
          ? { id: message.id, result: copilotSession }
          : { id: message.id, error: { code: -32000, message: 'Authentication required' } }
      );
    });
    server.replyAlways('session/load', () => ({ models: copilotSession.models }));
    server.replyAlways('session/set_model', () => ({}));
    server.replyAlways('session/close', () => ({}));
    servers.push(server);
    return server;
  },
}));
const { checkAcpSignIn } = await import('../acp/acp-adapter');
const { copilotAcp, copilotEnvSignIn, createCopilotAdapter } = await import('./copilot-acp');

beforeEach(() => {
  servers.length = 0;
  spawned.length = 0;
  state.signedIn = true;
});

async function setup(input: { runtimeMode?: RuntimeMode; resume?: string; model?: string } = {}) {
  const adapter = createCopilotAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  const session = await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: input.runtimeMode ?? 'approval-required',
    env: {},
    mcpServers: {
      switch: { transport: 'http', url: 'http://127.0.0.1:4567/mcp', headers: {} },
    },
    connectorMcpServers: [],
    ...(input.resume ? { resume: { nativeSessionId: input.resume } } : {}),
    ...(input.model ? { model: { id: input.model } } : {}),
  });
  return { adapter, events, server: servers.at(-1)!, session };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const check = (env: Record<string, string> = {}) =>
  checkAcpSignIn(copilotAcp, { binaryPath: 'copilot', cwd: '/work', env });

it('starts copilot --acp --stdio and never sends its interactive authenticate', async () => {
  const { server, session } = await setup();
  expect(spawned.at(-1)).toEqual({ command: 'copilot', args: ['--acp', '--stdio'] });
  expect(session.nativeSessionId).toBe('native');
  expect(server.received.some((m) => m.method === 'authenticate')).toBe(false);
  expect(server.received.some((m) => m.method === 'session/set_mode')).toBe(false);
  expect(server.received.find((m) => m.method === 'session/new')?.params).toMatchObject({
    cwd: '/work',
    mcpServers: [{ type: 'http', name: 'switch', url: 'http://127.0.0.1:4567/mcp' }],
  });
});

it('resumes the exact native session through session/load', async () => {
  const { server, session } = await setup({ resume: 'saved' });
  expect(session.nativeSessionId).toBe('saved');
  expect(server.received.find((m) => m.method === 'session/load')?.params).toMatchObject({
    sessionId: 'saved',
    cwd: '/work',
  });
});

it('lists the session’s models and selects the chosen one', async () => {
  const { adapter, server } = await setup({ model: 'claude-sonnet-4.6' });
  expect((await adapter.listModels('s')).map((model) => model.id)).toEqual([
    'auto',
    'claude-sonnet-4.6',
  ]);
  expect(server.received.find((m) => m.method === 'session/set_model')?.params).toEqual({
    sessionId: 'native',
    modelId: 'claude-sonnet-4.6',
  });
});

const permissionOptions = [
  { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
];

it('answers permission requests itself in full access, since --yolo is not honoured over ACP', async () => {
  const { adapter, events, server } = await setup({ runtimeMode: 'full-access' });
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  server.send({
    id: 70,
    method: 'session/request_permission',
    params: { sessionId: 'native', toolCall: { toolCallId: 'bash-1' }, options: permissionOptions },
  });
  await flush();
  expect(events.some((e) => e.type === 'request.opened')).toBe(false);
  expect(server.received.find((m) => m.id === 70)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'allow_once' },
  });
});

it('asks in the room in approval-required mode, and passes a denial back', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  server.send({
    id: 71,
    method: 'session/request_permission',
    params: { sessionId: 'native', toolCall: { toolCallId: 'bash-2' }, options: permissionOptions },
  });
  await flush();
  const opened = events.find((e) => e.type === 'request.opened');
  if (opened?.type !== 'request.opened') throw new Error('No approval');
  await adapter.respondToRequest('s', opened.requestId, 'decline');
  await flush();
  expect(server.received.find((m) => m.id === 71)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'reject_once' },
  });
});

it('runs the session’s own MCP tools without asking, matching the call to its server by title', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  // As Copilot 1.0.107 sends them: `<server>-<tool>` in the update, the bare tool in the request.
  const update = (toolCallId: string, title: string) =>
    server.send({
      method: 'session/update',
      params: {
        sessionId: 'native',
        update: { sessionUpdate: 'tool_call', toolCallId, title, kind: 'other', status: 'pending' },
      },
    });
  const ask = (id: number, toolCallId: string, title: string) =>
    server.send({
      id,
      method: 'session/request_permission',
      params: {
        sessionId: 'native',
        toolCall: { toolCallId, title, kind: 'other', status: 'pending' },
        options: permissionOptions,
      },
    });
  update('mcp-1', 'switch-switch_echo');
  ask(72, 'mcp-1', 'switch_echo');
  await flush();
  expect(server.received.find((m) => m.id === 72)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'allow_once' },
  });
  expect(events.some((e) => e.type === 'request.opened')).toBe(false);
  // A tool whose title only looks prefixed, by a server this session did not register, still asks.
  update('other-1', 'elsewhere-switch_echo');
  ask(73, 'other-1', 'switch_echo');
  await flush();
  expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(1);
});

it('treats a task call, which names its agent and prompt, as a subagent', () => {
  expect(
    copilotAcp.itemType?.({
      toolCallId: 'task-1',
      title: 'Read README first line',
      kind: 'other',
      rawInput: { agent_type: 'explore', mode: 'sync', prompt: 'Read README.md' },
    })
  ).toBe('subagent');
  expect(
    copilotAcp.itemType?.({ toolCallId: 'read-1', kind: 'read', rawInput: { path: 'README.md' } })
  ).toBeUndefined();
});

it('reads the sign-in from the environment first: a model provider, then Copilot’s own token', () => {
  expect(copilotEnvSignIn({})).toBeUndefined();
  expect(
    copilotEnvSignIn({ COPILOT_PROVIDER_BASE_URL: 'http://localhost:11434/v1' })
  ).toMatchObject({ status: 'authenticated' });
  expect(copilotEnvSignIn({ COPILOT_PROVIDERS_CONFIG: '/etc/copilot.json' })).toMatchObject({
    status: 'authenticated',
  });
  expect(copilotEnvSignIn({ COPILOT_GITHUB_TOKEN: 'github_pat_synthetic' })).toMatchObject({
    status: 'authenticated',
    message: expect.stringContaining('COPILOT_GITHUB_TOKEN'),
  });
  // GH_TOKEN and GITHUB_TOKEN are not passed to sessions, so the CLI is asked.
  expect(copilotEnvSignIn({ GH_TOKEN: 'gho_synthetic', GITHUB_TOKEN: 'gho_synthetic' })).toBe(
    undefined
  );
  // A classic PAT is refused by the CLI, so it does not count as signed in.
  const classic = copilotEnvSignIn({ COPILOT_GITHUB_TOKEN: 'ghp_synthetic' });
  expect(classic).toMatchObject({ status: 'unauthenticated' });
  expect(classic?.message).not.toContain('ghp_synthetic');
  expect(copilotEnvSignIn({ COPILOT_GITHUB_TOKEN: '  ' })).toBeUndefined();
});

it('takes a token from the environment without starting the CLI', async () => {
  await expect(check({ COPILOT_GITHUB_TOKEN: 'github_pat_synthetic' })).resolves.toMatchObject({
    status: 'authenticated',
  });
  expect(spawned).toHaveLength(0);
});

it('asks the CLI otherwise: a refused session/new is signed out, with the login hint', async () => {
  state.signedIn = false;
  await expect(check()).resolves.toMatchObject({
    status: 'unauthenticated',
    message: 'Sign in on the execution machine with copilot login.',
  });
  const methods = servers.at(-1)!.received.map((m) => m.method);
  expect(methods).toContain('session/new');
  expect(methods).not.toContain('authenticate');
});

it('counts a session it can open as signed in, and closes that session', async () => {
  await expect(check()).resolves.toMatchObject({ status: 'authenticated' });
  const server = servers.at(-1)!;
  expect(server.received.some((m) => m.method === 'authenticate')).toBe(false);
  expect(server.received.find((m) => m.method === 'session/close')?.params).toEqual({
    sessionId: 'native',
  });
});

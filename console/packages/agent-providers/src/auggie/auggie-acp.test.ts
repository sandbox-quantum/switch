import type * as fs from 'node:fs/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { McpServerSpec } from '../adapter';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';
import type * as providerProcess from '../provider-process';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));
const servers: FakeAppServer[] = [];
const spawned: Array<{ command: string; args: string[] }> = [];
vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[]) => {
    spawned.push({ command, args });
    const server = new FakeAppServer();
    // Auggie 0.36.0's handshake: conversations load, images are taken, no MCP
    // transport is advertised and no sign-in method is listed, signed in or not.
    server.replyAlways('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true },
        sessionCapabilities: { list: {} },
      },
      agentInfo: { name: 'auggie', title: 'Auggie Agent', version: '0.36.0' },
      authMethods: [],
    }));
    server.replyAlways('session/new', () => ({
      sessionId: 'native',
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'ask', name: 'Ask' },
        ],
      },
      models: {
        currentModelId: 'sonnet',
        availableModels: [
          { modelId: 'sonnet', name: 'Claude Sonnet' },
          { modelId: 'gpt', name: 'GPT' },
        ],
      },
    }));
    server.replyAlways('session/load', () => ({}));
    server.replyAlways('session/set_model', () => ({}));
    servers.push(server);
    return server;
  },
}));
const execProvider = vi.fn<typeof providerProcess.execProvider>();
vi.mock('../provider-process', async (original) => ({
  ...(await original<typeof providerProcess>()),
  execProvider: (...args: Parameters<typeof providerProcess.execProvider>) => execProvider(...args),
}));
const { auggieAcp, auggieSignInFailure, createAuggieAdapter } = await import('./auggie-acp');

beforeEach(() => {
  servers.length = 0;
  spawned.length = 0;
  execProvider.mockReset();
});
afterEach(() => {
  for (const server of servers) server.kill();
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** The Switch tools as the session host serves them: over HTTP, behind a token. */
const SWITCH_OVER_HTTP: Record<string, McpServerSpec> = {
  switch: {
    transport: 'http',
    url: 'http://127.0.0.1:43210/mcp',
    headers: { Authorization: 'Bearer session-token' },
  },
};

/** What Auggie offers for every action its own safety check does not pass. */
const AUGGIE_OPTIONS = [
  { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
];

async function setup(
  input: Partial<Parameters<ReturnType<typeof createAuggieAdapter>['startSession']>[0]> = {}
) {
  const adapter = createAuggieAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  const session = await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: 'approval-required',
    env: { PATH: '/usr/bin' },
    mcpServers: SWITCH_OVER_HTTP,
    connectorMcpServers: [],
    ...input,
  });
  return { adapter, events, session, server: servers.at(-1)! };
}

function askPermission(server: FakeAppServer, id: number) {
  server.send({
    id,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: {
        toolCallId: 'tool-1',
        title: 'rm -rf build',
        kind: 'execute',
        rawInput: { command: 'rm -rf build' },
      },
      options: AUGGIE_OPTIONS,
    },
  });
}

it('runs auggie --acp with indexing allowed and self-update off, on the session environment alone', async () => {
  expect(
    await auggieAcp.launch({
      binaryPath: '/opt/auggie',
      cwd: '/work',
      env: { PATH: '/usr/bin', AUGMENT_SESSION_AUTH: '{}' },
    })
  ).toEqual({
    command: '/opt/auggie',
    args: ['--acp', '--allow-indexing'],
    env: { PATH: '/usr/bin', AUGMENT_SESSION_AUTH: '{}', AUGMENT_DISABLE_AUTO_UPDATE: '1' },
  });
});

it('starts with the Switch tools over HTTP, which Auggie takes without advertising, and signs in nowhere', async () => {
  const { server, session } = await setup();
  expect(spawned).toEqual([{ command: 'auggie', args: ['--acp', '--allow-indexing'] }]);
  expect(session).toEqual({ provider: 'auggie', sessionId: 's', nativeSessionId: 'native' });
  expect(server.received.map((m) => m.method)).toEqual(['initialize', 'session/new']);
  expect(server.received.find((m) => m.method === 'session/new')?.params).toEqual({
    cwd: '/work',
    mcpServers: [
      {
        name: 'switch',
        type: 'http',
        url: 'http://127.0.0.1:43210/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer session-token' }],
      },
    ],
  });
});

it('lists the models Auggie advertises and selects the chosen one with session/set_model', async () => {
  const { adapter, server } = await setup({ model: { id: 'gpt' } });
  expect(await adapter.listModels('s')).toEqual([
    { id: 'sonnet', label: 'Claude Sonnet', options: {} },
    { id: 'gpt', label: 'GPT', options: {} },
  ]);
  expect(server.received.find((m) => m.method === 'session/set_model')?.params).toEqual({
    sessionId: 'native',
    modelId: 'gpt',
  });
});

it('resumes a saved conversation through session/load, with the Switch tools registered again', async () => {
  const { server, session } = await setup({ resume: { nativeSessionId: 'native' } });
  expect(session.nativeSessionId).toBe('native');
  expect(server.received.some((m) => m.method === 'session/new')).toBe(false);
  expect(server.received.find((m) => m.method === 'session/load')?.params).toMatchObject({
    sessionId: 'native',
    cwd: '/work',
    mcpServers: [{ name: 'switch', type: 'http' }],
  });
});

it('leaves Auggie in its own workflow mode: its modes are not permission levels', async () => {
  expect(auggieAcp.sessionMode).toBeUndefined();
  for (const runtimeMode of ['approval-required', 'auto', 'full-access'] as const) {
    const { server } = await setup({ runtimeMode });
    expect(server.received.some((m) => m.method === 'session/set_mode')).toBe(false);
  }
});

it('allows each action by itself in full access, which is all the auto-approve Auggie has', async () => {
  const { adapter, events, server } = await setup({ runtimeMode: 'full-access' });
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'clean up' });
  askPermission(server, 7);
  await flush();
  expect(server.received.find((m) => m.id === 7)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'allow_once' },
  });
  expect(events.some((e) => e.type === 'request.opened')).toBe(false);
});

it('offers Allow and Deny when approval is required, and sends the denial Auggie reads as denied', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'clean up' });
  askPermission(server, 8);
  const request = events.find((e) => e.type === 'request.opened');
  if (!request || request.type !== 'request.opened') throw new Error('missing approval');
  expect(request.requestType).toBe('command_execution_approval');
  expect(request.options.map((o) => [o.decision, o.label])).toEqual([
    ['accept', 'Allow'],
    ['decline', 'Deny'],
    ['cancel', 'Cancel'],
  ]);
  await adapter.respondToRequest('s', request.requestId, 'decline');
  await flush();
  expect(server.received.find((m) => m.id === 8)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'reject_once' },
  });
});

it('reads the sign-in from token print, without starting Auggie and without repeating what it prints', async () => {
  execProvider.mockResolvedValue({ stdout: 'SESSION={"accessToken":"secret-token"}', stderr: '' });
  const result = await auggieAcp.checkSignIn!({
    binaryPath: '/opt/auggie',
    cwd: '/work',
    env: { PATH: '/usr/bin', AUGMENT_SESSION_AUTH: '{"accessToken":"secret-token"}' },
    handshake: () => Promise.reject(new Error('the sign-in check must not start Auggie')),
  });
  expect(result).toEqual({ status: 'authenticated', message: 'Signed in to Augment.', models: [] });
  expect(execProvider).toHaveBeenCalledWith(
    '/opt/auggie',
    ['token', 'print'],
    expect.objectContaining({
      cwd: '/work',
      env: { PATH: '/usr/bin', AUGMENT_SESSION_AUTH: '{"accessToken":"secret-token"}' },
    })
  );
  expect(JSON.stringify(result)).not.toContain('secret-token');
});

it('reports signed out from the notice token print exits with, and unknown for any other failure', async () => {
  execProvider.mockRejectedValue(
    Object.assign(new Error('Command failed: auggie token print'), {
      code: 1,
      stdout: '',
      stderr:
        "❌ You are not currently logged in to Augment.\n   Run 'auggie login' to authenticate first.\n",
    })
  );
  expect(
    await auggieAcp.checkSignIn!({
      binaryPath: 'auggie',
      cwd: '/work',
      env: {},
      handshake: () => Promise.reject(new Error('the sign-in check must not start Auggie')),
    })
  ).toEqual({
    status: 'unauthenticated',
    message: 'Sign in on the execution machine with auggie login.',
    models: [],
  });
  const missing = auggieSignInFailure(
    Object.assign(new Error('spawn auggie ENOENT'), { code: 'ENOENT' })
  );
  expect(missing.status).toBe('unknown');
  expect(missing.message).toContain('(ENOENT)');
  expect(missing.message).not.toContain('spawn auggie');
  const crashed = auggieSignInFailure({
    code: 1,
    stdout: 'SESSION={"accessToken":"leaked"}',
    stderr: 'boom',
  });
  expect(crashed.status).toBe('unknown');
  expect(JSON.stringify(crashed)).not.toContain('leaked');
});

it('is not offered on Windows, where Augment supports Auggie only inside WSL', () => {
  expect(auggieAcp.unsupportedPlatforms?.win32).toMatch(/WSL/);
  expect(auggieAcp.inheritEnv).toEqual(['AUGMENT_SESSION_AUTH']);
});

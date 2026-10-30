import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));

const servers: FakeAppServer[] = [];
const acp = { authMethods: [] as Array<{ id: string; name: string }> };

vi.mock('node:child_process', () => ({
  spawn: () => {
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: true },
      },
      authMethods: acp.authMethods,
    }));
    server.replyAlways('authenticate', () => ({}));
    server.replyAlways('session/new', () => ({ sessionId: 'native' }));
    server.replyAlways('session/load', () => ({}));
    server.replyAlways('session/set_model', () => ({}));
    servers.push(server);
    return server;
  },
}));

const { createKimiAdapter, KIMI_LOGIN, kimiAcp } = await import('./kimi-adapter');

beforeEach(() => {
  servers.length = 0;
  acp.authMethods = [];
});

async function setup(resume = false, env: Record<string, string> = {}) {
  const adapter = createKimiAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  const session = await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: 'approval-required',
    env,
    mcpServers: {
      switch: { transport: 'stdio', command: 'node', args: ['server.js'], env: { MODE: 'test' } },
    },
    connectorMcpServers: [],
    ...(resume ? { resume: { nativeSessionId: 'native' } } : {}),
  });
  const server = servers.at(-1)!;
  return { adapter, events, server, session };
}

it('has the expected provider metadata, binary and launch arguments', () => {
  expect(kimiAcp.provider).toBe('kimi');
  expect(kimiAcp.label).toBe('Kimi Code');
  expect(kimiAcp.defaultBinary).toBe('kimi');
  expect(kimiAcp.loginCommand).toBe(KIMI_LOGIN);
  expect(KIMI_LOGIN).toBe('kimi login');
  expect(kimiAcp.inheritEnv).toContain('KIMI_API_KEY');
  expect(kimiAcp.inheritEnv).toContain('MOONSHOT_API_KEY');
  expect(kimiAcp.inheritEnv).toContain('KIMI_BASE_URL');
  expect(kimiAcp.inheritEnv).toContain('MOONSHOT_BASE_URL');

  const launch = kimiAcp.launch({
    binaryPath: 'kimi',
    cwd: '/work',
    env: { TEST_VAR: '1' },
  });
  expect(launch).toEqual({
    command: 'kimi',
    args: ['acp'],
    env: { TEST_VAR: '1' },
  });
});

it('reports authenticated when given KIMI_API_KEY or MOONSHOT_API_KEY', async () => {
  const fakeHandshake = vi.fn();
  const withKimiKey = await kimiAcp.checkSignIn?.({
    binaryPath: 'kimi',
    cwd: '/work',
    env: { KIMI_API_KEY: 'sk-kimi-test' },
    handshake: fakeHandshake,
  });
  expect(withKimiKey?.status).toBe('authenticated');
  expect(fakeHandshake).not.toHaveBeenCalled();

  const withMoonshotKey = await kimiAcp.checkSignIn?.({
    binaryPath: 'kimi',
    cwd: '/work',
    env: { MOONSHOT_API_KEY: 'sk-moonshot-test' },
    handshake: fakeHandshake,
  });
  expect(withMoonshotKey?.status).toBe('authenticated');
  expect(fakeHandshake).not.toHaveBeenCalled();
});

it('reports authenticated when credentials file contains access token in KIMI_HOME', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'kimi-test-'));
  try {
    const credsDir = join(tmp, 'credentials');
    await mkdir(credsDir, { recursive: true });
    await writeFile(
      join(credsDir, 'cred.json'),
      JSON.stringify({ access_token: 'test-tok', refresh_token: 'test-ref' })
    );
    const fakeHandshake = vi.fn();
    const result = await kimiAcp.checkSignIn?.({
      binaryPath: 'kimi',
      cwd: '/work',
      env: { KIMI_HOME: tmp },
      handshake: fakeHandshake,
    });
    expect(result?.status).toBe('authenticated');
    expect(fakeHandshake).not.toHaveBeenCalled();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

it('reports authenticated when handshake returns no authMethods', async () => {
  const fakeHandshake = vi.fn().mockResolvedValue({ protocolVersion: 1 });
  const result = await kimiAcp.checkSignIn?.({
    binaryPath: 'kimi',
    cwd: '/work',
    env: {},
    handshake: fakeHandshake,
  });
  expect(result?.status).toBe('authenticated');
  expect(fakeHandshake).toHaveBeenCalledOnce();
});

it('reports unauthenticated when handshake advertises outstanding authMethods', async () => {
  const fakeHandshake = vi.fn().mockResolvedValue({
    protocolVersion: 1,
    authMethods: [{ id: 'login', name: 'Kimi Account' }],
  });
  const result = await kimiAcp.checkSignIn?.({
    binaryPath: 'kimi',
    cwd: '/work',
    env: {},
    handshake: fakeHandshake,
  });
  expect(result?.status).toBe('unauthenticated');
  expect(result?.message).toBe('Sign in on the execution machine with kimi login.');
});

it('reports unauthenticated when handshake throws an authentication error', async () => {
  const fakeHandshake = vi.fn().mockRejectedValue(new Error('AUTH_REQUIRED (-32000)'));
  const result = await kimiAcp.checkSignIn?.({
    binaryPath: 'kimi',
    cwd: '/work',
    env: {},
    handshake: fakeHandshake,
  });
  expect(result?.status).toBe('unauthenticated');
  expect(result?.message).toContain('kimi login');
});

it('starts an ACP session, registers MCP servers and resumes native session', async () => {
  const { server, session } = await setup(true);
  expect(session.nativeSessionId).toBe('native');
  expect(server.received.find((m) => m.method === 'session/load')?.params).toMatchObject({
    sessionId: 'native',
    mcpServers: [
      {
        name: 'switch',
        command: 'node',
        args: ['server.js'],
      },
    ],
  });
});

it('identifies MCP servers from tool call metadata', () => {
  expect(
    kimiAcp.mcpServerOf?.({
      toolCallId: 't1',
      title: 'call',
      _meta: { is_mcp_tool_call: true, mcp: { server: 'github' } },
    })
  ).toBe('github');

  expect(
    kimiAcp.mcpServerOf?.({
      toolCallId: 't2',
      title: 'call',
      _meta: { is_mcp_tool_call: false },
    })
  ).toBeUndefined();
});

import type * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));

const servers: FakeAppServer[] = [];
const acp = { http: true };

vi.mock('node:child_process', () => ({
  spawn: () => {
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      agentCapabilities: {
        loadSession: true,
        ...(acp.http ? { mcpCapabilities: { http: true } } : {}),
      },
    }));
    server.replyAlways('authenticate', () => ({}));
    server.replyAlways('session/new', () => ({ sessionId: 'native' }));
    server.replyAlways('session/load', () => ({}));
    server.replyAlways('session/set_mode', () => ({}));
    server.replyAlways('session/set_model', () => ({}));
    servers.push(server);
    return server;
  },
}));

const { createDroidAdapter, droidAcp, DROID_LOGIN } = await import('./droid-adapter');

beforeEach(() => {
  servers.length = 0;
  acp.http = true;
});

async function setup(resume = false, env: Record<string, string> = {}) {
  const adapter = createDroidAdapter();
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

it('has the expected basic properties', () => {
  expect(droidAcp.provider).toBe('droid');
  expect(droidAcp.label).toBe('Factory Droid');
  expect(droidAcp.defaultBinary).toBe('droid');
  expect(droidAcp.loginCommand).toBe('droid login');
  expect(droidAcp.inheritEnv).toEqual(['FACTORY_API_KEY']);
  expect(droidAcp.promptCapabilities?.image).toBe(true);
  expect(droidAcp.capabilities).toEqual({
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  });
});

it('launches droid with exec and output-format acp', () => {
  const launch = droidAcp.launch({
    binaryPath: 'droid',
    cwd: '/work',
    env: { TEST_VAR: '1' },
  });
  expect(launch).toEqual({
    command: 'droid',
    args: ['exec', '--output-format', 'acp'],
    env: { TEST_VAR: '1' },
  });
});

it('checks sign-in using FACTORY_API_KEY environment variable when present', async () => {
  const result = await droidAcp.checkSignIn!({
    binaryPath: 'droid',
    cwd: '/work',
    env: { FACTORY_API_KEY: 'fk-synthetic' },
    handshake: async () => ({}),
  });
  expect(result.status).toBe('authenticated');
  expect(result.message).toContain('Factory API key');
});

it('checks sign-in using auth.v2.keyring when present', async () => {
  const result = await droidAcp.checkSignIn!({
    binaryPath: 'droid',
    cwd: '/work',
    env: { FACTORY_HOME: join(homedir(), '.factory') },
    handshake: async () => ({}),
  });
  expect(result.status).toBe('authenticated');
  expect(result.message).toBe('Signed in.');
});

it('checks sign-in via handshake when authMethods is returned', async () => {
  const result = await droidAcp.checkSignIn!({
    binaryPath: 'droid',
    cwd: '/work',
    env: { FACTORY_HOME: '/nonexistent' },
    handshake: async () => ({
      authMethods: [{ id: 'browser', name: 'Browser OAuth' }],
    }),
  });
  expect(result.status).toBe('unauthenticated');
  expect(result.message).toBe(`Sign in on the execution machine with ${DROID_LOGIN}.`);
});

it('checks sign-in via handshake when authenticated', async () => {
  const result = await droidAcp.checkSignIn!({
    binaryPath: 'droid',
    cwd: '/work',
    env: { FACTORY_HOME: '/nonexistent' },
    handshake: async () => ({
      authMethods: [],
    }),
  });
  expect(result.status).toBe('authenticated');
  expect(result.message).toBe('Signed in.');
});

it('catches auth error in handshake and returns unauthenticated', async () => {
  const result = await droidAcp.checkSignIn!({
    binaryPath: 'droid',
    cwd: '/work',
    env: { FACTORY_HOME: '/nonexistent' },
    handshake: async () => {
      throw new Error('User is unauthenticated');
    },
  });
  expect(result.status).toBe('unauthenticated');
  expect(result.message).toBe(`Sign in on the execution machine with ${DROID_LOGIN}.`);
});

it('rethrows non-auth errors during handshake', async () => {
  await expect(
    droidAcp.checkSignIn!({
      binaryPath: 'droid',
      cwd: '/work',
      env: { FACTORY_HOME: '/nonexistent' },
      handshake: async () => {
        throw new Error('Connection refused');
      },
    })
  ).rejects.toThrow('Connection refused');
});

it('starts a session and loads session on resume', async () => {
  const { server, session } = await setup(true);
  expect(session.nativeSessionId).toBe('native');
  expect(server.received.find((m) => m.method === 'session/load')?.params).toMatchObject({
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

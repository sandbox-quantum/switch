import type * as fs from 'node:fs/promises';
import { beforeEach, expect, it, vi } from 'vitest';
import { FakeAppServer } from '../codex/fake-app-server';
import { JsonRpcError } from '../transport/stdio-json-rpc';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));
const servers: FakeAppServer[] = [];
vi.mock('node:child_process', () => ({
  spawn: () => {
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: true, sse: true },
        sessionCapabilities: { resume: {} },
      },
      authMethods: [{ id: 'jetbrains-account', name: 'Junie Account' }],
    }));
    server.replyAlways('session/new', () => ({
      sessionId: 'native',
      configOptions: [
        { id: 'model', type: 'select', options: [{ value: 'mix.normal', name: 'Normal' }] },
      ],
    }));
    servers.push(server);
    return server;
  },
}));
const { junieAcp, createJunieAdapter } = await import('./junie-adapter');

beforeEach(() => {
  servers.length = 0;
});

it('runs Junie in ACP mode, skipping its own update check', () => {
  expect(junieAcp.launch({ binaryPath: '/usr/bin/junie', cwd: '/work', env: { X: '1' } })).toEqual({
    command: '/usr/bin/junie',
    args: ['--acp=true', '--skip-update-check'],
    env: { X: '1' },
  });
});

it('defines no sessionMode: brave_mode is a config option, not an ACP mode', () => {
  expect(junieAcp.sessionMode).toBeUndefined();
});

it('defines no mcpServerOf or itemType: no live tool-call data to type them from', () => {
  expect(junieAcp.mcpServerOf).toBeUndefined();
  expect(junieAcp.itemType).toBeUndefined();
});

it('defines no authMethodId: a signed-in junie needs no authenticate call', () => {
  expect(junieAcp.authMethodId).toBeUndefined();
});

it('never sends authenticate at session start', async () => {
  const adapter = createJunieAdapter();
  await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: 'approval-required',
    env: {},
    mcpServers: {},
    connectorMcpServers: [],
  });
  expect(servers.at(-1)!.received.some((m) => m.method === 'authenticate')).toBe(false);
  expect(servers.at(-1)!.received.map((m) => m.method)).toEqual(['initialize', 'session/new']);
});

it('reports signed in when session/list succeeds, without calling authenticate', async () => {
  const calls: string[] = [];
  const result = await junieAcp.checkSignIn!({
    binaryPath: '/usr/bin/junie',
    cwd: '/work',
    env: {},
    handshake: async () => ({
      authMethods: [{ id: 'jetbrains-account', name: 'Junie Account' }],
    }),
    request: async <T>(method: string): Promise<T> => {
      calls.push(method);
      if (method === 'session/list') return { sessions: [] } as T;
      throw new Error(`unexpected request: ${method}`);
    },
  });
  expect(result).toEqual({ status: 'authenticated', message: 'Signed in.', models: [] });
  expect(calls).toEqual(['session/list']);
});

it('hints to sign in when session/list refuses with Junie’s exact unauthenticated error', async () => {
  const result = await junieAcp.checkSignIn!({
    binaryPath: '/usr/bin/junie',
    cwd: '/work',
    env: {},
    handshake: async () => ({
      authMethods: [{ id: 'jetbrains-account', name: 'Junie Account' }],
    }),
    request: async () => {
      throw new JsonRpcError(
        -32000,
        'Authentication is required before this operation can be performed.'
      );
    },
  });
  expect(result.status).toBe('unauthenticated');
  expect(result.message).toBe(
    'Sign in on the execution machine by running junie and completing sign-in (a JetBrains account, or a Junie API key from junie.jetbrains.com/cli).'
  );
});

it('does not mistake an unrelated -32000 error for being signed out', async () => {
  await expect(
    junieAcp.checkSignIn!({
      binaryPath: '/usr/bin/junie',
      cwd: '/work',
      env: {},
      handshake: async () => ({ authMethods: [] }),
      request: async () => {
        throw new JsonRpcError(-32000, 'Something else went wrong.');
      },
    })
  ).rejects.toThrow('Something else went wrong.');
});

it('does not mistake a different error code for being signed out', async () => {
  await expect(
    junieAcp.checkSignIn!({
      binaryPath: '/usr/bin/junie',
      cwd: '/work',
      env: {},
      handshake: async () => ({ authMethods: [] }),
      request: async () => {
        throw new JsonRpcError(
          -32001,
          'Authentication is required before this operation can be performed.'
        );
      },
    })
  ).rejects.toThrow('Authentication is required');
});

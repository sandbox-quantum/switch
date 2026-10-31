import type * as fs from 'node:fs/promises';
import { beforeEach, expect, it, vi } from 'vitest';
import { FakeAppServer } from '../codex/fake-app-server';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));
const servers: FakeAppServer[] = [];
/** Whether the fake CLI answers `session/new` or refuses it as unauthenticated. */
let signedIn = true;
vi.mock('node:child_process', () => ({
  spawn: () => {
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      agentCapabilities: { loadSession: true },
      authMethods: [{ id: 'cline', name: 'Sign in with Cline' }],
    }));
    server.on('message', (message) => {
      if (message.method !== 'session/new' || message.id === undefined) return;
      if (signedIn) server.send({ id: message.id, result: { sessionId: 'native' } });
      else
        server.send({
          id: message.id,
          error: {
            code: -32000,
            message: 'Authentication required: Call authenticate before starting a session',
          },
        });
    });
    server.replyAlways('session/set_mode', () => ({}));
    servers.push(server);
    return server;
  },
}));
const { clineAcp, createClineAdapter } = await import('./cline-adapter');
const unusedHandshake = async () => {
  throw new Error('checkSignIn must not call the given handshake');
};

beforeEach(() => {
  servers.length = 0;
  signedIn = true;
});

it('runs cline in ACP mode with no extra flags', () => {
  expect(clineAcp.launch({ binaryPath: '/usr/bin/cline', cwd: '/work', env: { X: '1' } })).toEqual({
    command: '/usr/bin/cline',
    args: ['--acp'],
    env: { X: '1' },
  });
});

it('pins every runtime mode to Act, since Cline enforces permissions instead of modes', () => {
  for (const mode of ['approval-required', 'auto-accept-edits', 'auto', 'full-access'] as const)
    expect(clineAcp.sessionMode?.(mode)).toBe('act');
});

it('never sends authenticate at session start', async () => {
  const adapter = createClineAdapter();
  await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: 'approval-required',
    env: {},
    mcpServers: {},
    connectorMcpServers: [],
  });
  expect(servers.at(-1)!.received.some((m) => m.method === 'authenticate')).toBe(false);
});

it('trusts a given API key without starting a process', async () => {
  const result = await clineAcp.checkSignIn!({
    binaryPath: '/usr/bin/cline',
    cwd: '/work',
    env: { CLINE_API_KEY: 'sk-test' },
    handshake: unusedHandshake,
  });
  expect(result.status).toBe('authenticated');
  expect(servers).toHaveLength(0);
});

it('reports signed in from session/new, without ever calling authenticate', async () => {
  const result = await clineAcp.checkSignIn!({
    binaryPath: '/usr/bin/cline',
    cwd: '/work',
    env: {},
    handshake: unusedHandshake,
  });
  expect(result).toEqual({ status: 'authenticated', message: 'Signed in.', models: [] });
  expect(servers.at(-1)!.received.some((m) => m.method === 'authenticate')).toBe(false);
});

it('hints to sign in when session/new refuses the session as unauthenticated', async () => {
  signedIn = false;
  const result = await clineAcp.checkSignIn!({
    binaryPath: '/usr/bin/cline',
    cwd: '/work',
    env: {},
    handshake: unusedHandshake,
  });
  expect(result.status).toBe('unauthenticated');
  expect(result.message).toBe(
    'Sign in on the execution machine with cline auth, or set CLINE_PROVIDER and CLINE_API_KEY there.'
  );
});

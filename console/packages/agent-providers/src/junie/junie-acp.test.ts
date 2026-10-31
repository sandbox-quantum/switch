import type * as fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));

vi.mock('node:child_process', () => ({
  spawn: () => {
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      agentCapabilities: {
        sessionCapabilities: { resume: {} },
        mcpCapabilities: { http: true },
      },
    }));
    server.replyAlways('authenticate', () => ({}));
    server.replyAlways('session/new', () => ({
      sessionId: 'native',
      configOptions: [
        { id: 'model', type: 'select', options: [{ value: 'gpt-4o', name: 'GPT-4o' }] },
      ],
    }));
    server.replyAlways('session/resume', () => ({}));
    server.replyAlways('session/set_mode', () => ({}));
    server.replyAlways('session/set_config_option', () => ({}));
    servers.push(server);
    return server;
  },
}));

const servers: FakeAppServer[] = [];
const { junieAcp, createJunieAdapter, JUNIE_LOGIN } = await import('./junie-acp');

beforeEach(() => {
  servers.length = 0;
});
afterEach(() => {
  for (const server of servers) server.kill();
});

describe('junieAcp', () => {
  it('has the correct provider id, label, default binary, and login command', () => {
    expect(junieAcp.provider).toBe('junie');
    expect(junieAcp.label).toBe('Junie');
    expect(junieAcp.defaultBinary).toBe('junie');
    expect(junieAcp.loginCommand).toBe(JUNIE_LOGIN);
  });

  it('declares the expected capabilities', () => {
    expect(junieAcp.capabilities).toEqual({
      modelSwitchInSession: true,
      steering: false,
      resume: true,
      approvals: true,
      userInput: false,
    });
  });

  it('inherits JUNIE_API_KEY environment variable', () => {
    expect(junieAcp.inheritEnv).toContain('JUNIE_API_KEY');
  });

  it('launches with junie --acp=true', async () => {
    const launch = await Promise.resolve(
      junieAcp.launch({ binaryPath: '/path/to/junie', cwd: '/work', env: { PATH: '/bin' } })
    );
    expect(launch.command).toBe('/path/to/junie');
    expect(launch.args).toEqual(['--acp=true']);
    expect(launch.env).toEqual({ PATH: '/bin' });
  });

  describe('checkSignIn', () => {
    it('reports authenticated when JUNIE_API_KEY is provided in env', async () => {
      const handshake = vi.fn();
      const result = await junieAcp.checkSignIn?.({
        binaryPath: 'junie',
        cwd: '/work',
        env: { JUNIE_API_KEY: 'token-123' },
        handshake,
      });
      expect(result?.status).toBe('authenticated');
      expect(result?.message).toContain('Junie API key');
      expect(handshake).not.toHaveBeenCalled();
    });

    it('reports unauthenticated when handshake returns authMethods', async () => {
      const handshake = vi.fn().mockResolvedValue({
        authMethods: [{ id: 'oauth', name: 'JetBrains Account' }],
      });
      const result = await junieAcp.checkSignIn?.({
        binaryPath: 'junie',
        cwd: '/work',
        env: {},
        handshake,
      });
      expect(result?.status).toBe('unauthenticated');
      expect(result?.message).toContain(JUNIE_LOGIN);
    });

    it('reports authenticated when handshake succeeds with no authMethods', async () => {
      const handshake = vi.fn().mockResolvedValue({
        authMethods: [],
      });
      const result = await junieAcp.checkSignIn?.({
        binaryPath: 'junie',
        cwd: '/work',
        env: {},
        handshake,
      });
      expect(result?.status).toBe('authenticated');
      expect(result?.message).toContain('Signed in to Junie.');
    });

    it('reports unauthenticated when handshake throws an authentication error', async () => {
      const handshake = vi.fn().mockRejectedValue(new Error('Authentication required'));
      const result = await junieAcp.checkSignIn?.({
        binaryPath: 'junie',
        cwd: '/work',
        env: {},
        handshake,
      });
      expect(result?.status).toBe('unauthenticated');
      expect(result?.message).toContain(JUNIE_LOGIN);
    });

    it('propagates unrelated errors from handshake', async () => {
      const handshake = vi.fn().mockRejectedValue(new Error('Connection refused'));
      await expect(
        junieAcp.checkSignIn?.({
          binaryPath: 'junie',
          cwd: '/work',
          env: {},
          handshake,
        })
      ).rejects.toThrow('Connection refused');
    });
  });

  it('starts a session and resumes the native session id', async () => {
    const adapter = createJunieAdapter();
    const events: ProviderRuntimeEvent[] = [];
    adapter.subscribe((e) => events.push(e));
    const session = await adapter.startSession({
      sessionId: 's',
      cwd: '/work',
      runtimeMode: 'approval-required',
      env: {},
      mcpServers: {
        switch: {
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
          env: {},
        },
      },
      connectorMcpServers: [],
      resume: { nativeSessionId: 'native' },
    });
    expect(session.nativeSessionId).toBe('native');
    const server = servers.at(-1)!;
    const resumeMsg = server.received.find((m) => m.method === 'session/resume');
    expect(resumeMsg?.params).toMatchObject({ sessionId: 'native' });
  });
});

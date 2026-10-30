import type * as fs from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpInitializeResult } from '../acp/protocol';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';
import {
  CLINE_LOGIN,
  clineAcp,
  clineProfile,
  clineSignedIn,
  createClineAdapter,
} from './cline-adapter';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  readFile: vi.fn(),
  realpath: async (path: string) => path,
}));

const servers: FakeAppServer[] = [];
vi.mock('node:child_process', () => ({
  spawn: () => {
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { resume: {} },
        mcpCapabilities: { http: true },
      },
    }));
    server.replyAlways('session/new', () => ({
      sessionId: 'cline-native-session',
      configOptions: [
        {
          id: 'model',
          type: 'select',
          options: [{ value: 'model-cline-1', name: 'Cline Model 1' }],
        },
      ],
    }));
    server.replyAlways('session/load', () => ({}));
    server.replyAlways('session/set_mode', () => ({}));
    server.replyAlways('session/set_config_option', () => ({}));
    servers.push(server);
    return server;
  },
}));

describe('clineAcp hooks', () => {
  it('declares expected provider metadata and capabilities', () => {
    expect(clineAcp.provider).toBe('cline');
    expect(clineAcp.label).toBe('Cline CLI');
    expect(clineAcp.defaultBinary).toBe('cline');
    expect(clineAcp.loginCommand).toBe(CLINE_LOGIN);
    expect(clineAcp.inheritEnv).toEqual(['CLINE_API_KEY', 'CLINE_PROVIDER', 'CLINE_MODEL']);
    expect(clineAcp.capabilities).toEqual({
      modelSwitchInSession: true,
      steering: false,
      resume: true,
      approvals: true,
      userInput: true,
    });
    expect(clineAcp.promptCapabilities).toEqual({ image: true });
    expect(clineAcp.sessionMode?.('approval-required')).toBe('act');
    expect(clineAcp.sessionMode?.('full-access')).toBe('act');
  });

  describe('launch', () => {
    it('launches cline with --acp and passes through env', async () => {
      const launch = await clineAcp.launch({
        binaryPath: '/path/to/cline',
        cwd: '/test/cwd',
        env: { FOO: 'bar' },
      });
      expect(launch).toEqual({
        command: '/path/to/cline',
        args: ['--acp'],
        env: { FOO: 'bar' },
      });
    });
  });

  describe('clineProfile', () => {
    it('prefers CLINE_DATA_DIR from environment when set', () => {
      expect(clineProfile({ CLINE_DATA_DIR: '/custom/cline/data' })).toBe('/custom/cline/data');
    });

    it('defaults to ~/.cline/data relative to HOME', () => {
      expect(clineProfile({ HOME: '/home/user' })).toBe('/home/user/.cline/data');
    });
  });

  describe('clineSignedIn', () => {
    it('returns false when providers.json does not exist (ENOENT)', async () => {
      const fs = await import('node:fs/promises');
      vi.mocked(fs.readFile).mockRejectedValueOnce(
        Object.assign(new Error('File not found'), { code: 'ENOENT' })
      );
      expect(await clineSignedIn('/mock/cline/data')).toBe(false);
    });

    it('returns false when providers.json is invalid JSON', async () => {
      const fs = await import('node:fs/promises');
      vi.mocked(fs.readFile).mockResolvedValueOnce('invalid json');
      expect(await clineSignedIn('/mock/cline/data')).toBe(false);
    });

    it('returns false when providers.json has no credentials', async () => {
      const fs = await import('node:fs/promises');
      vi.mocked(fs.readFile).mockResolvedValueOnce(
        JSON.stringify({
          providers: {
            cline: { settings: { model: 'test' } },
            ollama: {},
          },
        })
      );
      expect(await clineSignedIn('/mock/cline/data')).toBe(false);
    });

    it('returns true when a provider has an API key', async () => {
      const fs = await import('node:fs/promises');
      vi.mocked(fs.readFile).mockResolvedValueOnce(
        JSON.stringify({
          providers: {
            anthropic: { apiKey: 'sk-ant-test' },
          },
        })
      );
      expect(await clineSignedIn('/mock/cline/data')).toBe(true);
    });

    it('returns true when a provider has OAuth account credentials', async () => {
      const fs = await import('node:fs/promises');
      vi.mocked(fs.readFile).mockResolvedValueOnce(
        JSON.stringify({
          providers: {
            cline: { auth: { accountId: 'acc_12345' } },
          },
        })
      );
      expect(await clineSignedIn('/mock/cline/data')).toBe(true);
    });

    it('returns true when a provider has settings.auth credentials from cline auth', async () => {
      const fs = await import('node:fs/promises');
      vi.mocked(fs.readFile).mockResolvedValueOnce(
        JSON.stringify({
          providers: {
            cline: {
              settings: {
                provider: 'cline',
                auth: { accessToken: 'tok_12345', accountId: 'acc_12345' },
              },
            },
          },
        })
      );
      expect(await clineSignedIn('/mock/cline/data')).toBe(true);
    });
  });

  describe('checkSignIn', () => {
    it('returns authenticated immediately when CLINE_API_KEY is present', async () => {
      const handshake = vi.fn();
      const result = await clineAcp.checkSignIn!({
        binaryPath: 'cline',
        cwd: '/work',
        env: { CLINE_API_KEY: 'test-api-key' },
        handshake,
      });
      expect(result.status).toBe('authenticated');
      expect(result.message).toContain('Cline API key');
      expect(handshake).not.toHaveBeenCalled();
    });

    it('returns authenticated when handshake succeeds and saved credentials exist', async () => {
      const fs = await import('node:fs/promises');
      vi.mocked(fs.readFile).mockResolvedValueOnce(
        JSON.stringify({
          providers: { cline: { auth: { accountId: 'acc_123' } } },
        })
      );
      const handshake = vi.fn().mockResolvedValue({} as AcpInitializeResult);
      const result = await clineAcp.checkSignIn!({
        binaryPath: 'cline',
        cwd: '/work',
        env: { HOME: '/home/user' },
        handshake,
      });
      expect(handshake).toHaveBeenCalled();
      expect(result.status).toBe('authenticated');
      expect(result.message).toBe('Signed in.');
    });

    it('returns unauthenticated with sign-in hint when no credentials exist', async () => {
      const fs = await import('node:fs/promises');
      vi.mocked(fs.readFile).mockRejectedValueOnce(
        Object.assign(new Error('File not found'), { code: 'ENOENT' })
      );
      const handshake = vi.fn().mockResolvedValue({} as AcpInitializeResult);
      const result = await clineAcp.checkSignIn!({
        binaryPath: 'cline',
        cwd: '/work',
        env: { HOME: '/home/user' },
        handshake,
      });
      expect(handshake).toHaveBeenCalled();
      expect(result.status).toBe('unauthenticated');
      expect(result.message).toContain('Sign in on the execution machine with cline auth.');
    });

    it('returns unauthenticated when handshake throws auth required error', async () => {
      const handshake = vi.fn().mockRejectedValue(new Error('Authentication required'));
      const result = await clineAcp.checkSignIn!({
        binaryPath: 'cline',
        cwd: '/work',
        env: { HOME: '/home/user' },
        handshake,
      });
      expect(result.status).toBe('unauthenticated');
      expect(result.message).toContain('cline auth');
    });

    it('rethrows unexpected handshake errors', async () => {
      const handshake = vi.fn().mockRejectedValue(new Error('ENOENT: binary not found'));
      await expect(
        clineAcp.checkSignIn!({
          binaryPath: 'cline',
          cwd: '/work',
          env: { HOME: '/home/user' },
          handshake,
        })
      ).rejects.toThrow('ENOENT: binary not found');
    });
  });

  describe('createClineAdapter integration with generic ACP adapter', () => {
    beforeEach(() => {
      servers.length = 0;
    });

    it('starts an ACP session, applies models, and runs turns', async () => {
      const adapter = createClineAdapter();
      expect(adapter.provider).toBe('cline');

      const events: ProviderRuntimeEvent[] = [];
      adapter.subscribe((e) => events.push(e));

      const session = await adapter.startSession({
        sessionId: 'session-cline-1',
        cwd: '/work',
        runtimeMode: 'approval-required',
        env: { CLINE_API_KEY: 'test-key' },
        mcpServers: {
          switch: {
            transport: 'stdio',
            command: 'node',
            args: ['server.js'],
          },
        },
        connectorMcpServers: [],
      });

      expect(session.provider).toBe('cline');
      expect(session.nativeSessionId).toBe('cline-native-session');
      expect(adapter.hasSession('session-cline-1')).toBe(true);

      const models = await adapter.listModels('session-cline-1');
      expect(models).toEqual([
        { id: 'model-cline-1', label: 'Cline Model 1', options: {}, imageInput: true },
      ]);

      const turn = await adapter.sendTurn({
        sessionId: 'session-cline-1',
        turnId: 'turn-1',
        text: 'hello cline',
      });
      expect(turn.turnId).toBe('turn-1');
    });
  });
});

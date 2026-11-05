import type * as fs from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpSignInInput } from '../acp/hooks';
import type { AcpInitializeResult } from '../acp/protocol';
import { FakeAppServer } from '../codex/fake-app-server';

const servers: FakeAppServer[] = [];
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));
vi.mock('node:child_process', () => ({
  spawn: () => {
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      agentCapabilities: { loadSession: true },
      authMethods: [{ id: 'cached_token' }, { id: 'grok.com' }],
      meta: { defaultAuthMethodId: 'cached_token' },
    }));
    server.replyAlways('authenticate', () => ({}));
    server.replyAlways('session/new', () => ({ sessionId: 'native' }));
    servers.push(server);
    return server;
  },
}));
const { grokBuildAcp, createGrokBuildAdapter } = await import('./grok-build-adapter');

beforeEach(() => {
  servers.length = 0;
});

const initialize = (result: Partial<AcpInitializeResult> = {}): AcpInitializeResult => ({
  ...result,
});

describe('Grok Build ACP hooks', () => {
  it('starts the Grok ACP command and selects its advertised auth method', () => {
    expect(grokBuildAcp.launch({ binaryPath: 'grok', cwd: '/work', env: {} })).toEqual({
      command: 'grok',
      args: ['acp'],
      env: {},
    });

    expect(
      grokBuildAcp.authMethodId?.(
        {},
        initialize({
          authMethods: [{ id: 'grok.com' }, { id: 'cached_token' }],
          meta: { defaultAuthMethodId: 'cached_token' },
        })
      )
    ).toBe('cached_token');
    expect(
      grokBuildAcp.authMethodId?.(
        {},
        initialize({
          authMethods: [{ id: 'xai.api_key' }],
          meta: { defaultAuthMethodId: 'xai.api_key' },
        })
      )
    ).toBe('xai.api_key');
    expect(grokBuildAcp.authMethodId?.({}, initialize({ authMethods: [{ id: 'grok.com' }] }))).toBe(
      'grok.com'
    );
  });

  it('authenticates with the method selected by the ACP initialize response', async () => {
    const adapter = createGrokBuildAdapter();
    await adapter.startSession({
      sessionId: 's',
      cwd: '/work',
      runtimeMode: 'approval-required',
      env: {},
      mcpServers: {},
      connectorMcpServers: [],
    });

    expect(
      servers[0]?.received.find((message) => message.method === 'authenticate')?.params
    ).toEqual({ methodId: 'cached_token' });
    await adapter.stopSession('s');
  });

  it('detects an existing sign-in without requesting authentication', async () => {
    const input: AcpSignInInput = {
      binaryPath: 'grok',
      cwd: '/work',
      env: {},
      handshake: async () =>
        initialize({
          authMethods: [{ id: 'cached_token' }, { id: 'grok.com' }],
          meta: { defaultAuthMethodId: 'cached_token' },
        }),
    };

    await expect(grokBuildAcp.checkSignIn?.(input)).resolves.toEqual({
      status: 'authenticated',
      message: 'Signed in to Grok Build.',
      models: [],
    });
  });

  it('shows the xAI sign-in command when the ACP server offers interactive auth', async () => {
    const input: AcpSignInInput = {
      binaryPath: 'grok',
      cwd: '/work',
      env: {},
      handshake: async () => initialize({ authMethods: [{ id: 'grok.com', name: 'Grok.com' }] }),
    };

    await expect(grokBuildAcp.checkSignIn?.(input)).resolves.toMatchObject({
      status: 'unauthenticated',
      message: 'Sign in on the execution machine with grok login.',
    });
  });
});

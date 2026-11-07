import type * as fs from 'node:fs/promises';
import { beforeEach, expect, it, vi } from 'vitest';
import type { AcpSignInInput } from '../acp/hooks';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));
const servers: FakeAppServer[] = [];
vi.mock('node:child_process', () => ({
  spawn: () => {
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } },
      authMethods: [{ id: 'grok.com', name: 'Sign in with Grok' }],
    }));
    server.replyAlways('authenticate', () => ({}));
    server.replyAlways('session/new', () => ({ sessionId: 'native' }));
    server.replyAlways('session/load', () => ({}));
    server.replyAlways('session/set_mode', () => ({}));
    servers.push(server);
    return server;
  },
}));
const { createGrokBuildAdapter, grokBuildAcp } = await import('./grok-build-adapter');
beforeEach(() => {
  servers.length = 0;
});
async function setup(env: Record<string, string> = {}, resume = false) {
  const adapter = createGrokBuildAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  const session = await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: 'approval-required',
    env,
    mcpServers: {},
    connectorMcpServers: [],
    ...(resume ? { resume: { nativeSessionId: 'native' } } : {}),
  });
  const server = servers.at(-1)!;
  return { adapter, events, server, session };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

it('maps Switch runtime modes to Grok permission modes, never to plan', () => {
  expect(grokBuildAcp.sessionMode?.('approval-required')).toBe('ask');
  expect(grokBuildAcp.sessionMode?.('auto-accept-edits')).toBe('default');
  expect(grokBuildAcp.sessionMode?.('auto')).toBe('default');
  expect(grokBuildAcp.sessionMode?.('full-access')).toBe('always-approve');
});

it('sends the browser login when a session starts without an API key', async () => {
  const { server } = await setup();
  await flush();
  expect(server.received.find((m) => m.method === 'authenticate')?.params).toMatchObject({
    methodId: 'grok.com',
  });
});

it('sends no authenticate when an API key signs the CLI in', async () => {
  const { server, session } = await setup({ XAI_API_KEY: '<redacted>' });
  await flush();
  expect(server.received.some((m) => m.method === 'authenticate')).toBe(false);
  expect(session.nativeSessionId).toBe('native');
});

it('resumes the exact native session', async () => {
  const { server, session } = await setup({}, true);
  expect(session.nativeSessionId).toBe('native');
  expect(server.received.find((m) => m.method === 'session/load')?.params).toMatchObject({
    sessionId: 'native',
  });
});

function signInInput(
  env: Record<string, string>,
  authMethods: Array<{ id: string }> | undefined
): AcpSignInInput {
  return {
    binaryPath: 'grok',
    cwd: '/work',
    env,
    handshake: async () => ({ protocolVersion: 1, authMethods }),
  };
}

it('answers the sign-in check from the API key, then the handshake methods', async () => {
  const withKey = await grokBuildAcp.checkSignIn!(
    signInInput({ XAI_API_KEY: '<redacted>' }, [{ id: 'grok.com' }])
  );
  expect(withKey.status).toBe('authenticated');

  const cached = await grokBuildAcp.checkSignIn!(signInInput({}, [{ id: 'cached_token' }]));
  expect(cached.status).toBe('authenticated');

  const signedOut = await grokBuildAcp.checkSignIn!(signInInput({}, [{ id: 'grok.com' }]));
  expect(signedOut.status).toBe('unauthenticated');
  expect(signedOut.message).toContain('grok login');

  const noMethods = await grokBuildAcp.checkSignIn!(signInInput({}, []));
  expect(noMethods.status).toBe('authenticated');
});

import type * as fs from 'node:fs/promises';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      authMethods: [{ id: 'login', name: 'Login with Kimi account' }],
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
const { createKimiAdapter, kimiAcp, kimiSignedIn } = await import('./kimi-adapter');
beforeEach(() => {
  servers.length = 0;
});
async function setup(env: Record<string, string> = {}, resume = false) {
  const adapter = createKimiAdapter();
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

it('maps Switch runtime modes to Kimi permission modes, never to plan', () => {
  expect(kimiAcp.sessionMode?.('approval-required')).toBe('default');
  expect(kimiAcp.sessionMode?.('auto-accept-edits')).toBe('yolo');
  expect(kimiAcp.sessionMode?.('auto')).toBe('yolo');
  expect(kimiAcp.sessionMode?.('full-access')).toBe('auto');
});

it('sends the terminal login when a session starts without an API key', async () => {
  const { server } = await setup();
  await flush();
  expect(server.received.find((m) => m.method === 'authenticate')?.params).toMatchObject({
    methodId: 'login',
  });
});

it('sends no authenticate when an API key signs the CLI in', async () => {
  const { server, session } = await setup({ MOONSHOT_API_KEY: '<redacted>' });
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

async function profileHome(withCredential: string | null): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'kimi-profile-'));
  if (withCredential !== null) {
    await mkdir(join(home, '.kimi-code', 'credentials'), { recursive: true });
    await writeFile(join(home, '.kimi-code', 'credentials', 'kimi.json'), withCredential);
  }
  return home;
}

it('reads a stored credential as a sign-in, and its absence as none', async () => {
  const profile = async (content: string | null) => join(await profileHome(content), '.kimi-code');
  expect(await kimiSignedIn(await profile('{"access_token":"token"}'))).toBe(true);
  expect(await kimiSignedIn(await profile('{"refresh_token":"token"}'))).toBe(true);
  expect(await kimiSignedIn(await profile('{"unrelated":true}'))).toBe(false);
  expect(await kimiSignedIn(await profile('not json'))).toBe(false);
  expect(await kimiSignedIn(await profile(null))).toBe(false);
});

function signInInput(
  env: Record<string, string>,
  authMethods: Array<{ id: string }> | undefined
): AcpSignInInput {
  return {
    binaryPath: 'kimi',
    cwd: '/work',
    env,
    handshake: async () => ({ protocolVersion: 1, authMethods }),
  };
}

it('answers the sign-in check from the API key, the profile, then the handshake', async () => {
  const withKey = await kimiAcp.checkSignIn!(
    signInInput({ KIMI_API_KEY: '<redacted>' }, [{ id: 'login' }])
  );
  expect(withKey.status).toBe('authenticated');

  const home = await profileHome('{"access_token":"token"}');
  const stored = await kimiAcp.checkSignIn!(signInInput({ HOME: home }, [{ id: 'login' }]));
  expect(stored.status).toBe('authenticated');

  const emptyHome = await profileHome(null);
  const signedOut = await kimiAcp.checkSignIn!(signInInput({ HOME: emptyHome }, [{ id: 'login' }]));
  expect(signedOut.status).toBe('unauthenticated');
  expect(signedOut.message).toContain('kimi login');

  const noMethods = await kimiAcp.checkSignIn!(signInInput({ HOME: emptyHome }, []));
  expect(noMethods.status).toBe('authenticated');
});

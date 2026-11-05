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
      authMethods: [{ id: 'copilot-login', name: 'Sign in with GitHub' }],
    }));
    server.replyAlways('authenticate', () => ({}));
    server.replyAlways('session/new', () => ({ sessionId: 'native' }));
    server.replyAlways('session/load', () => ({}));
    servers.push(server);
    return server;
  },
}));
const { createCopilotAdapter, copilotAcp, copilotEnvSignIn, copilotSignedIn } =
  await import('./copilot-adapter');
beforeEach(() => {
  servers.length = 0;
});
async function setup(env: Record<string, string> = {}, resume = false) {
  const adapter = createCopilotAdapter();
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

it('sends the terminal login when a session starts with no sign-in source', async () => {
  const { server } = await setup();
  await flush();
  expect(server.received.find((m) => m.method === 'authenticate')?.params).toMatchObject({
    methodId: 'copilot-login',
  });
});

it('sends no authenticate when a token signs the CLI in', async () => {
  const { server, session } = await setup({ GH_TOKEN: '<redacted>' });
  await flush();
  expect(server.received.some((m) => m.method === 'authenticate')).toBe(false);
  expect(session.nativeSessionId).toBe('native');
});

it('does not restart OAuth when the CLI has a saved login', async () => {
  const home = await copilotHome('{"loggedInUsers":[{"login":"octo"}]}');
  const { server } = await setup({ COPILOT_HOME: home });
  await flush();
  expect(server.received.some((m) => m.method === 'authenticate')).toBe(false);
});

it('resumes the exact native session', async () => {
  const { server, session } = await setup({}, true);
  expect(session.nativeSessionId).toBe('native');
  expect(server.received.find((m) => m.method === 'session/load')?.params).toMatchObject({
    sessionId: 'native',
  });
});

it('recognises token and bring-your-own-key sign-ins in the environment', () => {
  expect(copilotEnvSignIn({ COPILOT_GITHUB_TOKEN: 'x' })).toBe(true);
  expect(copilotEnvSignIn({ GITHUB_TOKEN: 'x' })).toBe(true);
  expect(copilotEnvSignIn({ COPILOT_PROVIDERS_CONFIG: '{}' })).toBe(true);
  expect(copilotEnvSignIn({ COPILOT_PROVIDER_TYPE: 'openai' })).toBe(true);
  expect(copilotEnvSignIn({ COPILOT_PROVIDER_BASE_URL: ' ' })).toBe(false);
  expect(copilotEnvSignIn({})).toBe(false);
});

async function copilotHome(config: string | null): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'copilot-home-'));
  if (config !== null) {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'config.json'), config);
  }
  return home;
}

it('reads the saved login out of the commented config file', async () => {
  const signedIn = await copilotHome('// managed\n{\n  "loggedInUsers": [{"login": "octo"}]\n}');
  expect(await copilotSignedIn({ COPILOT_HOME: signedIn })).toBe(true);
  const signedOut = await copilotHome('{\n  "firstLaunchAt": "2026-01-01"\n}');
  expect(await copilotSignedIn({ COPILOT_HOME: signedOut })).toBe(false);
  const empty = await copilotHome('{"loggedInUsers": []}');
  expect(await copilotSignedIn({ COPILOT_HOME: empty })).toBe(false);
  expect(await copilotSignedIn({ COPILOT_HOME: await copilotHome(null) })).toBe(false);
  expect(await copilotSignedIn({ COPILOT_HOME: await copilotHome('not json') })).toBe(false);
});

function signInInput(
  env: Record<string, string>,
  authMethods: Array<{ id: string }> | undefined
): AcpSignInInput {
  return {
    binaryPath: 'copilot',
    cwd: '/work',
    env,
    handshake: async () => ({ protocolVersion: 1, authMethods }),
    request: async <T>() => ({}) as T,
  };
}

it('answers the sign-in check from the environment, the saved login, then the handshake', async () => {
  const withToken = await copilotAcp.checkSignIn!(
    signInInput({ COPILOT_PROVIDER_TYPE: 'openai' }, [{ id: 'copilot-login' }])
  );
  expect(withToken.status).toBe('authenticated');

  const home = await copilotHome('{"loggedInUsers": [{"login": "octo"}]}');
  const stored = await copilotAcp.checkSignIn!(
    signInInput({ COPILOT_HOME: home }, [{ id: 'copilot-login' }])
  );
  expect(stored.status).toBe('authenticated');

  const emptyHome = await copilotHome('{}');
  const signedOut = await copilotAcp.checkSignIn!(
    signInInput({ COPILOT_HOME: emptyHome }, [{ id: 'copilot-login' }])
  );
  expect(signedOut.status).toBe('unauthenticated');
  expect(signedOut.message).toContain('copilot login');

  const noMethods = await copilotAcp.checkSignIn!(signInInput({ COPILOT_HOME: emptyHome }, []));
  expect(noMethods.status).toBe('authenticated');
});

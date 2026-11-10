import type * as fs from 'node:fs/promises';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AcpSignInInput } from '../acp/hooks';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';
import { executionEnvironment } from '../host/shared-config';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));
const servers: FakeAppServer[] = [];
const homes: string[] = [];
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
});
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

it('pre-approves only session-owned MCP servers with unambiguous Copilot permission names', async () => {
  const launch = await copilotAcp.launch({
    binaryPath: 'copilot',
    cwd: '/work',
    env: {},
    autoApprovedMcpNames: ['switch'],
  });
  expect(launch.args).toEqual(['--acp', '--stdio', '--allow-tool=switch']);
  const probe = await copilotAcp.launch({ binaryPath: 'copilot', cwd: '/work', env: {} });
  expect(probe.args).toEqual(['--acp', '--stdio']);
  for (const name of ['shell', 'write', 'read', 'memory', 'url', '*', 'switch(shell)']) {
    expect(() =>
      copilotAcp.launch({
        binaryPath: 'copilot',
        cwd: '/work',
        env: {},
        autoApprovedMcpNames: [name],
      })
    ).toThrow('cannot safely pre-approve');
  }
});

it('rejects unsupported stdio MCP servers before starting a session without its tools', () => {
  expect(() =>
    copilotAcp.launch({
      binaryPath: 'copilot',
      cwd: '/work',
      env: {},
      mcpServers: { echo: { transport: 'stdio', command: 'node', args: [] } },
    })
  ).toThrow('HTTP only');
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

it('keeps Copilot task calls typed as subagents when completion omits the input', async () => {
  const { adapter, server, events } = await setup({ GH_TOKEN: 'token' });
  await adapter.sendTurn({ sessionId: 's', turnId: 'turn', text: 'Delegate a README read' });
  server.notify('session/update', {
    sessionId: 'native',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'child',
      title: 'Read README via subagent',
      kind: 'other',
      status: 'pending',
      rawInput: { agent_type: 'task', prompt: 'Read README.md' },
    },
  });
  server.notify('session/update', {
    sessionId: 'native',
    update: { sessionUpdate: 'tool_call_update', toolCallId: 'child', status: 'completed' },
  });
  await flush();
  expect(events.filter((event) => event.type === 'item.started')).toContainEqual(
    expect.objectContaining({ item: expect.objectContaining({ id: 'child', type: 'subagent' }) })
  );
  expect(events.filter((event) => event.type === 'item.completed')).toContainEqual(
    expect.objectContaining({
      item: expect.objectContaining({ id: 'child', type: 'subagent', status: 'completed' }),
    })
  );
  await adapter.stopAll();
});

it('recognises token and bring-your-own-key sign-ins in the environment', () => {
  expect(copilotEnvSignIn({ COPILOT_GITHUB_TOKEN: 'x' })).toBe(true);
  expect(copilotEnvSignIn({ GITHUB_TOKEN: 'x' })).toBe(true);
  expect(copilotEnvSignIn({ COPILOT_PROVIDERS_CONFIG: '{}' })).toBe(false);
  expect(copilotEnvSignIn({ COPILOT_PROVIDERS_CONFIG: '{"providers": [],}' })).toBe(false);
  expect(copilotEnvSignIn({ COPILOT_PROVIDERS_CONFIG: '{not-json' })).toBe(false);
  expect(copilotEnvSignIn({ COPILOT_PROVIDER_TYPE: 'openai' })).toBe(false);
  expect(
    copilotEnvSignIn({
      COPILOT_PROVIDER_TYPE: 'openai',
      COPILOT_PROVIDER_BASE_URL: 'https://api',
      COPILOT_PROVIDER_API_KEY: 'key',
    })
  ).toBe(true);
  expect(copilotEnvSignIn({ COPILOT_PROVIDER_BASE_URL: ' ' })).toBe(false);
  expect(copilotEnvSignIn({ COPILOT_PROVIDER_BASE_URL: 'http://127.0.0.1:11434/v1' })).toBe(true);
  expect(copilotEnvSignIn({})).toBe(false);
});

it('passes inline BYOK variables to the child CLI', async () => {
  vi.stubEnv('COPILOT_PROVIDER_TYPE', 'openai');
  vi.stubEnv('COPILOT_PROVIDER_BASE_URL', 'https://api.example.test');
  vi.stubEnv('COPILOT_PROVIDER_API_KEY', 'key');
  vi.stubEnv('COPILOT_PROVIDER_BEARER_TOKEN', 'bearer');
  vi.stubEnv('COPILOT_PROVIDER_API_KEY_COMMAND', 'print-key');
  const env = await executionEnvironment(process.cwd(), {}, undefined, [
    ...(copilotAcp.inheritEnv ?? []),
  ]);
  expect(env).toMatchObject({
    COPILOT_PROVIDER_TYPE: 'openai',
    COPILOT_PROVIDER_BASE_URL: 'https://api.example.test',
    COPILOT_PROVIDER_API_KEY: 'key',
    COPILOT_PROVIDER_BEARER_TOKEN: 'bearer',
    COPILOT_PROVIDER_API_KEY_COMMAND: 'print-key',
  });
});

async function copilotHome(config: string | null): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'copilot-home-'));
  homes.push(home);
  if (config !== null) {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'config.json'), config);
  }
  return home;
}

it('reads the saved login out of the commented config file', async () => {
  const signedIn = await copilotHome('// managed\n{\n  "loggedInUsers": [{"login": "octo"}],\n}');
  expect(await copilotSignedIn({ COPILOT_HOME: signedIn })).toBe(true);
  const signedOut = await copilotHome('{\n  "firstLaunchAt": "2026-01-01"\n}');
  expect(await copilotSignedIn({ COPILOT_HOME: signedOut })).toBe(false);
  const empty = await copilotHome('{"loggedInUsers": []}');
  expect(await copilotSignedIn({ COPILOT_HOME: empty })).toBe(false);
  expect(await copilotSignedIn({ COPILOT_HOME: await copilotHome(null) })).toBe(false);
  expect(await copilotSignedIn({ COPILOT_HOME: await copilotHome('not json') })).toBe(false);
});

it('recognizes the default and overridden BYOK provider files without a saved login', async () => {
  const home = await copilotHome('{}');
  const config = JSON.stringify({
    providers: [{ name: 'local', baseUrl: 'http://127.0.0.1:11434/v1' }],
    models: [{ id: 'qwen3:8b', provider: 'local' }],
  });
  await writeFile(join(home, 'providers.json'), config);
  expect(await copilotSignedIn({ COPILOT_HOME: home })).toBe(true);
  const override = join(home, 'custom-providers.json');
  await writeFile(override, config);
  await writeFile(join(home, 'providers.json'), '{}');
  expect(await copilotSignedIn({ COPILOT_HOME: home })).toBe(false);
  expect(await copilotSignedIn({ COPILOT_HOME: home, COPILOT_PROVIDERS_CONFIG: override })).toBe(
    true
  );
  for (const invalid of ['{}', '{"providers":[]}', 'not json', '{"providers":[{}]}']) {
    await writeFile(override, invalid);
    expect(await copilotSignedIn({ COPILOT_HOME: home, COPILOT_PROVIDERS_CONFIG: override })).toBe(
      false
    );
  }
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
    signInInput(
      {
        COPILOT_PROVIDER_TYPE: 'openai',
        COPILOT_PROVIDER_BASE_URL: 'https://api',
        COPILOT_PROVIDER_API_KEY: 'key',
      },
      [{ id: 'copilot-login' }]
    )
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
  expect(noMethods.status).toBe('unknown');
});

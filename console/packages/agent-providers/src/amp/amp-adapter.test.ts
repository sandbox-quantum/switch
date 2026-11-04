import type * as fs from 'node:fs/promises';
import { beforeEach, expect, it, vi } from 'vitest';
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
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: true },
      },
    }));
    server.replyAlways('session/new', () => ({ sessionId: 'native' }));
    server.replyAlways('session/load', () => ({}));
    server.replyAlways('session/set_mode', () => ({}));
    servers.push(server);
    return server;
  },
}));

const { ampAcp, createAmpAdapter, parseAmpAccountList } = await import('./amp-adapter');

beforeEach(() => {
  servers.length = 0;
});

it('maps Switch runtime modes onto Amp permission modes', () => {
  expect(ampAcp.sessionMode?.('approval-required')).toBe('default');
  expect(ampAcp.sessionMode?.('auto-accept-edits')).toBe('bypass');
  expect(ampAcp.sessionMode?.('auto')).toBe('bypass');
  expect(ampAcp.sessionMode?.('full-access')).toBe('bypass');
});

it('parses amp account list JSON for signed-in and signed-out accounts', () => {
  expect(
    parseAmpAccountList(
      JSON.stringify({
        accounts: [{ userID: 'user_1', email: 'agent@example.com', active: true }],
      })
    )
  ).toMatchObject({ status: 'authenticated', message: 'Signed in to Amp.' });
  expect(parseAmpAccountList(JSON.stringify({ accounts: [] }))).toMatchObject({
    status: 'unauthenticated',
  });
  expect(parseAmpAccountList('not-json')).toMatchObject({ status: 'unknown' });
});

it('treats an Amp API key as signed in without probing the CLI', async () => {
  const result = await ampAcp.checkSignIn!({
    binaryPath: 'amp-acp',
    cwd: '/tmp',
    env: { AMP_API_KEY: 'amp_synthetic' },
    handshake: async () => ({ protocolVersion: 1 }),
  });
  expect(result).toMatchObject({
    status: 'authenticated',
    message: 'Signs in with the Amp API key it was given.',
  });
});

it('launches amp-acp with AMP_CLI_PATH and kills interactive setup prompts', async () => {
  const launch = await ampAcp.launch({
    binaryPath: '/usr/bin/amp-acp',
    cwd: '/work',
    env: { PATH: '/usr/bin', AMP_CLI_PATH: '/opt/amp', HOME: '/home/user' },
  });
  expect(launch).toMatchObject({
    command: '/usr/bin/amp-acp',
    args: [],
    env: expect.objectContaining({ AMP_CLI_PATH: '/opt/amp', BROWSER: 'false' }),
  });
  expect(launch.rejectOutputLine?.('Paste your AMP API key: ')).toMatch(/amp login/);
  expect(
    launch.rejectOutputLine?.(
      JSON.stringify({
        result: { authMethods: [{ description: 'configure your Amp API key' }] },
      })
    )
  ).toBeUndefined();
  expect(launch.rejectOutputLine?.('ready')).toBeUndefined();
});

it('sets Amp permission mode from the session runtime mode', async () => {
  const adapter = createAmpAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: 'full-access',
    env: {},
    mcpServers: {},
    connectorMcpServers: [],
  });
  expect(servers.at(-1)!.received.find((m) => m.method === 'session/set_mode')?.params).toEqual({
    sessionId: 'native',
    modeId: 'bypass',
  });
  expect(events.find((e) => e.type === 'session.started')).toBeTruthy();
});

it('asks in approval-required mode', async () => {
  const adapter = createAmpAdapter();
  await adapter.startSession({
    sessionId: 'ask',
    cwd: '/work',
    runtimeMode: 'approval-required',
    env: {},
    mcpServers: {},
    connectorMcpServers: [],
  });
  expect(servers.at(-1)!.received.find((m) => m.method === 'session/set_mode')?.params).toEqual({
    sessionId: 'native',
    modeId: 'default',
  });
});

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';

const servers: FakeAppServer[] = [];
const spawn = vi.fn(() => {
  const server = new FakeAppServer();
  server.replyAlways('initialize', () => ({
    agentCapabilities: { loadSession: true },
  }));
  server.replyAlways('session/new', () => ({ sessionId: 'native' }));
  server.replyAlways('session/load', () => ({ sessionId: 'native' }));
  servers.push(server);
  return server;
});
vi.mock('../provider-process', () => ({ spawnProvider: spawn, execProvider: vi.fn() }));

const { execProvider } = await import('../provider-process');
const { auggieAcp, createAuggieAdapter, parseAuggieSession } = await import('./auggie-acp');
const sessionJson = JSON.stringify({
  accessToken: 'synthetic-token',
  tenantURL: 'https://example.com',
});
const adapters: ReturnType<typeof createAuggieAdapter>[] = [];
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  vi.clearAllMocks();
  servers.length = 0;
});
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.stopSession('s');
});

async function start(runtimeMode: 'full-access' | 'approval-required' = 'approval-required') {
  const adapter = createAuggieAdapter({ binaryPath: '/opt/bin/auggie' });
  adapters.push(adapter);
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  await adapter.startSession({
    sessionId: 's',
    cwd: process.cwd(),
    runtimeMode,
    env: { AUGMENT_SESSION_AUTH: sessionJson },
    mcpServers: {},
    connectorMcpServers: [],
  });
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'run a command' });
  const server = servers.at(-1)!;
  server.send({
    id: 90,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: { toolCallId: 'shell', kind: 'execute', title: 'Run command' },
      options: [
        { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'deny', name: 'Reject', kind: 'reject_once' },
      ],
    },
  });
  await flush();
  return { adapter, events, server };
}

it('uses the selected binary and only the supplied environment, without bypass flags or authentication', async () => {
  const { server } = await start('full-access');
  expect(spawn).toHaveBeenCalledWith(
    '/opt/bin/auggie',
    ['--acp', '--allow-indexing'],
    expect.objectContaining({
      env: { AUGMENT_SESSION_AUTH: sessionJson },
    })
  );
  expect(server.received.some((m) => m.method === 'authenticate')).toBe(false);
  expect(server.received.some((m) => m.method === 'session/set_mode')).toBe(false);
});

it('auto-approves an ACP command once in full-access, without asking the user', async () => {
  const { events, server } = await start('full-access');
  expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(0);
  expect(server.received.find((m) => m.id === 90)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'once' },
  });
});

it.each(['accept', 'decline'] as const)(
  'waits for the user to %s a command in approval-required',
  async (decision) => {
    const { adapter, events, server } = await start();
    expect(server.received.find((m) => m.id === 90)).toBeUndefined();
    const request = events.find((event) => event.type === 'request.opened');
    if (request?.type !== 'request.opened') throw new Error('Missing approval');
    await adapter.respondToRequest('s', request.requestId, decision);
    await flush();
    expect(server.received.find((m) => m.id === 90)?.result).toEqual({
      outcome: { outcome: 'selected', optionId: decision === 'accept' ? 'once' : 'deny' },
    });
  }
);

it.each([
  sessionJson,
  `TOKEN=${sessionJson}`,
  `Augment authentication session:\n\nSESSION=${sessionJson}\n\nUsage for automation:`,
])('recognizes a stored session without returning its contents', (output) => {
  expect(parseAuggieSession(output)).toEqual({
    status: 'authenticated',
    message: 'Auggie has a stored authentication session.',
    models: [],
  });
});

it.each(['{}', 'null', '{"accessToken":"synthetic-token"}', 'Not logged in'])(
  'does not report missing or incomplete credentials as signed in',
  (output) => {
    expect(parseAuggieSession(output).status).toBe('unauthenticated');
    expect(parseAuggieSession(output).message).toContain('auggie login');
    expect(parseAuggieSession(output).message).not.toContain('synthetic-token');
  }
);

it('checks environment authentication without spawning a CLI or opening a browser', async () => {
  const handshake = vi.fn();
  const result = await auggieAcp.checkSignIn!({
    binaryPath: 'auggie',
    cwd: '/work',
    env: { AUGMENT_SESSION_AUTH: sessionJson },
    handshake,
  });
  expect(result.status).toBe('authenticated');
  expect(execProvider).not.toHaveBeenCalled();
  expect(handshake).not.toHaveBeenCalled();
});

it.each(['unexpected CLI output', '{broken-json'])(
  'keeps unrecognizable status output unknown without echoing it',
  (output) => {
    expect(parseAuggieSession(output).status).toBe('unknown');
    expect(parseAuggieSession(output).message).not.toContain(output);
  }
);

it('checks the local session through the read-only token command with the execution environment', async () => {
  vi.mocked(execProvider).mockResolvedValue({ stdout: `TOKEN=${sessionJson}`, stderr: '' });
  const env = { HOME: '/synthetic-home' };
  expect(
    (
      await auggieAcp.checkSignIn!({
        binaryPath: '/bin/auggie',
        cwd: '/work',
        env,
        handshake: vi.fn(),
      })
    ).status
  ).toBe('authenticated');
  expect(execProvider).toHaveBeenCalledWith(
    '/bin/auggie',
    ['token', 'print'],
    expect.objectContaining({ cwd: '/work', env, timeout: 15000 })
  );
});

it('does not leak credential-bearing exec failures into readiness', async () => {
  vi.mocked(execProvider).mockRejectedValue(
    Object.assign(new Error(sessionJson), { stdout: sessionJson, stderr: 'network unavailable' })
  );
  const result = await auggieAcp.checkSignIn!({
    binaryPath: 'auggie',
    cwd: '/work',
    env: {},
    handshake: vi.fn(),
  });
  expect(result.status).toBe('unknown');
  expect(JSON.stringify(result)).not.toContain('synthetic-token');
});

it.each(['No stored token. Run auggie login.', 'You are not currently logged in to Augment.'])(
  'shows the login hint when the CLI reports %s',
  async (stderr) => {
    vi.mocked(execProvider).mockRejectedValue({ stderr });
    const result = await auggieAcp.checkSignIn!({
      binaryPath: 'auggie',
      cwd: '/work',
      env: {},
      handshake: vi.fn(),
    });
    expect(result.status).toBe('unauthenticated');
    expect(result.message).toContain('auggie login');
  }
);

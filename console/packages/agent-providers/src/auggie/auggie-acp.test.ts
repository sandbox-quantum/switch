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
const {
  auggieAcp,
  createAuggieAdapter,
  parseAuggieSession,
  parseAuggieAccountStatus,
  AUGGIE_INDEXING_PERMISSION,
} = await import('./auggie-acp');

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

async function start(
  runtimeMode: 'full-access' | 'approval-required' = 'approval-required',
  toolCallId = 'shell'
) {
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
      toolCall: {
        toolCallId,
        kind: toolCallId === AUGGIE_INDEXING_PERMISSION ? 'other' : 'execute',
        title: toolCallId === AUGGIE_INDEXING_PERMISSION ? 'Workspace indexing' : 'Run command',
      },
      options: [
        { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'deny', name: 'Reject', kind: 'reject_once' },
      ],
    },
  });
  await flush();
  return { adapter, events, server };
}

it('launches auggie in ACP mode without bypass flags or permanent indexing args', async () => {
  const { server } = await start('full-access');
  expect(spawn).toHaveBeenCalledWith(
    '/opt/bin/auggie',
    ['--acp'],
    expect.objectContaining({
      env: { AUGMENT_SESSION_AUTH: sessionJson },
    })
  );
  expect(server.received.some((m) => m.method === 'authenticate')).toBe(false);
  expect(server.received.some((m) => m.method === 'session/set_mode')).toBe(false);
});

it('auto-approves a standard ACP tool command in full-access mode', async () => {
  const { events, server } = await start('full-access', 'shell');
  expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(0);
  expect(server.received.find((m) => m.id === 90)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'once' },
  });
});

it.each(['accept', 'decline'] as const)(
  'waits for user approval to %s a tool command in approval-required',
  async (decision) => {
    const { adapter, events, server } = await start('approval-required', 'shell');
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

it('requires explicit user confirmation for workspace indexing even in full-access', async () => {
  const { adapter, events, server } = await start('full-access', AUGGIE_INDEXING_PERMISSION);
  const request = events.find((event) => event.type === 'request.opened');
  expect(request).toBeDefined();
  if (request?.type !== 'request.opened') throw new Error('Indexing must require decision');
  expect(request.title).toBe('Workspace indexing');

  await adapter.respondToRequest('s', request.requestId, 'accept');
  await flush();
  expect(server.received.find((m) => m.id === 90)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'once' },
  });
});

it('allows declining workspace indexing session-scoped', async () => {
  const { adapter, events, server } = await start('approval-required', AUGGIE_INDEXING_PERMISSION);
  const request = events.find((event) => event.type === 'request.opened');
  if (request?.type !== 'request.opened') throw new Error('Indexing must require decision');

  await adapter.respondToRequest('s', request.requestId, 'decline');
  await flush();
  expect(server.received.find((m) => m.id === 90)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'deny' },
  });
});

it.each([
  sessionJson,
  `TOKEN=${sessionJson}`,
  `Augment authentication session:\n\nSESSION=${sessionJson}\n\nUsage for automation:`,
])('recognizes environment-supplied session JSON', (output) => {
  expect(parseAuggieSession(output)).toEqual({
    status: 'authenticated',
    message: 'Auggie has a stored authentication session.',
    models: [],
  });
});

it('verifies authentication using auggie account status --json when signed in', async () => {
  vi.mocked(execProvider).mockResolvedValue({
    stdout: JSON.stringify({ email: 'user@example.com', credits: 100 }),
    stderr: '',
  });
  const env = { HOME: '/synthetic-home' };
  const res = await auggieAcp.checkSignIn!({
    binaryPath: '/bin/auggie',
    cwd: '/work',
    env,
    handshake: vi.fn(),
  });
  expect(res.status).toBe('authenticated');
  expect(execProvider).toHaveBeenCalledWith(
    '/bin/auggie',
    ['account', 'status', '--json'],
    expect.objectContaining({ cwd: '/work', env, timeout: 15000 })
  );
});

it.each([
  {
    exitCode: 1,
    stdout: '',
    stderr: 'You are not currently logged in to Augment. Run auggie login.',
  },
  { exitCode: 1, stdout: '', stderr: 'Authentication required: run `auggie login`.' },
  { exitCode: 1, stdout: 'no stored session', stderr: '' },
])('reports unauthenticated when account status reports not logged in (%s)', (result) => {
  const status = parseAuggieAccountStatus(result);
  expect(status.status).toBe('unauthenticated');
  expect(status.message).toContain('auggie login');
});

it('reports unknown for network / unexpected account status errors', () => {
  const status = parseAuggieAccountStatus({
    exitCode: 2,
    stdout: '',
    stderr: 'API server unreachable (ECONNREFUSED)',
  });
  expect(status.status).toBe('unknown');
});

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

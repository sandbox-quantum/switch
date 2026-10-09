import { beforeEach, expect, it, vi } from 'vitest';

type Request = { type: string; command?: { commandId: string; body: unknown } };

const mocks = vi.hoisted(() => ({
  local: { request: vi.fn(), subscribe: vi.fn() },
  sidecar: { request: vi.fn() },
  withSidecar: vi.fn(),
  sshHost: null as string | null,
  hydrate: vi.fn(async () => {}),
}));
const { Unavailable, HostFailed } = vi.hoisted(() => ({
  Unavailable: class extends Error {},
  HostFailed: class extends Error {},
}));
vi.mock('@switch-console/agent-providers', () => ({
  SessionUnavailableError: Unavailable,
  SessionHostFailedError: HostFailed,
  sharedSessionRoot: (id: string) => `/roots/${id}`,
  liveSupervisor: async () => ({ build: 'b' }),
}));
vi.mock('@switch-console/shared/session-v1', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  snapshotSchema: { parse: (value: unknown) => value },
  commandStatusSchema: { parse: (value: unknown) => value },
}));
vi.mock('@main/core/agents/getAgentById', () => ({
  getAgentById: async () => ({ switchAgentId: 'switch-agent', serverId: 'server' }),
}));
vi.mock('@main/core/agents/agent-location', () => ({
  getAgentLocation: async () => ({ sshHost: mocks.sshHost }),
}));
vi.mock('@main/core/sessions/operations/hydrateSession', () => ({
  hydrateSession: mocks.hydrate,
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('./local-host', () => ({ localSessionLinks: mocks.local }));
vi.mock('./sidecar-control', () => ({ withSidecar: mocks.withSidecar }));
vi.mock('./session-activity', () => ({ syncSdkSessionActivity: vi.fn(async () => {}) }));
vi.mock('./host-journal', () => ({
  JournalUnavailableError: class extends Error {},
  JournalTail: class {},
  hostJournals: { tail: vi.fn() },
}));

const { stopSharedSession } = await import('./stop-shared-session');

function snapshot(session: Record<string, unknown>, commandStatuses: unknown[]) {
  return {
    session: { status: 'ready', connectivity: 'online', epoch: 'epoch-1', ...session },
    commandStatuses,
  };
}

function receipt(status: string, message: string | null = null) {
  return { type: 'command.status', commandId: 'stop-epoch-1', status, code: null, message };
}

/**
 * A session host answering snapshots with `session` and recording each stop
 * it is sent; `statuses` are what successive snapshots after the stop report.
 */
function host(session: Record<string, unknown>, statuses: unknown[][]) {
  let stopped = 0;
  return vi.fn(async (...args: unknown[]) => {
    const request = args.find((arg): arg is Request => typeof arg === 'object' && arg !== null)!;
    if (request.type === 'command') {
      stopped += 1;
      return receipt('accepted');
    }
    if (stopped === 0) return snapshot(session, []);
    return snapshot(session, statuses.length > 1 ? statuses.shift()! : statuses[0]!);
  });
}

function commandsSent(request: ReturnType<typeof vi.fn>): Request[] {
  return request.mock.calls
    .map((call) => call.find((arg): arg is Request => typeof arg === 'object' && arg !== null)!)
    .filter((request) => request.type === 'command');
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sshHost = null;
  mocks.withSidecar.mockImplementation(
    async (_agentId: string, call: (client: unknown) => unknown) => call(mocks.sidecar)
  );
});

it('stops a running local session through its host and waits for it to say so', async () => {
  mocks.local.request.mockImplementation(host({}, [[], [receipt('applied')]]));
  await stopSharedSession('agent', 'session-1');
  expect(commandsSent(mocks.local.request)).toEqual([
    expect.objectContaining({
      command: expect.objectContaining({
        commandId: 'stop-epoch-1',
        body: { type: 'session.stop' },
      }),
    }),
  ]);
  expect(mocks.local.request.mock.calls.every((call) => call[0] === '/roots/session-1')).toBe(true);
  expect(mocks.withSidecar).not.toHaveBeenCalled();
});

it('stops a remote session through the agent sidecar', async () => {
  mocks.sshHost = 'box';
  mocks.sidecar.request.mockImplementation(host({}, [[receipt('applied')]]));
  await stopSharedSession('agent', 'session-1');
  expect(commandsSent(mocks.sidecar.request)).toHaveLength(1);
  expect(mocks.sidecar.request.mock.calls.every((call) => call[0] === 'session-1')).toBe(true);
  expect(mocks.local.request).not.toHaveBeenCalled();
});

it('sends nothing to a host that is not online', async () => {
  mocks.local.request.mockImplementation(host({ connectivity: 'offline' }, [[]]));
  await stopSharedSession('agent', 'session-1');
  expect(commandsSent(mocks.local.request)).toEqual([]);
});

it('sends nothing for a session that has already stopped', async () => {
  mocks.local.request.mockImplementation(host({ status: 'stopped' }, [[]]));
  await stopSharedSession('agent', 'session-1');
  expect(commandsSent(mocks.local.request)).toEqual([]);
});

it('sends nothing and starts nothing when no host is running the session', async () => {
  mocks.local.request.mockRejectedValue(new Unavailable('The session host is not running.'));
  await stopSharedSession('agent', 'session-1');
  expect(mocks.local.request).toHaveBeenCalledTimes(1);
  expect(mocks.hydrate).not.toHaveBeenCalled();
});

it('fails when the agent sidecar cannot be reached', async () => {
  mocks.sshHost = 'box';
  mocks.withSidecar.mockRejectedValue(new Error('ssh: connect to host box: Connection refused'));
  await expect(stopSharedSession('agent', 'session-1')).rejects.toThrow('Connection refused');
});

it('fails when the host refuses the stop', async () => {
  mocks.local.request.mockImplementation(host({}, [[receipt('rejected', 'Busy resetting')]]));
  await expect(stopSharedSession('agent', 'session-1')).rejects.toThrow('Busy resetting');
});

it('fails when the host cannot say whether the stop happened', async () => {
  mocks.local.request.mockImplementation(host({}, [[receipt('unknown')]]));
  await expect(stopSharedSession('agent', 'session-1')).rejects.toThrow('Stop unknown.');
});

it('treats a session whose host failed to start as having nothing to stop', async () => {
  mocks.local.request.mockRejectedValue(new HostFailed('Sign in with claude auth login.'));
  await expect(stopSharedSession('agent', 'session')).resolves.toBeUndefined();
  expect(mocks.local.request.mock.calls.every(([, request]) => request.type !== 'command')).toBe(
    true
  );
});

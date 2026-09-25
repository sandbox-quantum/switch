import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  local: { request: vi.fn() },
  sidecar: { request: vi.fn() },
  sshHost: null as string | null,
  running: true,
  hydrate: vi.fn(async () => {}),
  cloud: { request: vi.fn() },
  cloudOperation: vi.fn(async () => ({ state: 'applied' })),
}));
const { Unavailable, Failed } = vi.hoisted(() => ({
  Unavailable: class extends Error {},
  Failed: class extends Error {},
}));
vi.mock('@switch-console/agent-providers', () => ({
  SessionUnavailableError: Unavailable,
  SessionHostFailedError: Failed,
  sharedSessionRoot: (id: string) => `/roots/${id}`,
  liveSupervisor: async () => (mocks.running ? { build: 'b' } : null),
}));
vi.mock('@main/core/agents/getAgentById', () => ({
  getAgentById: async () => ({ switchAgentId: 'switch-agent', serverId: 'server' }),
}));
vi.mock('@main/core/agents/agent-location', () => ({
  getAgentLocation: async () => ({ sshHost: mocks.sshHost }),
}));
vi.mock('./local-host', () => ({ localSessionLinks: mocks.local }));
vi.mock('./cloud-control', () => ({
  isCloudAgent: (agentId: string) => agentId.startsWith('cloud:'),
  cloudControl: async () => mocks.cloud,
  runCloudSessionOperation: mocks.cloudOperation,
}));
vi.mock('./sidecar-control', () => ({
  withSidecar: async (_agentId: string, call: (client: unknown) => unknown) => call(mocks.sidecar),
}));
vi.mock('@main/core/sessions/operations/hydrateSession', () => ({
  hydrateSession: mocks.hydrate,
}));

const { reconcileSessionCommand, submitSessionCommand } = await import('./session-commands');

const command = {
  contractVersion: 1 as const,
  commandId: 'command-1',
  sessionId: 'session',
  epoch: 'epoch',
  body: { type: 'turn.interrupt' as const, turnId: 'turn' },
};
const applied = {
  type: 'command.status' as const,
  commandId: 'command-1',
  status: 'applied' as const,
  code: null,
  message: null,
};
const snapshot = (statuses: unknown[]) => ({
  contractVersion: 1,
  throughSequence: 1,
  session: {
    sessionId: 'session',
    agentId: 'switch-agent',
    hostId: 'host',
    epoch: 'epoch',
    provider: 'claude',
    status: 'ready',
    connectivity: 'online',
    pendingRequestIds: [],
    capabilities: {
      input: 'queue',
      approvals: true,
      questions: true,
      interrupt: true,
      reset: false,
      compact: false,
      modelChange: false,
      attachmentMimeTypes: [],
    },
  },
  turns: [],
  items: [],
  requests: [],
  commandStatuses: statuses,
  nextPageToken: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sshHost = null;
  mocks.running = true;
});

it('sends a local command straight to its host and returns what it recorded', async () => {
  mocks.local.request.mockResolvedValue(applied);
  expect(await submitSessionCommand('agent', command)).toEqual(applied);
  const [root, request, wait] = mocks.local.request.mock.calls[0]!;
  expect(root).toBe('/roots/session');
  expect(request).toMatchObject({
    type: 'command',
    command: { commandId: 'command-1', origin: { surface: 'console' } },
  });
  expect(wait).toBeGreaterThan(0);
});

it('does not wait for a local host nothing is running', async () => {
  mocks.running = false;
  mocks.local.request.mockResolvedValue(applied);
  await submitSessionCommand('agent', command);
  expect(mocks.local.request.mock.calls[0]![2]).toBe(0);
});

it('sends a remote command through the agent sidecar', async () => {
  mocks.sshHost = 'box';
  mocks.sidecar.request.mockResolvedValue(applied);
  expect(await submitSessionCommand('agent', command)).toEqual(applied);
  expect(mocks.sidecar.request).toHaveBeenCalledWith(
    'session',
    expect.objectContaining({ type: 'command' })
  );
  expect(mocks.local.request).not.toHaveBeenCalled();
});

it('reconciles from the host record, sending again only if it never arrived', async () => {
  mocks.local.request.mockResolvedValueOnce(snapshot([applied]));
  expect(await reconcileSessionCommand('agent', command)).toEqual(applied);
  expect(mocks.local.request).toHaveBeenCalledTimes(1);

  mocks.local.request.mockResolvedValueOnce(snapshot([])).mockResolvedValueOnce(applied);
  expect(await reconcileSessionCommand('agent', command)).toEqual(applied);
  expect(mocks.local.request.mock.calls.at(-1)![1]).toMatchObject({ type: 'command' });
});

it('starts a parked session again and then sends the command', async () => {
  mocks.local.request
    .mockRejectedValueOnce(new Unavailable('The session host is not running.'))
    .mockResolvedValueOnce(applied);
  expect(await submitSessionCommand('agent', command)).toEqual(applied);
  expect(mocks.hydrate).toHaveBeenCalledWith('session');
  expect(mocks.local.request).toHaveBeenCalledTimes(2);
});

it('starts a session whose host failed again when the user sends it something', async () => {
  mocks.local.request
    .mockRejectedValueOnce(new Failed('Sign in on the execution machine with claude auth login.'))
    .mockResolvedValueOnce(applied);
  expect(await submitSessionCommand('agent', command)).toEqual(applied);
  expect(mocks.hydrate).toHaveBeenCalledWith('session');
});

it('sends a cloud command through the relay and restarts a parked cloud session there', async () => {
  mocks.cloud.request
    .mockRejectedValueOnce(new Unavailable('The session host is not running.'))
    .mockResolvedValueOnce(applied);
  expect(await submitSessionCommand('cloud:server:launch', command)).toEqual(applied);
  expect(mocks.cloud.request).toHaveBeenCalledWith(
    'session',
    expect.objectContaining({ type: 'command' })
  );
  expect(mocks.cloudOperation).toHaveBeenCalledWith(
    'cloud:server:launch',
    'session',
    expect.any(String),
    'restart'
  );
  expect(mocks.hydrate).not.toHaveBeenCalled();
  expect(mocks.local.request).not.toHaveBeenCalled();
});

import { beforeEach, expect, it, vi } from 'vitest';
import type { LocationTransport } from '@main/core/locations/location-transport';
import type { Session } from '@shared/core/sessions/sessions';

const mocks = vi.hoisted(() => ({
  agent: vi.fn(),
  server: vi.fn(),
  snapshot: vi.fn(),
  commandStatus: vi.fn(),
  submit: vi.fn(),
  persist: vi.fn(),
  loadSession: vi.fn(),
  runHost: vi.fn(),
  exec: vi.fn(),
}));

class FakeGatewayError extends Error {
  constructor(
    readonly kind: string,
    message: string,
    readonly status?: number
  ) {
    super(message);
  }
}

vi.mock('@switch-console/shared/session-v1', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  snapshotSchema: { parse: (value: unknown) => value },
  commandStatusSchema: { parse: (value: unknown) => value },
}));
vi.mock('@main/core/agents/getAgentById', () => ({ getAgentById: mocks.agent }));
vi.mock('@main/core/switch-servers/servers-store', () => ({ getServer: mocks.server }));
vi.mock('@main/core/switch-servers/gateway-client', () => ({
  GatewayError: FakeGatewayError,
  fetchSdkSnapshot: mocks.snapshot,
  fetchSdkCommandStatus: mocks.commandStatus,
  submitSdkCommand: mocks.submit,
}));
vi.mock('@main/core/sessions/session-join', () => ({ loadSessionWithAgent: mocks.loadSession }));
vi.mock('@main/core/sessions/operations/set-initial-prompt-delivery', () => ({
  setInitialPromptDelivery: mocks.persist,
}));
vi.mock('./shared-host-deployment', () => ({
  deploySharedHost: vi.fn(async () => ({
    ctx: { exec: mocks.exec },
    root: '/tmp/host',
    entrypoint: 'run.mjs',
  })),
  runSharedHostCommand: mocks.runHost,
}));
vi.mock('./stop-shared-session', () => ({ stopSharedSession: vi.fn() }));
vi.mock('@main/core/switch-rooms/switch-notification-poller', () => ({
  switchNotificationPoller: {
    getSharedIntent: () => ({ rooms: [] }),
    clearSharedIntent: vi.fn(),
  },
}));
vi.mock('@main/core/switch-rooms/switch-room-service', () => ({
  switchRoomService: { setSessionRoom: vi.fn(), restoreConnection: vi.fn() },
}));
vi.mock('@main/core/agent-runtime/impl/provider-adapter-registry', () => ({
  providerAdapterRegistry: {
    supports: () => true,
    get: () => ({ capabilities: { approvals: true, userInput: true } }),
  },
}));
vi.mock('@main/core/agents/agent-launch-config', () => ({
  agentLaunchSpecialization: async () => ({}),
}));
vi.mock('@main/core/dependencies/host-dependency-store', () => ({
  hostDependencyStore: { getSelection: async () => undefined },
}));
vi.mock('@main/core/providers/plugin-registry', () => ({ getPlugin: () => ({ behavior: {} }) }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn() } }));

const { SharedAgentRuntime } = await import('./shared-agent-runtime');

const session = {
  id: 'session-1',
  agentId: 'agent-1',
  providerId: 'claude',
  agentName: 'scout',
} as Session;

function runtime() {
  return new SharedAgentRuntime({ kind: 'local' } as LocationTransport, {
    sessionId: session.id,
    sessionPath: '/work',
    sessionEnvVars: {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.agent.mockResolvedValue({
    id: 'agent-1',
    name: 'scout',
    switchAgentId: 'remote-agent',
    serverId: 'server-1',
  });
  mocks.server.mockResolvedValue({ id: 'server-1' });
  mocks.exec.mockResolvedValue({ stdout: 'null' });
  // The launch reports an existing host, which is what a retry after a failed
  // first `open()` sees.
  mocks.runHost.mockResolvedValue({ stdout: JSON.stringify({ created: false }) });
  mocks.snapshot.mockResolvedValue({
    session: { epoch: 'epoch-2', connectivity: 'online', status: 'ready' },
    turns: [],
    items: [],
  });
  mocks.loadSession.mockResolvedValue({
    row: { config: { initialPrompt: 'Say hello' } },
    providerId: 'claude',
    name: 'scout',
  });
  mocks.commandStatus.mockRejectedValue(
    new FakeGatewayError(
      'http',
      'Switch gateway returned 404: {"code":"NOT_FOUND","message":"No such command"}',
      404
    )
  );
  mocks.submit.mockResolvedValue({
    type: 'command.status',
    commandId: 'minted',
    status: 'accepted',
    code: null,
    message: null,
  });
});

it('delivers the initial prompt on a relaunch that did not create the host', async () => {
  await runtime().start(session, undefined, false, 'Say hello');

  expect(mocks.submit).toHaveBeenCalledTimes(1);
  expect(mocks.submit.mock.calls[0][1]).toMatchObject({
    sessionId: 'session-1',
    epoch: 'epoch-2',
    body: { type: 'message.send', text: 'Say hello', delivery: 'queue' },
  });
  expect(mocks.persist.mock.calls.map((call) => call[1].state)).toEqual(['pending', 'submitted']);
});

it('accepts a host that awaits an explicit reset decision and holds the initial prompt', async () => {
  mocks.snapshot.mockResolvedValue({
    session: {
      epoch: 'epoch-2',
      connectivity: 'online',
      status: 'error',
      capabilities: { reset: true },
    },
    turns: [],
    requests: [],
    items: [],
  });

  await runtime().start(session, undefined, false, 'Say hello');

  expect(mocks.submit).not.toHaveBeenCalled();
  expect(mocks.persist).not.toHaveBeenCalled();
});

it('does not resend a prompt the server already holds', async () => {
  mocks.loadSession.mockResolvedValue({
    row: {
      config: {
        initialPrompt: 'Say hello',
        initialPromptDelivery: { commandId: 'attempt-1', state: 'pending' },
      },
    },
    providerId: 'claude',
    name: 'scout',
  });
  mocks.commandStatus.mockResolvedValue({
    type: 'command.status',
    commandId: 'attempt-1',
    status: 'applied',
    code: null,
    message: null,
  });

  await runtime().start(session, undefined, false, 'Say hello');

  expect(mocks.submit).not.toHaveBeenCalled();
  expect(mocks.persist).toHaveBeenCalledWith('session-1', {
    commandId: 'attempt-1',
    state: 'submitted',
  });
});

it('treats a 404 that names another code as an uncertain lookup', async () => {
  mocks.commandStatus.mockRejectedValue(
    new FakeGatewayError(
      'http',
      'Switch gateway returned 404: {"code":"NOT_AUTHORIZED","message":"No"}',
      404
    )
  );

  await runtime().start(session, undefined, false, 'Say hello');

  expect(mocks.submit).not.toHaveBeenCalled();
  expect(mocks.persist).toHaveBeenCalledTimes(1);
  expect(mocks.persist.mock.calls[0][1]).toMatchObject({
    commandId: 'initial-session-1',
    state: 'unknown',
  });
});

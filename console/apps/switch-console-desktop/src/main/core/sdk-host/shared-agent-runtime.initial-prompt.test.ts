import { beforeEach, expect, it, vi } from 'vitest';
import type { LocationTransport } from '@main/core/locations/location-transport';
import type { Session } from '@shared/core/sessions/sessions';

const mocks = vi.hoisted(() => ({
  agent: vi.fn(),
  persistedRoom: vi.fn(),
  server: vi.fn(),
  snapshot: vi.fn(),
  commandStatus: vi.fn(),
  submit: vi.fn(),
  persist: vi.fn(),
  loadSession: vi.fn(),
  runHost: vi.fn(),
  readFailure: vi.fn(),
  exec: vi.fn(),
  specialization: vi.fn(),
  ready: vi.fn(),
}));

vi.mock('@main/core/managed-switch-server/session-readiness', () => ({
  ensureServerSessionReady: mocks.ready,
}));

vi.mock('./transcripts', () => ({ currentSnapshot: mocks.snapshot }));
vi.mock('./host-journal', () => ({ JournalUnavailableError: class extends Error {} }));
vi.mock('./sidecar-control', () => ({ withSidecar: vi.fn() }));
vi.mock('@switch-console/shared/session-v1', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  snapshotSchema: { parse: (value: unknown) => value },
  commandStatusSchema: { parse: (value: unknown) => value },
}));
vi.mock('@main/core/switch-rooms/session-room-store', () => ({
  getPersistedRoomConnection: mocks.persistedRoom,
}));
vi.mock('@main/core/agents/getAgentById', () => ({ getAgentById: mocks.agent }));
vi.mock('@main/core/switch-servers/servers-store', () => ({ getServer: mocks.server }));
class FakeNotRecorded extends Error {}
vi.mock('./session-commands', () => ({
  CommandNotRecordedError: FakeNotRecorded,
  sessionCommandStatus: mocks.commandStatus,
  submitSessionCommand: mocks.submit,
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
  runSharedHostCommand: vi.fn(),
}));
vi.mock('./local-host', () => ({
  startLocalSession: mocks.runHost,
  readLocalHostFailure: mocks.readFailure,
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
  agentLaunchSpecialization: mocks.specialization,
}));
vi.mock('@main/core/dependencies/host-dependency-store', () => ({
  hostDependencyStore: { getSelection: async () => undefined },
}));
vi.mock('@main/core/providers/plugin-registry', () => ({ getPlugin: () => ({ behavior: {} }) }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn() } }));

const { SharedAgentRuntime, buildSharedHostConfig } = await import('./shared-agent-runtime');

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
  mocks.persistedRoom.mockResolvedValue(null);
  vi.clearAllMocks();
  mocks.specialization.mockResolvedValue({});
  mocks.agent.mockResolvedValue({
    id: 'agent-1',
    name: 'scout',
    switchAgentId: 'remote-agent',
    serverId: 'server-1',
  });
  mocks.server.mockResolvedValue({ id: 'server-1' });
  mocks.ready.mockResolvedValue(undefined);
  mocks.exec.mockResolvedValue({ stdout: 'null' });
  mocks.readFailure.mockResolvedValue(null);
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
  mocks.commandStatus.mockRejectedValue(new FakeNotRecorded('No such command'));
  mocks.submit.mockResolvedValue({
    type: 'command.status',
    commandId: 'minted',
    status: 'accepted',
    code: null,
    message: null,
  });
});

it('delivers the initial prompt on a relaunch that did not create the host', async () => {
  await runtime().start(session, false, 'Say hello');

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

  await runtime().start(session, false, 'Say hello');

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

  await runtime().start(session, false, 'Say hello');

  expect(mocks.submit).not.toHaveBeenCalled();
  expect(mocks.persist).toHaveBeenCalledWith('session-1', {
    commandId: 'attempt-1',
    state: 'submitted',
  });
});

it('treats a lookup that fails for another reason as uncertain', async () => {
  mocks.commandStatus.mockRejectedValue(new Error('The session journal reader stopped.'));

  await runtime().start(session, false, 'Say hello');

  expect(mocks.submit).not.toHaveBeenCalled();
  expect(mocks.persist).toHaveBeenCalledTimes(1);
  expect(mocks.persist.mock.calls[0][1]).toMatchObject({
    commandId: 'initial-session-1',
    state: 'unknown',
  });
});

it.each([false, true])(
  'launches with current bypass settings despite a saved override (%s)',
  async (enabled) => {
    const savedSession = { ...session, autoApprove: !enabled };
    mocks.agent.mockResolvedValue({
      id: 'agent-1',
      name: 'scout',
      switchAgentId: 'remote-agent',
      autoApprove: enabled,
    });
    const config = await buildSharedHostConfig(
      savedSession,
      { sessionPath: '/work', sessionEnvVars: {} },
      { kind: 'local' } as LocationTransport
    );
    expect(config.start.input.runtimeMode).toBe(enabled ? 'full-access' : 'approval-required');
  }
);

it('reads updated model, effort and instructions for each launch', async () => {
  mocks.specialization
    .mockResolvedValueOnce({
      model: 'first-model',
      effort: 'low',
      instructions: 'First instructions',
    })
    .mockResolvedValueOnce({
      model: 'second-model',
      effort: 'high',
      instructions: 'Updated instructions',
    });
  const launch = () =>
    buildSharedHostConfig(session, { sessionPath: '/work', sessionEnvVars: {} }, {
      kind: 'local',
    } as LocationTransport);
  const first = await launch();
  const second = await launch();
  expect(first.start.input.model).toEqual({ id: 'first-model', options: { effort: 'low' } });
  expect(second.start.input.model).toEqual({ id: 'second-model', options: { effort: 'high' } });
  expect(second.execution?.context).toContain('Updated instructions');
  expect(second.execution?.context).not.toContain('First instructions');
});

it('opens the session while auth is pending and submits the initial prompt only after readiness', async () => {
  let ready = false;
  mocks.snapshot.mockImplementation(async () => ({
    session: { epoch: 'epoch-2', connectivity: 'online', status: ready ? 'ready' : 'starting' },
    turns: [],
    items: [],
  }));
  const agent = runtime();
  await agent.start(session, false, 'Say hello');
  expect(agent.startupStatus().status).toBe('starting');
  expect(mocks.submit).not.toHaveBeenCalled();
  await agent.start(session, false, 'Say hello');
  expect(mocks.runHost).toHaveBeenCalledTimes(1);
  ready = true;
  await vi.waitFor(() => expect(agent.startupStatus().status).toBe('ready'));
  expect(mocks.submit).toHaveBeenCalledTimes(1);
});

it('keeps a background authentication failure visible without sending the first prompt', async () => {
  mocks.snapshot.mockResolvedValue({
    session: { epoch: 'epoch-2', connectivity: 'online', status: 'starting' },
    turns: [],
    items: [],
  });
  mocks.readFailure
    .mockResolvedValueOnce(null)
    .mockResolvedValue({ message: 'Sign in to the provider.' });
  const agent = runtime();
  await agent.start(session, false, 'Say hello');
  await vi.waitFor(
    () =>
      expect(agent.startupStatus()).toEqual({
        status: 'error',
        message: 'Shared SDK host failed: Sign in to the provider.',
      }),
    { timeout: 3500 }
  );
  expect(mocks.submit).not.toHaveBeenCalled();
  await expect(agent.stop()).resolves.toBeUndefined();
});

it('still rejects deployment failures before a host connects', async () => {
  mocks.runHost.mockRejectedValueOnce(new Error('Could not deploy host.'));
  const agent = runtime();
  await expect(agent.start(session)).rejects.toThrow('Could not deploy host.');
  expect(agent.startupStatus().message).toBe('Could not deploy host.');
  expect(mocks.submit).not.toHaveBeenCalled();
});

it('reports restart progress through host replacement and authentication until ready', async () => {
  let release!: () => void;
  mocks.runHost.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      })
  );
  mocks.loadSession.mockResolvedValue({ serverId: 'server-1', row: { config: {} } });
  mocks.snapshot
    .mockResolvedValueOnce({
      session: { epoch: 'old', connectivity: 'online', status: 'ready' },
      turns: [],
      items: [],
    })
    .mockResolvedValue({
      session: { epoch: 'new', connectivity: 'online', status: 'starting' },
      turns: [],
      items: [],
    });
  const agent = runtime();
  const pending = agent.restart(session);
  await vi.waitFor(() => expect(mocks.runHost).toHaveBeenCalled());
  expect(agent.startupStatus()).toEqual({
    status: 'starting',
    message: 'Stopping the previous process and starting its replacement…',
  });
  release();
  await vi.waitFor(() =>
    expect(agent.startupStatus().message).toBe(
      'Initializing the provider and checking authentication…'
    )
  );
  mocks.snapshot.mockResolvedValue({
    session: { epoch: 'new', connectivity: 'online', status: 'ready' },
    turns: [],
    items: [],
  });
  await pending;
  expect(agent.startupStatus()).toEqual({ status: 'ready', message: null });
  expect(mocks.submit).not.toHaveBeenCalled();
});

it('passes the existing conversation room as a guarded migration hint', async () => {
  mocks.persistedRoom.mockResolvedValue({ roomId: 'saved-room', switchAgentId: 'switch-agent' });
  mocks.agent.mockResolvedValue({
    id: 'agent-1',
    switchAgentId: 'switch-agent',
    providerId: 'claude',
  });
  const config = await buildSharedHostConfig(
    session,
    { sessionPath: '/work', sessionEnvVars: {} },
    { kind: 'local' } as LocationTransport
  );
  expect(config.roomConnection?.restoreRoomId).toBe('saved-room');
  mocks.persistedRoom.mockResolvedValue({ roomId: 'saved-room', switchAgentId: 'other-agent' });
  const other = await buildSharedHostConfig(session, { sessionPath: '/work', sessionEnvVars: {} }, {
    kind: 'local',
  } as LocationTransport);
  expect(other.roomConnection?.restoreRoomId).toBeUndefined();
});

it('never starts a host or replays the initial prompt while the server is not ready', async () => {
  mocks.ready.mockRejectedValueOnce(new Error('Updating Local from switch-core 0.1.0 failed'));
  const agent = runtime();

  await expect(agent.start(session, false, 'Do work')).rejects.toThrow('failed');
  expect(mocks.ready).toHaveBeenCalledWith({ id: 'server-1' });
  expect(mocks.runHost).not.toHaveBeenCalled();
  expect(mocks.submit).not.toHaveBeenCalled();
  expect(agent.startupStatus()).toMatchObject({ status: 'error' });
});

it('waits for the server’s update before starting the session', async () => {
  let ready: () => void = () => {};
  mocks.ready.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      ready = resolve;
    })
  );
  const agent = runtime();
  const started = agent.start(session, false, 'Say hello');

  await vi.waitFor(() => expect(mocks.ready).toHaveBeenCalled());
  expect(agent.startupStatus()).toEqual({
    status: 'starting',
    message: 'Waiting for the Switch server to be ready…',
  });
  expect(mocks.runHost).not.toHaveBeenCalled();
  ready();
  await started;
  expect(mocks.submit).toHaveBeenCalledTimes(1);
});

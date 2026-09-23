import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { remoteSessionReconciler } from './remote-session-reconciler';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  server: vi.fn(async () => ({ id: 'server', gatewayUrl: 'https://example.test' })),
  snapshot: vi.fn(),
  room: vi.fn(),
  create: vi.fn(async () => ({ success: true })),
  provision: vi.fn(async () => ({ success: true })),
  error: vi.fn(),
  mirror: vi.fn(),
  clear: vi.fn(),
  updateStatus: vi.fn(),
  syncActivity: vi.fn(),
  emit: vi.fn(),
  rows: [] as { id: string }[],
}));
vi.mock('./getAgentById', () => ({
  getAgentById: async () => ({
    id: 'local',
    switchAgentId: 'agent',
    serverId: 'server',
    providerId: 'codex',
    autoApprove: false,
  }),
}));
vi.mock('@main/core/switch-servers/servers-store', () => ({
  getServer: mocks.server,
}));
vi.mock('@main/core/switch-servers/gateway-client', () => ({
  fetchSdkSessions: mocks.list,
  fetchSdkSnapshot: mocks.snapshot,
  fetchRoomDetail: mocks.room,
}));
vi.mock('@main/core/sdk-host/session-activity', () => ({
  syncSdkSessionActivity: vi.fn(async () => {}),
}));
vi.mock('@main/core/sdk-host/session-activity', () => ({
  syncSdkSessionActivity: mocks.syncActivity,
}));
vi.mock('@main/core/sessions/session-service', () => ({
  sessionService: {
    createSession: mocks.create,
    provisionSession: mocks.provision,
    updateSessionStatus: mocks.updateStatus,
  },
}));
vi.mock('@main/core/switch-rooms/switch-room-service', () => ({
  switchRoomService: { mirrorRemoteSessionRoom: mocks.mirror, clearSession: mocks.clear },
}));
vi.mock('@main/db/client', () => ({
  db: { select: () => ({ from: () => ({ where: async () => mocks.rows }) }) },
}));
vi.mock('@main/db/schema', () => ({ sessions: { id: 'id', agentId: 'agentId' } }));
vi.mock('@main/lib/events', () => ({ events: { emit: mocks.emit } }));
vi.mock('@main/lib/logger', () => ({ log: { error: mocks.error } }));

const session = {
  sessionId: 'shared',
  agentId: 'agent',
  hostId: 'host',
  epoch: 'epoch',
  provider: 'codex',
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
};
let now = 0;
beforeEach(() => {
  now = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
async function tick() {
  now += 2000;
  await (remoteSessionReconciler as unknown as { tick(id: string): Promise<void> }).tick('local');
}
afterEach(() => {
  remoteSessionReconciler.dispose();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  mocks.rows = [];
});
it('adopts an authorized shared session without starting execution', async () => {
  mocks.list.mockResolvedValue([session]);
  mocks.snapshot.mockResolvedValue({
    contractVersion: 1,
    throughSequence: 0,
    session,
    turns: [],
    items: [],
    requests: [],
    commandStatuses: [],
    nextPageToken: null,
  });
  await tick();
  expect(mocks.create).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'shared', attach: false, startSource: 'adopted' })
  );
  mocks.rows = [{ id: 'shared' }];
  await tick();
  expect(mocks.create).toHaveBeenCalledTimes(1);
});
it('retains sessions on connection loss and excludes other agents and stopped sessions', async () => {
  mocks.list.mockRejectedValueOnce(new Error('Disconnected'));
  await tick();
  expect(mocks.error).toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
  mocks.list.mockResolvedValue([
    { ...session, agentId: 'other' },
    { ...session, status: 'stopped' },
  ]);
  await tick();
  expect(mocks.create).not.toHaveBeenCalled();
});

it('refreshes existing room associations from the list without fetching transcripts', async () => {
  mocks.rows = [{ id: 'shared' }];
  mocks.list.mockResolvedValue([{ ...session, roomIds: ['room'] }]);
  await tick();
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.snapshot).not.toHaveBeenCalled();
  expect(mocks.syncActivity).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: 'shared', status: 'ready' })
  );
  expect(mocks.mirror).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: 'shared' }),
    'room',
    'agent'
  );
  mocks.list.mockResolvedValue([{ ...session, roomIds: [] }]);
  await tick();
  expect(mocks.clear).toHaveBeenCalledWith('shared');
});

it('adopts healthy sessions despite additive fields, an invalid entry and a failed snapshot', async () => {
  mocks.list.mockResolvedValue([
    { ...session, sessionId: 'broken' },
    { ...session, status: 'invalid' },
    {
      ...session,
      sessionId: 'healthy',
      futureField: true,
      capabilities: { ...session.capabilities, futureCapability: true },
    },
  ]);
  mocks.snapshot.mockRejectedValueOnce(new Error('Snapshot 500')).mockResolvedValueOnce({
    contractVersion: 1,
    throughSequence: 0,
    session: { ...session, sessionId: 'healthy', futureField: true },
    turns: [],
    items: [],
    requests: [],
    commandStatuses: [],
    nextPageToken: null,
    futureField: true,
  });
  await tick();
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(mocks.create).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'healthy', startSource: 'adopted' })
  );
  expect(mocks.provision).not.toHaveBeenCalled();
  expect(remoteSessionReconciler.errors()).toEqual([
    { agentId: 'local', message: expect.stringContaining('2 SDK session(s)') },
  ]);
  mocks.list.mockResolvedValue([{ ...session, roomIds: [] }]);
  await tick();
  expect(remoteSessionReconciler.errors()).toEqual([]);
});

it('marks a stopped host cancelled without claiming its work completed', async () => {
  mocks.rows = [{ id: 'shared' }];
  mocks.list.mockResolvedValue([{ ...session, status: 'stopped', roomIds: ['room'] }]);
  await tick();
  expect(mocks.updateStatus).toHaveBeenCalledWith('shared', 'cancelled');
  expect(mocks.emit).toHaveBeenCalledWith(expect.anything(), {
    sessionId: 'shared',
    status: 'cancelled',
  });
  expect(mocks.create).not.toHaveBeenCalled();
});

it('names a newly adopted room session after its room', async () => {
  mocks.list.mockResolvedValue([{ ...session, roomIds: ['room'] }]);
  mocks.room.mockResolvedValue({ id: 'room', name: 'Release planning' });
  await tick();
  expect(mocks.room).toHaveBeenCalledWith(expect.objectContaining({ id: 'server' }), 'room');
  expect(mocks.create).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'shared', title: 'Session for Release planning' })
  );
  mocks.rows = [{ id: 'shared' }];
  await tick();
  expect(mocks.room).toHaveBeenCalledTimes(1);
  expect(mocks.create).toHaveBeenCalledTimes(1);
});

it('reports incompatible rows once while discovering healthy sessions and ignoring other agents', async () => {
  mocks.list.mockResolvedValue([
    { sessionId: 'other-bad', agentId: 'other', discoveryError: 'Other agent error' },
    { sessionId: 'broken', agentId: 'agent', discoveryError: 'Stored session needs repair.' },
    { ...session, sessionId: 'healthy', roomIds: [] },
  ]);
  await tick();
  expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ id: 'healthy' }));
  expect(remoteSessionReconciler.errors()[0].message).toContain('1 SDK session(s)');
  expect(remoteSessionReconciler.errors()[0].message).toContain('Stored session needs repair.');
  mocks.rows = [{ id: 'healthy' }];
  await tick();
  expect(mocks.error).toHaveBeenCalledTimes(1);
  mocks.list.mockResolvedValue([{ ...session, sessionId: 'healthy', roomIds: [] }]);
  await tick();
  expect(remoteSessionReconciler.errors()).toEqual([]);
});

it.each(['gemini', 'future-provider'])(
  'reports unsupported %s sessions without trying to launch or adopt them',
  async (provider) => {
    mocks.list.mockResolvedValue([{ ...session, provider, roomIds: [] }]);
    await tick();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(remoteSessionReconciler.errors()[0].message).toContain(
      `unsupported provider "${provider}"`
    );
  }
);

it('does not re-adopt a session the user deleted', async () => {
  const { tombstoneSession } = await import('@main/core/sessions/deleted-sessions');
  mocks.list.mockResolvedValue([{ ...session, sessionId: 'deleted-session' }]);
  tombstoneSession('deleted-session');
  await tick();
  expect(mocks.create).not.toHaveBeenCalled();
});

it('does not adopt a retired session, whose work will never resume', async () => {
  mocks.list.mockResolvedValue([
    { ...session, sessionId: 'retired-session', retired: true, roomIds: [] },
  ]);
  await tick();
  expect(mocks.create).not.toHaveBeenCalled();
});

it('shares one server list across overlapping and staggered agent discovery', async () => {
  let resolve!: (value: unknown[]) => void;
  mocks.list.mockReturnValueOnce(
    new Promise<unknown[]>((done) => {
      resolve = done;
    })
  );
  const reconciler = remoteSessionReconciler as unknown as { tick(id: string): Promise<void> };
  const first = reconciler.tick('one');
  const second = reconciler.tick('two');
  await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
  resolve([]);
  await Promise.all([first, second]);
  now += 500;
  await reconciler.tick('three');
  expect(mocks.list).toHaveBeenCalledTimes(1);
  now += 2000;
  mocks.list.mockResolvedValue([]);
  await reconciler.tick('one');
  expect(mocks.list).toHaveBeenCalledTimes(2);
});

it('does not reuse a failed server read', async () => {
  mocks.list.mockRejectedValueOnce(new Error('Temporarily unavailable'));
  const reconciler = remoteSessionReconciler as unknown as { tick(id: string): Promise<void> };
  await reconciler.tick('one');
  expect(remoteSessionReconciler.errors()).toHaveLength(1);
  mocks.list.mockResolvedValueOnce([]);
  await reconciler.tick('one');
  expect(mocks.list).toHaveBeenCalledTimes(2);
  expect(remoteSessionReconciler.errors()).toEqual([]);
});

it('keeps server lists separate and invalidates a changed gateway URL', async () => {
  mocks.list.mockResolvedValue([]);
  const reconciler = remoteSessionReconciler as unknown as { tick(id: string): Promise<void> };
  await reconciler.tick('one');
  mocks.server.mockResolvedValueOnce({ id: 'other', gatewayUrl: 'https://other.example.test' });
  await reconciler.tick('two');
  mocks.server.mockResolvedValueOnce({ id: 'server', gatewayUrl: 'https://changed.example.test' });
  await reconciler.tick('one');
  expect(mocks.list).toHaveBeenCalledTimes(3);
});

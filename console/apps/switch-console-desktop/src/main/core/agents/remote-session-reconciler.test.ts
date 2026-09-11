import { afterEach, expect, it, vi } from 'vitest';
import { remoteSessionReconciler } from './remote-session-reconciler';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  snapshot: vi.fn(),
  create: vi.fn(async () => ({ success: true })),
  provision: vi.fn(async () => ({ success: true })),
  error: vi.fn(),
  mirror: vi.fn(),
  clear: vi.fn(),
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
  getServer: async () => ({ id: 'server' }),
}));
vi.mock('@main/core/switch-servers/gateway-client', () => ({
  fetchSdkSessions: mocks.list,
  fetchSdkSnapshot: mocks.snapshot,
}));
vi.mock('@main/core/sessions/session-service', () => ({
  sessionService: { createSession: mocks.create, provisionSession: mocks.provision },
}));
vi.mock('@main/core/switch-rooms/switch-room-service', () => ({
  switchRoomService: { mirrorRemoteSessionRoom: mocks.mirror, clearSession: mocks.clear },
}));
vi.mock('@main/db/client', () => ({
  db: { select: () => ({ from: () => ({ where: async () => mocks.rows }) }) },
}));
vi.mock('@main/db/schema', () => ({ sessions: { id: 'id', agentId: 'agentId' } }));
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
async function tick() {
  await (remoteSessionReconciler as unknown as { tick(id: string): Promise<void> }).tick('local');
}
afterEach(() => {
  remoteSessionReconciler.dispose();
  vi.clearAllMocks();
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

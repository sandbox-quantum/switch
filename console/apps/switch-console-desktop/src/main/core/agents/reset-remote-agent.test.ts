import { afterEach, expect, it, vi } from 'vitest';
import { resetRemoteAgent } from './reset-remote-agent';
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  stop: vi.fn(),
  disable: vi.fn(),
  remove: vi.fn(async () => ({ changes: 1 })),
  restart: vi.fn(),
  teardown: vi.fn(async () => ({ success: true })),
}));
vi.mock('./getAgentById', () => ({
  getAgentById: async () => ({ id: 'local', serverId: 'server', switchAgentId: 'agent' }),
}));
vi.mock('@main/core/switch-servers/servers-store', () => ({
  getServer: async () => ({ id: 'server' }),
}));
vi.mock('@main/core/switch-servers/gateway-client', () => ({ fetchSdkSessions: mocks.list }));
vi.mock('@main/core/sdk-host/shared-agent-runtime', () => ({ stopSharedSession: mocks.stop }));
vi.mock('@main/core/sdk-host/shared-watcher', () => ({ configureSharedWatcher: mocks.disable }));
vi.mock('@main/core/sessions/session-runtime-manager', () => ({
  sessionRuntimeManager: { teardownSession: mocks.teardown },
}));
vi.mock('@main/core/sessions/session-hooks', () => ({ sessionHooks: { _emit: vi.fn() } }));
vi.mock('@main/core/switch-rooms/switch-room-service', () => ({
  switchRoomService: { clearSession: vi.fn() },
}));
vi.mock('@main/core/view-state/view-state-service', () => ({ viewStateService: { del: vi.fn() } }));
vi.mock('@main/db/schema', () => ({ sessions: { id: 'id', agentId: 'agentId' } }));
vi.mock('@main/db/client', () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => [{ id: 'local-session' }] }) }),
    delete: () => ({ where: mocks.remove }),
  },
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('./remote-session-reconciler', () => ({ remoteSessionReconciler: { stop: vi.fn() } }));
vi.mock('./remote-watcher', () => ({
  ensureRemoteWatcher: mocks.restart,
  startRemoteDiscovery: vi.fn(),
}));
const session = {
  sessionId: 'remote-only',
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
afterEach(() => vi.clearAllMocks());
it('stops all server-owned sessions for this agent before removing local views', async () => {
  mocks.list.mockResolvedValue([
    session,
    { ...session, sessionId: 'foreign', agentId: 'another' },
    { ...session, sessionId: 'ended', status: 'stopped' },
  ]);
  await resetRemoteAgent('local');
  expect(mocks.disable).toHaveBeenCalledWith('local', false);
  expect(mocks.stop).toHaveBeenCalledExactlyOnceWith({ id: 'server' }, 'remote-only');
  expect(mocks.remove).toHaveBeenCalledTimes(1);
  expect(mocks.restart).toHaveBeenCalledWith('local');
});
it('keeps local state and auto-start disabled when stop has an unknown outcome', async () => {
  mocks.list.mockResolvedValue([session]);
  mocks.stop.mockRejectedValueOnce(new Error('Unknown outcome'));
  await expect(resetRemoteAgent('local')).rejects.toThrow('Unknown outcome');
  expect(mocks.remove).not.toHaveBeenCalled();
  expect(mocks.restart).not.toHaveBeenCalled();
});

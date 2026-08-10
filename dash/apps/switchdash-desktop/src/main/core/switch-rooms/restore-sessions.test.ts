import { beforeEach, describe, expect, it, vi } from 'vitest';

const listPersistedSessionIds = vi.hoisted(() => vi.fn());
const prunePersisted = vi.hoisted(() => vi.fn(async () => {}));
const loadSessionWithAgent = vi.hoisted(() => vi.fn());
const getLocationById = vi.hoisted(() => vi.fn());
const getLocation = vi.hoisted(() => vi.fn(() => ({}) as unknown));
const openLocation = vi.hoisted(() => vi.fn(async () => ({ success: true })));
const provisionSession = vi.hoisted(() => vi.fn<(id: string) => Promise<void>>(async () => {}));
const hydrateSession = vi.hoisted(() => vi.fn<(id: string) => Promise<void>>(async () => {}));
const ensureSessionAttachable = vi.hoisted(() =>
  vi.fn<(id: string) => Promise<boolean>>(async () => false)
);

vi.mock('./switch-room-service', () => ({
  switchRoomService: { listPersistedSessionIds, prunePersisted },
}));
vi.mock('@main/core/sessions/session-join', () => ({ loadSessionWithAgent }));
vi.mock('@main/core/locations/store', () => ({ getLocationById }));
vi.mock('@main/core/locations/location-manager', () => ({
  locationManager: { getLocation, openLocation },
}));
vi.mock('@main/core/sessions/session-service', () => ({
  sessionService: { provisionSession },
}));
vi.mock('@main/core/sessions/operations/hydrateSession', () => ({ hydrateSession }));
vi.mock('@main/core/sessions/operations/ensureSessionAttachable', () => ({
  ensureSessionAttachable,
}));
vi.mock('@main/lib/logger', () => ({
  log: { info() {}, warn() {}, error() {} },
}));

const { restoreSwitchRoomSessions } = await import('./restore-sessions');

describe('restoreSwitchRoomSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getLocation.mockReturnValue({});
    getLocationById.mockResolvedValue({ id: 'location-1', sshHost: null, dir: '/repo' });
    loadSessionWithAgent.mockResolvedValue({
      locationId: 'location-1',
      serverId: 'server-1',
      name: 'agent',
    });
    ensureSessionAttachable.mockResolvedValue(false);
  });

  it('only ensures the sidecar for a remote session, never its terminal', async () => {
    // The agent runs in a tmux pane on the VM and the sidecar injects room
    // messages there. Opening 51 terminals nobody is looking at is what
    // saturated the shared SSH transport.
    listPersistedSessionIds.mockResolvedValue(['session-1']);
    ensureSessionAttachable.mockResolvedValue(true);

    await restoreSwitchRoomSessions();

    expect(provisionSession).toHaveBeenCalledWith('session-1');
    expect(ensureSessionAttachable).toHaveBeenCalledWith('session-1');
    expect(hydrateSession).not.toHaveBeenCalled();
  });

  it('still hydrates a local session, which needs a live TUI for injection', async () => {
    listPersistedSessionIds.mockResolvedValue(['session-1']);
    ensureSessionAttachable.mockResolvedValue(false);

    await restoreSwitchRoomSessions();

    expect(hydrateSession).toHaveBeenCalledWith('session-1');
  });

  it('handles a mix of local and remote sessions', async () => {
    listPersistedSessionIds.mockResolvedValue(['remote-1', 'local-1']);
    ensureSessionAttachable.mockImplementation(async (id: string) => id === 'remote-1');

    await restoreSwitchRoomSessions();

    expect(hydrateSession).toHaveBeenCalledTimes(1);
    expect(hydrateSession).toHaveBeenCalledWith('local-1');
    expect(ensureSessionAttachable).toHaveBeenCalledTimes(2);
  });

  it('prunes sessions whose row has gone', async () => {
    listPersistedSessionIds.mockResolvedValue(['session-1']);
    loadSessionWithAgent.mockResolvedValue(null);

    await restoreSwitchRoomSessions();

    expect(prunePersisted).toHaveBeenCalledWith(['session-1']);
    expect(provisionSession).not.toHaveBeenCalled();
  });

  it('skips an agent whose Switch server was removed', async () => {
    listPersistedSessionIds.mockResolvedValue(['session-1']);
    loadSessionWithAgent.mockResolvedValue({
      locationId: 'location-1',
      serverId: null,
      name: 'agent',
    });

    await restoreSwitchRoomSessions();

    expect(provisionSession).not.toHaveBeenCalled();
    expect(ensureSessionAttachable).not.toHaveBeenCalled();
  });

  it('keeps going when one session fails to restore', async () => {
    listPersistedSessionIds.mockResolvedValue(['bad-1', 'good-1']);
    provisionSession.mockImplementation(async (id: string) => {
      if (id === 'bad-1') throw new Error('provision blew up');
    });
    ensureSessionAttachable.mockResolvedValue(true);

    await restoreSwitchRoomSessions();

    expect(ensureSessionAttachable).toHaveBeenCalledWith('good-1');
  });
});

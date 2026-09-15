import { beforeEach, describe, expect, it, vi } from 'vitest';

const listPersistedSessionIds = vi.hoisted(() => vi.fn());
const prunePersisted = vi.hoisted(() => vi.fn(async () => {}));
const loadSessionWithAgent = vi.hoisted(() => vi.fn());
const getLocationById = vi.hoisted(() => vi.fn());
const getLocation = vi.hoisted(() => vi.fn(() => ({}) as unknown));
const openLocation = vi.hoisted(() => vi.fn(async () => ({ success: true })));
/**
 * Provisioning reports its failures as a value rather than throwing, so the
 * double has to answer with one — a bare `undefined` reads as a failure and
 * would skip every session.
 */
const provisionSession = vi.hoisted(() =>
  vi.fn<(id: string) => Promise<{ success: boolean; error?: unknown; data?: unknown }>>(
    async () => ({ success: true, data: { path: '/repo', locationId: 'loc-1' } })
  )
);
const hydrateSession = vi.hoisted(() => vi.fn<(id: string) => Promise<void>>(async () => {}));

// Naming the provision failure pulls in the error module, which reaches the
// database through the runtime manager at import time.
vi.mock('@main/db/client', () => ({ db: {} }));
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
  });

  it('rehydrates a remote shared session without opening a terminal', async () => {
    listPersistedSessionIds.mockResolvedValue(['session-1']);

    await restoreSwitchRoomSessions();

    expect(provisionSession).toHaveBeenCalledWith('session-1');
    expect(hydrateSession).toHaveBeenCalledWith('session-1');
  });

  it('rehydrates a local shared session', async () => {
    listPersistedSessionIds.mockResolvedValue(['session-1']);

    await restoreSwitchRoomSessions();

    expect(hydrateSession).toHaveBeenCalledWith('session-1');
  });

  it('handles a mix of local and remote sessions', async () => {
    listPersistedSessionIds.mockResolvedValue(['remote-1', 'local-1']);

    await restoreSwitchRoomSessions();

    expect(hydrateSession).toHaveBeenCalledTimes(2);
    expect(hydrateSession).toHaveBeenCalledWith('local-1');
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
  });

  it('keeps going when one session fails to restore', async () => {
    listPersistedSessionIds.mockResolvedValue(['bad-1', 'good-1']);
    provisionSession.mockImplementation(async (id: string) =>
      id === 'bad-1'
        ? { success: false, error: { type: 'error', message: 'provision blew up' } }
        : { success: true, data: { path: '/repo', locationId: 'loc-1' } }
    );

    await restoreSwitchRoomSessions();

    expect(hydrateSession).toHaveBeenCalledWith('good-1');
  });
});

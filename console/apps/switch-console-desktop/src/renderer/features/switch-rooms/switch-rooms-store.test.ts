import { beforeEach, describe, expect, it, vi } from 'vitest';

const getConnections = vi.hoisted(() => vi.fn());

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: vi.fn() },
  rpc: { switchRooms: { getConnections } },
}));

const { SwitchRoomsStore } = await import('./switch-rooms-store');

describe('session → room connections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('seeds the connection set from the main process', async () => {
    getConnections.mockResolvedValue([{ sessionId: 'sess-1', roomId: 'room-a' }]);
    const store = new SwitchRoomsStore();

    store.ensureLoaded();

    await vi.waitFor(() => expect(store.roomForSession('sess-1')).toBe('room-a'));
    expect(store.seedError).toBeNull();
  });

  it('re-arms the seed after a failure instead of wedging on empty', async () => {
    // The loaded flag is set before the call, so without a failure branch every
    // session would read as connected to nothing for the whole app run — and
    // the room badges built on it would sit at zero, silently.
    getConnections.mockRejectedValueOnce(new Error('ipc down'));
    const store = new SwitchRoomsStore();

    store.ensureLoaded();
    // The banner says what could not be read; the raw reason is kept with it
    // rather than being the whole message.
    await vi.waitFor(() =>
      expect(store.seedError).toBe(
        'Could not read which Switch rooms these sessions are connected to. (ipc down)'
      )
    );

    getConnections.mockResolvedValue([{ sessionId: 'sess-2', roomId: 'room-b' }]);
    store.ensureLoaded();

    await vi.waitFor(() => expect(store.roomForSession('sess-2')).toBe('room-b'));
    expect(store.seedError).toBeNull();
  });
});

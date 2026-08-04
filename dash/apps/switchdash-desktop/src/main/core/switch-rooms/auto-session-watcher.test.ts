import { beforeEach, describe, expect, it, vi } from 'vitest';

const createSession = vi.fn();
const getAgentById = vi.fn();

vi.mock('@main/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@main/core/sessions/session-service', () => ({
  sessionService: { createSession: (...args: unknown[]) => createSession(...args) },
}));

// spawnForRoom reads the agent to decide autoApprove; startForAgent / the loops
// also touch this. Route it through a controllable mock so tests can set the
// per-agent flag.
const getConnections = vi.fn(() => [] as Array<{ roomId: string; agentId: string | null }>);
vi.mock('./switch-room-service', () => ({
  switchRoomService: {
    getConnections: () => getConnections(),
    onSessionRoomChanged: () => () => {},
  },
}));
const noteIntendedRoom = vi.fn();
vi.mock('./switch-notification-poller', () => ({
  switchNotificationPoller: {
    noteSpawnTrigger: vi.fn(),
    noteIntendedRoom: (...args: unknown[]) => noteIntendedRoom(...args),
  },
}));

vi.mock('@main/core/agents/getAgentById', () => ({
  getAgentById: (...args: unknown[]) => getAgentById(...args),
}));
vi.mock('@main/db/client', () => ({ db: {} }));
vi.mock('./auto-session-store', () => ({
  listAutoSessionAgentIds: vi.fn(async () => []),
  setAutoSessionAgent: vi.fn(),
}));
vi.mock('./switch-credentials', () => ({ readSwitchAgentCredentials: vi.fn() }));

const { autoSessionWatcher } = await import('./auto-session-watcher');

const CREDS = { agentId: 'switch-agent-1', apiEndpoint: 'http://x', token: 't' };

function fakeWatcher() {
  return {
    abort: new AbortController(),
    localAgentId: 'local-1',
    creds: CREDS,
    inFlight: new Map<string, ReturnType<typeof setTimeout>>(),
    connectionId: 'watch-conn-1',
  };
}

// handleNotification is private; reach it directly to test the decision in
// isolation from the long-poll loop.
function handle(watcher: ReturnType<typeof fakeWatcher>, roomId: string): void {
  (
    autoSessionWatcher as unknown as { handleNotification: (w: unknown, r: string) => void }
  ).handleNotification(watcher, roomId);
}

describe('AutoSessionWatcher.handleNotification', () => {
  beforeEach(() => {
    createSession.mockReset();
    getConnections.mockReset();
    getConnections.mockReturnValue([]);
    getAgentById.mockReset();
    getAgentById.mockResolvedValue({ id: 'local-1', autoApprove: false });
    createSession.mockResolvedValue({ success: true, data: { session: { id: 'new' } } });
  });

  it('spawns a session when no live session is attending the room', async () => {
    const watcher = fakeWatcher();

    handle(watcher, 'room-x');
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));

    const params = createSession.mock.calls[0][0] as { agentId: string; initialPrompt: string };
    expect(params.agentId).toBe('local-1');
    expect(params.initialPrompt).toContain('room-x');
  });

  it('spawns with permissions enforced when the agent has autoApprove off', async () => {
    getAgentById.mockResolvedValue({ id: 'local-1', autoApprove: false });
    const watcher = fakeWatcher();

    handle(watcher, 'room-x');
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));

    const params = createSession.mock.calls[0][0] as { autoApprove: boolean };
    expect(params.autoApprove).toBe(false);
  });

  it('spawns with permissions bypassed when the agent has autoApprove on', async () => {
    getAgentById.mockResolvedValue({ id: 'local-1', autoApprove: true });
    const watcher = fakeWatcher();

    handle(watcher, 'room-x');
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));

    const params = createSession.mock.calls[0][0] as { autoApprove: boolean };
    expect(params.autoApprove).toBe(true);
  });

  it('in-flight guard prevents a second spawn for the same room', async () => {
    const watcher = fakeWatcher();

    handle(watcher, 'room-x');
    handle(watcher, 'room-x');
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  /**
   * "A session already attends this room" is no longer checked here — the
   * server never delivers the event, because the session's connection claims
   * the room and this watcher's `all`-scope connection goes dark on it. The
   * guarantee moved rather than disappeared, and it is covered on the server
   * side (room slots) and by the stream tests.
   *
   * What stays here is the boot window, which no server can close.
   */
  describe('the boot window', () => {
    it('spawns exactly one session when messages arrive during boot', async () => {
      // The spawned session takes tens of seconds to start and claim the room.
      // Until it does, the server still sees the room as unattended and keeps
      // delivering — so every message in that window would spawn again.
      const watcher = fakeWatcher();

      handle(watcher, 'room-x');
      handle(watcher, 'room-x');
      handle(watcher, 'room-x');
      await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
      await new Promise((r) => setTimeout(r, 20));

      expect(createSession).toHaveBeenCalledTimes(1);
    });

    it("does not let one room's boot block another room", async () => {
      const watcher = fakeWatcher();

      handle(watcher, 'room-x');
      handle(watcher, 'room-y');
      await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(2));

      const rooms = createSession.mock.calls.map(
        (c) => (c[0] as { initialPrompt: string }).initialPrompt
      );
      expect(rooms.some((p) => p.includes('room-x'))).toBe(true);
      expect(rooms.some((p) => p.includes('room-y'))).toBe(true);
    });

    it('spawns again for a room whose guard has been cleared', async () => {
      // Cleared when the session connects (or on the TTL backstop). A session
      // that dies must be replaceable — a guard that never cleared would leave
      // the room permanently unattended.
      const watcher = fakeWatcher();

      handle(watcher, 'room-x');
      await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));

      const timer = watcher.inFlight.get('room-x');
      if (timer) clearTimeout(timer);
      watcher.inFlight.delete('room-x');

      handle(watcher, 'room-x');
      await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(2));
    });
  });

  /**
   * The restore window: switchdash has a session for this room, but its
   * connection has not claimed the room yet — so the server still reports the
   * room as unattended and delivers the event here.
   *
   * The server owns "who is in this room" once it has been told. Before that
   * there are windows only switchdash can see: a session booting, and one being
   * restored after a restart. Spawning in either gives the user a second
   * session beside a working one.
   */
  describe('a session we already have', () => {
    it('does not spawn when one of our sessions attends the room', async () => {
      getConnections.mockReturnValue([{ roomId: 'room-x', agentId: CREDS.agentId }]);
      const watcher = fakeWatcher();

      handle(watcher, 'room-x');
      await new Promise((r) => setTimeout(r, 20));

      expect(createSession).not.toHaveBeenCalled();
    });

    it('still spawns when our session is in a different room', async () => {
      getConnections.mockReturnValue([{ roomId: 'other-room', agentId: CREDS.agentId }]);
      const watcher = fakeWatcher();

      handle(watcher, 'room-x');
      await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    });

    it('still spawns when the room is attended by a different agent', async () => {
      // Two agents can share a room; another agent's session is not ours.
      getConnections.mockReturnValue([{ roomId: 'room-x', agentId: 'someone-else' }]);
      const watcher = fakeWatcher();

      handle(watcher, 'room-x');
      await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    });
  });

  it('declares the room for the session it is about to create', async () => {
    // The session exists because of a message in this room, so its connection
    // opens already claiming it. Without this it starts room-less and only
    // joins once the agent gets round to connect_to_room — until then it shows
    // outside the room it was started for.
    const watcher = fakeWatcher();

    handle(watcher, 'room-x');
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));

    const sessionId = (createSession.mock.calls[0][0] as { id: string }).id;
    expect(noteIntendedRoom).toHaveBeenCalledWith(sessionId, 'room-x', null);
  });
});

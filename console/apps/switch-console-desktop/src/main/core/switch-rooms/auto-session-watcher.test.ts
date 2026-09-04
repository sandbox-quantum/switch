import { beforeEach, describe, expect, it, vi } from 'vitest';

const createSession = vi.fn();
const getAgentById = vi.fn();

vi.mock('@main/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const provisionSession = vi.fn(async (..._args: unknown[]) => ({ success: true }));
vi.mock('@main/core/sessions/session-service', () => ({
  sessionService: {
    createSession: (...args: unknown[]) => createSession(...args),
    provisionSession: (...args: unknown[]) => provisionSession(...args),
  },
}));

// A provider-backed spawn hands its trigger to the session's runtime as a turn
// rather than putting it in the opening prompt, so the runtime has to be
// reachable for that path to be exercised at all.
const sendTurn = vi.fn(async (..._args: unknown[]) => ({ turnId: 't1' }));
vi.mock('@main/core/sessions/session-runtime-manager', () => ({
  sessionRuntimeManager: {
    getAgent: () => ({
      sendTurn: (...args: unknown[]) => sendTurn(...args),
      getTranscript: () => ({}),
    }),
  },
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
const noteSpawnTrigger = vi.fn();
vi.mock('./switch-notification-poller', () => ({
  switchNotificationPoller: {
    noteSpawnTrigger: (...args: unknown[]) => noteSpawnTrigger(...args),
    noteIntendedRoom: (...args: unknown[]) => noteIntendedRoom(...args),
  },
}));

vi.mock('@main/core/agents/getAgentById', () => ({
  getAgentById: (...args: unknown[]) => getAgentById(...args),
}));
const fetchRoomDetail = vi.fn();
vi.mock('@main/core/switch-servers/gateway-client', () => ({
  fetchRoomDetail: (...args: unknown[]) => fetchRoomDetail(...args),
}));
vi.mock('@main/core/switch-servers/servers-store', () => ({
  getServer: vi.fn(async () => ({ id: 'server-1' })),
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

/** An addressed room message, as the watch stream delivers it. */
type Overrides = {
  body?: string;
  sequence?: number;
  messageId?: string;
  threadId?: string;
};

function messageEvent(roomId: string, overrides: Overrides = {}): unknown {
  return {
    type: 'message',
    room_id: roomId,
    sequence: overrides.sequence ?? 7,
    payload: {
      addressed: true,
      body: overrides.body ?? 'hi there',
      sender_name: 'user',
      message_id: overrides.messageId ?? 'msg-1',
      thread_id: overrides.threadId ?? null,
    },
  };
}

// handleNotification is private; reach it directly to test the decision in
// isolation from the long-poll loop.
function handle(
  watcher: ReturnType<typeof fakeWatcher>,
  roomId: string,
  overrides: Overrides = {}
): void {
  (
    autoSessionWatcher as unknown as { handleNotification: (w: unknown, e: unknown) => void }
  ).handleNotification(watcher, messageEvent(roomId, overrides));
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
   * The restore window: Switch Console has a session for this room, but its
   * connection has not claimed the room yet — so the server still reports the
   * room as unattended and delivers the event here.
   *
   * The server owns "who is in this room" once it has been told. Before that
   * there are windows only Switch Console can see: a session booting, and one being
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
    //
    // With the name we already looked up for the title: nothing else tells the
    // connection what the room is called, so without it every line the session
    // writes about the room names an id instead.
    getAgentById.mockResolvedValue({ id: 'local-1', autoApprove: false, serverId: 'server-1' });
    fetchRoomDetail.mockResolvedValue({ id: 'room-x', name: 'Charlie' });
    const watcher = fakeWatcher();

    handle(watcher, 'room-x');
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));

    const sessionId = (createSession.mock.calls[0][0] as { id: string }).id;
    expect(noteIntendedRoom).toHaveBeenCalledWith(sessionId, 'room-x', 'Charlie');
  });
});

/**
 * The message a session was started for travels in its opening prompt
 * (CHOO-2173).
 *
 * It used to be left to the session's room connection to type in once the
 * session was up. But that connection opens before the terminal exists, which
 * is exactly when this message arrives — so it waited, and the agent connected,
 * found nothing addressed to it and greeted the room instead of answering.
 * There is nothing to wait for if it goes in with the launch.
 */
describe('the message that started the session', () => {
  beforeEach(() => {
    createSession.mockReset();
    getConnections.mockReset();
    getConnections.mockReturnValue([]);
    getAgentById.mockReset();
    getAgentById.mockResolvedValue({ id: 'local-1', autoApprove: false, serverId: 'server-1' });
    createSession.mockResolvedValue({ success: true, data: { session: { id: 'new' } } });
    noteSpawnTrigger.mockReset();
    sendTurn.mockClear();
    fetchRoomDetail.mockReset();
    fetchRoomDetail.mockResolvedValue({ id: 'room-x', name: 'Charlie' });
  });

  async function openingPrompt(overrides: Overrides = {}): Promise<string> {
    const watcher = fakeWatcher();
    handle(watcher, 'room-x', overrides);
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    return (createSession.mock.calls[0][0] as { initialPrompt: string }).initialPrompt;
  }

  it('titles the session after the room, not its id', async () => {
    // "Switch room 5ee6fedc-b701-4372-beb7-baa36464c3d0" names nothing anyone
    // recognises, and it is how the session is listed from the moment it
    // appears.
    const watcher = fakeWatcher();
    handle(watcher, 'room-x');
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));

    expect((createSession.mock.calls[0][0] as { title: string }).title).toBe(
      'Session for room Charlie'
    );
  });

  it('falls back to the id when the room will not say its name', async () => {
    // A name lookup that fails is not a reason to abandon the spawn.
    fetchRoomDetail.mockRejectedValueOnce(new Error('gateway down'));
    const watcher = fakeWatcher();
    handle(watcher, 'room-x');
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));

    expect((createSession.mock.calls[0][0] as { title: string }).title).toBe(
      'Session for room room-x'
    );
  });

  it('rides along with the instruction to join the room', async () => {
    const prompt = await openingPrompt({ body: 'what is the build status?' });

    expect(prompt).toContain('connect to switch room room-x');
    expect(prompt).toContain('what is the build status?');
  });

  it('carries who said it and its id, so the agent can reply to it', async () => {
    const prompt = await openingPrompt({ messageId: 'msg-42' });

    expect(prompt).toContain('user');
    expect(prompt).toContain('msg-42');
  });

  it('is not also replayed onto the session, which would answer it twice', async () => {
    await openingPrompt({ sequence: 7 });

    // Start *at* the trigger, so the stream resumes after it rather than
    // handing it over a second time.
    expect(noteSpawnTrigger).toHaveBeenCalledWith('switch-agent-1', 7, true, expect.anything());
  });

  it('hands over where the message sits, so the turn can be reported against it', async () => {
    // Without this the session's first turn is the one turn nothing reports:
    // the message is in the opening prompt, so no injection opens the turn.
    await openingPrompt({ sequence: 7, messageId: 'msg-42', threadId: 'thread-1' });

    expect(noteSpawnTrigger).toHaveBeenCalledWith('switch-agent-1', 7, true, {
      threadId: 'thread-1',
      anchorId: 'msg-42',
    });
  });

  it('reports a root-level message as having no thread', async () => {
    await openingPrompt({ sequence: 7, messageId: 'msg-42' });

    expect(noteSpawnTrigger).toHaveBeenCalledWith('switch-agent-1', 7, true, {
      threadId: null,
      anchorId: 'msg-42',
    });
  });

  /**
   * A provider-backed session has no terminal, so its trigger goes in as a turn
   * rather than in the opening prompt — and that is the one message a session
   * receives without passing through the room connection. Handed over bare, the
   * first entry in the transcript is the only one that reads as raw protocol.
   */
  it('hands a provider session its trigger with the sender and room, not just the envelope', async () => {
    getAgentById.mockResolvedValue({
      id: 'local-1',
      autoApprove: false,
      serverId: 'server-1',
      providerConfig: { version: '2', providerId: 'opencode', values: {}, runtime: 'provider' },
    });
    createSession.mockResolvedValue({ success: true, data: { session: { id: 'session-9' } } });
    const watcher = fakeWatcher();

    handle(watcher, 'room-x', { body: '@agent hello', messageId: 'msg-42' });
    await vi.waitFor(() => expect(sendTurn).toHaveBeenCalled());

    const [text, source, origin] = sendTurn.mock.calls[0] as [string, string, unknown];
    expect(text).toContain('msg-42');
    expect(source).toBe('room');
    expect(origin).toEqual({
      sender: 'user',
      body: '@agent hello',
      roomId: 'room-x',
      roomName: 'Charlie',
      messageId: 'msg-42',
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const createSession = vi.fn();
const getConnections = vi.fn();

vi.mock('@main/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@main/core/sessions/session-service', () => ({
  sessionService: { createSession: (...args: unknown[]) => createSession(...args) },
}));

vi.mock('./switch-room-service', () => ({
  switchRoomService: { getConnections: () => getConnections() },
}));

// These are only touched by startForAgent / the loops, not by the decision
// logic under test — stub them so the module imports cleanly.
vi.mock('@main/core/agents/getAgentById', () => ({ getAgentById: vi.fn() }));
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
    createSession.mockResolvedValue({ success: true, data: { session: { id: 'new' } } });
  });

  it('spawns a session when no live session is attending the room', async () => {
    getConnections.mockReturnValue([]);
    const watcher = fakeWatcher();

    handle(watcher, 'room-x');
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));

    const params = createSession.mock.calls[0][0] as { agentId: string; initialPrompt: string };
    expect(params.agentId).toBe('local-1');
    expect(params.initialPrompt).toContain('room-x');
  });

  it('does not spawn when a live session already attends the room', async () => {
    getConnections.mockReturnValue([
      { sessionId: 'c1', roomId: 'room-x', agentId: 'switch-agent-1' },
    ]);
    const watcher = fakeWatcher();

    handle(watcher, 'room-x');
    await new Promise((r) => setTimeout(r, 10));
    expect(createSession).not.toHaveBeenCalled();
  });

  it('in-flight guard prevents a second spawn for the same room', async () => {
    getConnections.mockReturnValue([]);
    const watcher = fakeWatcher();

    handle(watcher, 'room-x');
    handle(watcher, 'room-x');
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('treats a live session in a different room as not attending', async () => {
    getConnections.mockReturnValue([
      { sessionId: 'c1', roomId: 'other-room', agentId: 'switch-agent-1' },
    ]);
    const watcher = fakeWatcher();

    handle(watcher, 'room-x');
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
  });
});

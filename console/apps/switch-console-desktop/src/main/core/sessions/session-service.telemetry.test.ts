import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * What a session start reports when it does not happen.
 *
 * The success is reported from the `session:created` hook, which only fires on
 * one — so a start that fails has no bus to be heard on and is reported at the
 * service instead. These cover that the two describe the same thing in the same
 * terms, since the whole point is to compare them.
 */

const { hoisted } = vi.hoisted(() => ({
  hoisted: {
    createSession: vi.fn(),
    getAgentById: vi.fn(),
    getLocationById: vi.fn(),
    trackEvent: vi.fn(),
    hasIntendedRoom: vi.fn(() => false),
  },
}));

vi.mock('./operations/createSession', () => ({ createSession: hoisted.createSession }));
vi.mock('@main/core/agents/getAgentById', () => ({ getAgentById: hoisted.getAgentById }));
vi.mock('@main/core/locations/store', () => ({ getLocationById: hoisted.getLocationById }));
vi.mock('@main/core/telemetry/telemetry-service', () => ({ trackEvent: hoisted.trackEvent }));
vi.mock('@main/core/switch-rooms/switch-notification-poller', () => ({
  switchNotificationPoller: { hasIntendedRoom: hoisted.hasIntendedRoom },
}));

vi.mock('@main/db/client', () => ({ db: {} }));
vi.mock('@main/db/schema', () => ({ sessions: {} }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('@main/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@main/core/locations/location-manager', () => ({
  locationManager: { getLocation: vi.fn() },
}));
vi.mock('./session-builder', () => ({ provisionSessionRuntime: vi.fn() }));
vi.mock('./session-runtime-manager', () => ({
  sessionRuntimeManager: { registerSession: vi.fn() },
}));
vi.mock('./utils/utils', () => ({ mapSessionRowToSession: vi.fn() }));
vi.mock('./operations/archiveSession', () => ({ archiveSession: vi.fn() }));
vi.mock('./operations/deleteSession', () => ({ deleteSession: vi.fn() }));
vi.mock('./operations/ensureSessionAttachable', () => ({ ensureSessionAttachable: vi.fn() }));
vi.mock('./operations/getSessions', () => ({ getSessions: vi.fn() }));
vi.mock('./operations/renameSession', () => ({ renameSession: vi.fn() }));
vi.mock('./operations/restoreSession', () => ({ restoreSession: vi.fn() }));
vi.mock('./operations/setSessionPinned', () => ({ setSessionPinned: vi.fn() }));
vi.mock('./operations/updateSessionStatus', () => ({ updateSessionStatus: vi.fn() }));

const { sessionService } = await import('./session-service');

const PARAMS = {
  id: 's-1',
  agentId: 'agent-1',
  title: 'Session',
  entryPoint: 'sidebar',
} as const;

function failWith(type: string, extra: Record<string, unknown> = {}) {
  hoisted.createSession.mockResolvedValue({ success: false, error: { type, ...extra } });
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.hasIntendedRoom.mockReturnValue(false);
  hoisted.getAgentById.mockResolvedValue({ id: 'agent-1', providerId: 'codex', locationId: 'loc' });
  hoisted.getLocationById.mockResolvedValue({ id: 'loc', sshHost: null });
});

describe('a session start that fails', () => {
  it('reports the failure with the reason as a code', async () => {
    failWith('spawn-failed', { message: 'boom' });

    await sessionService.createSession({ ...PARAMS });

    expect(hoisted.trackEvent).toHaveBeenCalledWith(
      'session_started',
      expect.objectContaining({
        outcome: 'failure',
        failure_reason: 'spawn_failed',
        agent_type: 'codex',
        location: 'local',
        entry_point: 'sidebar',
      })
    );
  });

  it('never puts the spawn error message in the payload', async () => {
    failWith('spawn-failed', { message: 'ENOENT /Users/someone/secret-project/bin/codex' });

    await sessionService.createSession({ ...PARAMS });

    expect(JSON.stringify(hoisted.trackEvent.mock.calls)).not.toContain('secret-project');
  });

  it('says unknown rather than guessing when the agent is what is missing', async () => {
    // `agent-not-found` is itself one of the failures, so there is nothing to
    // read the shape from — and a guess here would be indistinguishable from a
    // real answer.
    hoisted.getAgentById.mockResolvedValue(undefined);
    failWith('agent-not-found');

    await sessionService.createSession({ ...PARAMS });

    expect(hoisted.trackEvent).toHaveBeenCalledWith(
      'session_started',
      expect.objectContaining({
        agent_type: 'unknown',
        location: 'unknown',
        failure_reason: 'agent_not_found',
      })
    );
  });

  it('records whether a room and a prompt were asked for, not what they were', async () => {
    hoisted.hasIntendedRoom.mockReturnValue(true);
    failWith('already-exists');

    await sessionService.createSession({
      ...PARAMS,
      initialPrompt: 'connect to room alpha and audit the deploy',
    });

    const [, properties] = hoisted.trackEvent.mock.calls[0] as [string, Record<string, unknown>];
    expect(properties.has_initial_prompt).toBe(true);
    expect(properties.connected_to_room).toBe(true);
    expect(JSON.stringify(properties)).not.toContain('alpha');
  });

  it('treats whitespace as no prompt, the same test the create path applies', async () => {
    failWith('already-exists');

    await sessionService.createSession({ ...PARAMS, initialPrompt: '   ' });

    expect(hoisted.trackEvent).toHaveBeenCalledWith(
      'session_started',
      expect.objectContaining({ has_initial_prompt: false })
    );
  });

  it('reports a session it only adopted apart from one started here', async () => {
    failWith('already-exists');

    await sessionService.createSession({ ...PARAMS, startSource: 'adopted' });

    expect(hoisted.trackEvent).toHaveBeenCalledWith(
      'session_started',
      expect.objectContaining({ start_source: 'adopted' })
    );
  });

  it('reports nothing itself when the session starts', async () => {
    // The hook reports that one; reporting here as well would double-count it.
    hoisted.createSession.mockResolvedValue({
      success: true,
      data: { session: { id: 's-1', agentId: 'agent-1', providerId: 'codex' } },
    });

    await sessionService.createSession({ ...PARAMS });

    expect(hoisted.trackEvent).not.toHaveBeenCalled();
  });
});

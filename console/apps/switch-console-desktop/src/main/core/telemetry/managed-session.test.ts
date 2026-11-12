import { SESSION_STARTED_KIND, type SessionStartedNotice } from '@switch-console/agent-providers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./telemetry-service', () => ({ trackEvent: vi.fn() }));

const { reportManagedSessionStarted } = await import('./managed-session');
const { trackEvent } = await import('./telemetry-service');

function notice(sessionId: string, provider = 'claude'): SessionStartedNotice {
  return { kind: SESSION_STARTED_KIND, sessionId, provider, startSource: 'room' };
}

beforeEach(() => vi.clearAllMocks());

describe('sessions of agents on this computer’s controller', () => {
  it('reports a start with the agent’s type and how it started, and never the session', () => {
    reportManagedSessionStarted(notice('session-1'));
    expect(trackEvent).toHaveBeenCalledWith('managed_session_started', {
      agent_type: 'claude',
      start_source: 'room',
    });
  });

  it('counts a start reported twice once', () => {
    reportManagedSessionStarted(notice('session-2'));
    reportManagedSessionStarted(notice('session-2'));
    expect(trackEvent).toHaveBeenCalledTimes(1);
  });

  it('reports a provider it does not know as unknown', () => {
    reportManagedSessionStarted(notice('session-3', 'some-new-cli'));
    expect(trackEvent).toHaveBeenCalledWith('managed_session_started', {
      agent_type: 'unknown',
      start_source: 'room',
    });
  });
});

import type { ProviderRuntimeEvent } from '@switch-console/agent-providers';
import { describe, expect, it } from 'vitest';
import { deriveAgentStatus } from '@main/core/agent-hooks/derive-agent-status';
import { toAgentEvent } from './provider-agent-status';

const PARAMS = { sessionId: 'session-1', providerId: 'opencode' };

function event(body: Partial<ProviderRuntimeEvent> & { type: string }): ProviderRuntimeEvent {
  return {
    eventId: 'e1',
    provider: 'opencode',
    sessionId: 'session-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...body,
  } as ProviderRuntimeEvent;
}

/** What the sidebar, the sound and the room actually read. */
function statusOf(body: Partial<ProviderRuntimeEvent> & { type: string }) {
  const agentEvent = toAgentEvent(event(body), PARAMS);
  return agentEvent === null ? null : deriveAgentStatus(agentEvent);
}

describe('toAgentEvent', () => {
  it('reports a started turn as working', () => {
    expect(statusOf({ type: 'turn.started', turnId: 't1' })).toBe('working');
  });

  it('reports a finished turn as completed', () => {
    expect(statusOf({ type: 'turn.completed', turnId: 't1', outcome: 'completed' })).toBe(
      'completed'
    );
  });

  it('reports an interrupted turn as completed, not as a failure', () => {
    expect(statusOf({ type: 'turn.completed', turnId: 't1', outcome: 'interrupted' })).toBe(
      'completed'
    );
  });

  /**
   * The difference between the sidebar going quiet and the sidebar asking for
   * attention, so it is asserted rather than assumed.
   */
  it('reports a failed turn as an error, carrying its reason', () => {
    const agentEvent = toAgentEvent(
      event({ type: 'turn.completed', turnId: 't1', outcome: 'error', message: 'model refused' }),
      PARAMS
    );
    expect(agentEvent).toMatchObject({ type: 'error', payload: { message: 'model refused' } });
    expect(deriveAgentStatus(agentEvent!)).toBe('error');
  });

  it('reports an approval request as a permission prompt awaiting input', () => {
    const agentEvent = toAgentEvent(
      event({
        type: 'request.opened',
        turnId: 't1',
        requestId: 'r1',
        requestType: 'command_execution_approval',
        title: 'rm -rf build',
        detail: 'rm -rf build',
        options: [],
      }),
      PARAMS
    );
    expect(agentEvent?.payload.notificationType).toBe('permission_prompt');
    expect(deriveAgentStatus(agentEvent!)).toBe('awaiting-input');
  });

  it('reports a clarifying question as an elicitation awaiting input', () => {
    const agentEvent = toAgentEvent(
      event({
        type: 'user-input.requested',
        turnId: 't1',
        requestId: 'q1',
        questions: [
          {
            id: '0',
            header: 'Colour',
            question: 'Which colour?',
            options: [],
            multiSelect: false,
            allowCustomAnswer: true,
          },
        ],
      }),
      PARAMS
    );
    expect(agentEvent?.payload).toMatchObject({
      notificationType: 'elicitation_dialog',
      title: 'Colour',
      message: 'Which colour?',
    });
    expect(deriveAgentStatus(agentEvent!)).toBe('awaiting-input');
  });

  it('reports a runtime error as an error', () => {
    expect(statusOf({ type: 'runtime.error', message: 'server died' })).toBe('error');
  });

  /**
   * A session that has ended is not a session that is stuck. Reporting it as
   * anything but done leaves the room saying "working on it" forever.
   */
  it('reports an exit as done rather than as a failure', () => {
    expect(statusOf({ type: 'session.exited', reason: 'server exited with code 1' })).toBe(
      'completed'
    );
  });

  it('says nothing about events that carry no status', () => {
    expect(
      toAgentEvent(event({ type: 'runtime.warning', message: 'retrying' }), PARAMS)
    ).toBeNull();
    expect(
      toAgentEvent(event({ type: 'content.delta', turnId: 't1', itemId: 'p1', delta: 'x' }), PARAMS)
    ).toBeNull();
    expect(
      toAgentEvent(event({ type: 'session.state.changed', status: 'ready' }), PARAMS)
    ).toBeNull();
  });

  it('stamps the session and provider onto every event it produces', () => {
    expect(toAgentEvent(event({ type: 'turn.started', turnId: 't1' }), PARAMS)).toMatchObject({
      sessionId: 'session-1',
      providerId: 'opencode',
      timestamp: Date.parse('2026-01-01T00:00:00.000Z'),
    });
  });
});

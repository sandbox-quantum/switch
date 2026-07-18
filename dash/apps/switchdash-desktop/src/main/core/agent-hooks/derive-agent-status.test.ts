import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/core/providers/agentEvents';
import { deriveAgentStatus } from './derive-agent-status';

function event(partial: Partial<AgentEvent> & Pick<AgentEvent, 'type'>): AgentEvent {
  return {
    source: 'hook',
    providerId: 'claude-code',
    locationId: 'p',
    conversationId: 'c',
    sessionId: 'c',
    timestamp: 1,
    payload: {},
    ...partial,
  } as AgentEvent;
}

describe('deriveAgentStatus', () => {
  it('maps start/stop/error to working/completed/error', () => {
    expect(deriveAgentStatus(event({ type: 'start' }))).toBe('working');
    expect(deriveAgentStatus(event({ type: 'stop' }))).toBe('completed');
    expect(deriveAgentStatus(event({ type: 'error' }))).toBe('error');
  });

  it('maps an attention notification to awaiting-input', () => {
    expect(
      deriveAgentStatus(
        event({ type: 'notification', payload: { notificationType: 'permission_prompt' } })
      )
    ).toBe('awaiting-input');
  });

  it('returns null for a notification with no type', () => {
    expect(deriveAgentStatus(event({ type: 'notification', payload: {} }))).toBeNull();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { sessionTranscriptChannel } from '@shared/core/sessions/session-transcript';

const emit = vi.hoisted(() => vi.fn());

// The same narrow stubs the smoke test uses: everything the module reaches for
// at import time that needs an app around it.
vi.mock('@main/lib/events', () => ({ events: { emit } }));
vi.mock('@main/core/agents/getAgentById', () => ({ getAgentById: vi.fn() }));
vi.mock('@main/core/agents/agent-launch-config', () => ({ agentLaunchSpecialization: vi.fn() }));
vi.mock('@main/core/switch-rooms/switch-notification-poller', () => ({
  switchNotificationPoller: { ensureForSession: vi.fn(), disconnect: vi.fn() },
}));
vi.mock('@main/core/switch-rooms/switch-room-service', () => ({
  switchRoomService: { clearSession: vi.fn() },
}));
vi.mock('@main/core/switch-rooms/provider-room-relay', () => ({
  providerRoomRelay: { onRequestOpened: vi.fn(), onRequestResolved: vi.fn(), unbind: vi.fn() },
}));
vi.mock('@main/core/sessions/operations/save-provider-session-id', () => ({
  saveNativeSessionId: vi.fn(),
}));
vi.mock('@main/core/sessions/session-hooks', () => ({ sessionHooks: { _emit: vi.fn() } }));
vi.mock('@main/core/agent-hooks/notification', () => ({
  isAppFocused: () => true,
  maybeShowNotification: vi.fn(),
}));
vi.mock('@main/core/agent-hooks/agent-hook-service', () => ({
  agentHookService: { emitAgentEvent: vi.fn() },
}));

const { ProviderAgentRuntime } = await import('./provider-agent-runtime');

function runtime(sessionId: string) {
  return new ProviderAgentRuntime({
    locationId: 'loc-1',
    sessionId,
    sessionPath: '/repo',
    sessionEnvVars: {},
  });
}

describe('ProviderAgentRuntime transcript updates', () => {
  it('emits them on the session topic the renderer subscribes to', () => {
    // The renderer's store listens per session (`session:transcript.<id>`), so
    // an untopic'd emit reaches nobody: the panel showed the snapshot it opened
    // with and never moved again, while the session ran to completion.
    runtime('session-1').notice('info', 'hello');

    expect(emit).toHaveBeenCalledTimes(1);
    const [channel, payload, topic] = emit.mock.calls[0] as [
      unknown,
      { sessionId: string },
      string,
    ];
    expect(channel).toBe(sessionTranscriptChannel);
    expect(payload.sessionId).toBe('session-1');
    expect(topic).toBe('session-1');
  });
});

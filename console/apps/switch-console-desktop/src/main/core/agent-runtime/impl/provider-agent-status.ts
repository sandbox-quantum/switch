import type { ProviderRuntimeEvent } from '@switch-console/agent-providers';
import type { AgentEvent } from '@shared/core/providers/agentEvents';

/**
 * Map a provider event onto the hook-shaped `AgentEvent` the rest of the app
 * already reacts to, or null when it carries no status signal.
 *
 * A PTY session reports its status by calling Switch Console's hook server; a
 * provider session has no hooks and no TUI, but the same four moments exist in
 * its event stream. Translating here rather than deriving a second status
 * vocabulary is what keeps the sidebar badge, the attention sound, the DB
 * column and the room's "working on it…" working with no changes of their own:
 * every one of them is downstream of `agentHookService.emitAgentEvent`.
 *
 * Pure, for the same reason `deriveAgentStatus` is — it is the half of this
 * that can be asserted without an Electron app around it.
 */
export function toAgentEvent(
  event: ProviderRuntimeEvent,
  params: { sessionId: string; providerId: string }
): AgentEvent | null {
  const base = {
    source: 'hook' as const,
    providerId: params.providerId,
    sessionId: params.sessionId,
    timestamp: Date.parse(event.createdAt) || Date.now(),
  };

  switch (event.type) {
    case 'turn.started':
      return { ...base, type: 'start', payload: {} };
    case 'turn.completed':
      // An errored turn is an error, not a completion: it is the difference
      // between the sidebar going quiet and the sidebar asking for attention.
      return event.outcome === 'error'
        ? {
            ...base,
            type: 'error',
            payload: { message: event.message ?? 'The turn failed.' },
          }
        : { ...base, type: 'stop', payload: {} };
    case 'request.opened':
      return {
        ...base,
        type: 'notification',
        payload: {
          notificationType: 'permission_prompt',
          title: event.title,
          ...(event.detail !== undefined ? { message: event.detail } : {}),
        },
      };
    case 'user-input.requested':
      return {
        ...base,
        type: 'notification',
        payload: {
          notificationType: 'elicitation_dialog',
          title: event.questions[0]?.header ?? 'The agent has a question',
          ...(event.questions[0] ? { message: event.questions[0].question } : {}),
        },
      };
    case 'runtime.error':
      return { ...base, type: 'error', payload: { message: event.message } };
    case 'session.exited':
      // The session is over, not stuck: report it as done so a room stops
      // saying "working on it" and the badge clears. The reason travels with
      // the exit event itself, which is logged and shown in the transcript.
      return { ...base, type: 'stop', payload: { message: event.reason } };
    default:
      return null;
  }
}

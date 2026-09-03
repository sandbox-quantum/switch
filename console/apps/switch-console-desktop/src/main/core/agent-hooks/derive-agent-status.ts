import {
  isAttentionNotification,
  type AgentEvent,
  type AgentStatus,
} from '@shared/core/providers/agentEvents';

/**
 * Map a raw agent hook event onto the coarse session status Switch Console tracks,
 * or null when the event carries no status signal. Pure and dependency-free so
 * both the local hook service and the remote sidecar derive status identically.
 */
export function deriveAgentStatus(event: AgentEvent): AgentStatus | null {
  if (event.type === 'start') return 'working';
  if (event.type === 'stop') return 'completed';
  if (event.type === 'error') return 'error';
  if (event.type === 'notification') {
    const nt = event.payload.notificationType;
    if (!nt) return null;
    if (isAttentionNotification(nt)) return 'awaiting-input';
  }
  return null;
}

/**
 * The reason line for an `error` event, for surfacing on the bridged channel
 * beside the session deeplink. Undefined for every other event, and for an
 * error the provider reported without any detail. Pure, for the same reason
 * `deriveAgentStatus` is.
 */
export function deriveErrorDetail(event: AgentEvent): string | undefined {
  if (event.type !== 'error') return undefined;
  const message = event.payload.message?.trim();
  return message ? message : undefined;
}

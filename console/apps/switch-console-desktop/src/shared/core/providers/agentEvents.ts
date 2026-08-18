import { defineEvent } from '@shared/lib/ipc/events';

export type AgentEventType = 'notification' | 'stop' | 'error' | 'start';

export type AgentStatus = 'idle' | 'working' | 'awaiting-input' | 'error' | 'completed';

export type NotificationType =
  | 'permission_prompt'
  | 'idle_prompt'
  | 'auth_success'
  | 'elicitation_dialog'
  /**
   * The session never reported that it started. Raised by Switch Console
   * itself, not by the agent — a CLI stopped on its own first-run prompt has
   * nothing to send. See session-startup-watch.
   */
  | 'startup_prompt';

export const ATTENTION_NOTIFICATION_TYPES: ReadonlySet<NotificationType> = new Set([
  'permission_prompt',
  'idle_prompt',
  'elicitation_dialog',
  'startup_prompt',
]);

export function isAttentionNotification(nt: NotificationType | undefined): nt is NotificationType {
  return nt != null && ATTENTION_NOTIFICATION_TYPES.has(nt);
}

export interface AgentEvent {
  type: AgentEventType;
  source?: 'hook' | 'input';
  ptyId?: string;
  providerId?: string;
  sessionId: string;
  timestamp: number;
  payload: {
    notificationType?: NotificationType;
    title?: string;
    message?: string;
    lastAssistantMessage?: string;
  };
}

export type SoundEvent = 'needs_attention' | 'session_complete';

export interface AgentSessionExited {
  sessionId: string;
}

/** Emitted when an agent PTY session exits. Topic = sessionId. */
export const agentSessionExitedChannel = defineEvent<AgentSessionExited>('agent:session-exited');

export const HOOK_EVENTS = [
  'notification',
  'stop',
  'session',
  'start',
  'tool-use',
  'tool-done',
  'tool-use-failure',
  'subagent',
  'subagent-done',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export type HookRegistration = {
  event: string;
  command: string;
};

export type NotificationType =
  | 'permission_prompt'
  | 'idle_prompt'
  | 'auth_success'
  | 'elicitation_dialog';

/**
 * Normalised hook event produced by a plugin's parseHookEvent method.
 *
 * - kind: 'status'   — maps to an agent lifecycle event (start/stop/error/notification)
 * - kind: 'session'  — carries a provider session id to persist on the session
 * - kind: 'activity' — a short line describing what the running turn is doing
 *                      right now (e.g. a tool call); surfaced as incremental
 *                      progress while the coarse status stays 'working'
 * - kind: 'ignore'   — event should be silently dropped
 */
export type CanonicalHookEvent =
  | {
      kind: 'status';
      type: 'start' | 'stop' | 'error' | 'notification';
      notificationType?: NotificationType;
      title?: string;
      message?: string;
      lastAssistantMessage?: string;
    }
  | { kind: 'session'; providerSessionId: string }
  | { kind: 'activity'; detail: string }
  | { kind: 'ignore' };

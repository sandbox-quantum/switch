import type { CanonicalHookEvent, NotificationType } from '../capabilities/hooks-types';

const NOTIFICATION_TYPES = new Set<string>([
  'permission_prompt',
  'idle_prompt',
  'auth_success',
  'elicitation_dialog',
]);

function asNotificationType(value: unknown): NotificationType | undefined {
  return typeof value === 'string' && NOTIFICATION_TYPES.has(value)
    ? (value as NotificationType)
    : undefined;
}

/**
 * The human-readable reason a turn died, from a stop-failure body: the provider
 * stamps an `error_type` (`authentication_failed`, `rate_limit`, `billing_error`,
 * `server_error`, …) alongside a message. Either may be absent, so fall back to
 * a generic phrase rather than surfacing an empty error.
 */
function stopFailureDetail(body: Record<string, unknown>): string {
  const type = typeof body.error_type === 'string' ? body.error_type.trim() : '';
  const raw = typeof body.error_message === 'string' ? body.error_message.trim() : '';
  const message = raw.replace(/\s+/g, ' ').slice(0, 300);
  if (type && message) return `${type} — ${message}`;
  return type || message || 'the turn ended on an error';
}

/** Extract the first non-empty string from a list of candidates. */
export function extractProviderSessionId(body: Record<string, unknown>): string | undefined {
  const candidates = [
    body.session_id,
    body.provider_session_id,
    body.providerSessionId,
    body.sessionId,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

/**
 * Generic hook event parser used as the fallback for providers that do not
 * supply a custom parseHookEvent. Implements the superset of mappings that
 * were previously hard-coded in the desktop's normalizePayload / session-hook
 * handlers.
 *
 * Event-type routing:
 *  'session' | 'session-start' → kind: 'session' (if a session id is present)
 *  'start' | 'stop' | 'error'  → kind: 'status' with the matching type
 *  'notification'               → kind: 'status', type: 'notification', reads
 *                                 notification_type / notificationType from body
 *  everything else              → kind: 'ignore'
 */
export function defaultHookEventParser(
  eventType: string,
  body: Record<string, unknown>
): CanonicalHookEvent {
  if (eventType === 'session' || eventType === 'session-start') {
    const providerSessionId = extractProviderSessionId(body);
    if (providerSessionId) return { kind: 'session', providerSessionId };
    return { kind: 'ignore' };
  }

  if (eventType === 'stop-failure') {
    return {
      kind: 'status',
      type: 'error',
      title: typeof body.error_type === 'string' ? body.error_type : undefined,
      message: stopFailureDetail(body),
    };
  }

  if (eventType === 'start' || eventType === 'stop' || eventType === 'error') {
    const rawLam = body.last_assistant_message ?? body.lastAssistantMessage;
    return {
      kind: 'status',
      type: eventType,
      lastAssistantMessage: typeof rawLam === 'string' ? rawLam : undefined,
      title: typeof body.title === 'string' ? body.title : undefined,
      message: typeof body.message === 'string' ? body.message : undefined,
    };
  }

  if (eventType === 'notification') {
    return {
      kind: 'status',
      type: 'notification',
      notificationType: asNotificationType(body.notification_type ?? body.notificationType),
      lastAssistantMessage:
        typeof (body.last_assistant_message ?? body.lastAssistantMessage) === 'string'
          ? String(body.last_assistant_message ?? body.lastAssistantMessage)
          : undefined,
      title: typeof body.title === 'string' ? body.title : undefined,
      message: typeof body.message === 'string' ? body.message : undefined,
    };
  }

  return { kind: 'ignore' };
}

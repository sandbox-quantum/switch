import type { Session } from '@shared/core/sessions/sessions';

/** Droid `--resume` needs the provider-native session UUID, not the Switchdash session id. */
export function resolveAgentSessionCommandArgs(
  session: Session,
  isResuming: boolean,
  options: { requireProviderSessionId?: boolean } = {}
): { sessionId: string; isResuming: boolean } {
  if ((session.providerId === 'codex' || session.providerId === 'droid') && isResuming) {
    if (session.providerSessionId) {
      return { sessionId: session.providerSessionId, isResuming: true };
    }
    if (options.requireProviderSessionId === false) {
      return { sessionId: session.id, isResuming };
    }
    return { sessionId: session.id, isResuming: false };
  }

  return { sessionId: session.id, isResuming };
}

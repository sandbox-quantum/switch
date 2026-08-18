import type { Session } from '@shared/core/sessions/sessions';

/**
 * Providers whose resume takes the provider-native session id rather than the
 * Switch Console session id.
 *
 * For these, resuming without a captured provider session id must fall back to
 * starting a fresh session. The alternative is worse than it looks: their
 * resume-without-an-id flag reattaches to whatever the *last* session in that
 * directory was, which for a Switch agent means silently picking up an
 * unrelated conversation — possibly another agent's.
 *
 * Several other providers also declare `sessionIdOnResumeOnly` and are not
 * listed here. Whether they have the same problem has not been established, so
 * they are deliberately left as they are rather than changed untested.
 */
const RESUME_NEEDS_PROVIDER_SESSION_ID = new Set(['codex', 'droid', 'opencode']);

export function resolveAgentSessionCommandArgs(
  session: Session,
  isResuming: boolean,
  options: { requireProviderSessionId?: boolean } = {}
): { sessionId: string; isResuming: boolean } {
  if (RESUME_NEEDS_PROVIDER_SESSION_ID.has(session.providerId) && isResuming) {
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

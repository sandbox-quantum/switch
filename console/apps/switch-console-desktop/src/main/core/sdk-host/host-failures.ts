import { sharedSessionRoot } from '@switch-console/agent-providers';
import { localSessionLinks } from './local-host';

/**
 * Why each remote session's host last stopped on a failure, as the agent's
 * sidecar pushed it to Console while the session was open here. A local
 * session's is held by Console's own end of the host's pipe.
 */
const remote = new Map<string, string>();

/** The sidecar said the session's host failed (a message) or came up again (null). */
export function recordRemoteHostFailure(sessionId: string, failure: string | null): void {
  if (failure === null) remote.delete(sessionId);
  else remote.set(sessionId, failure);
}

/** Why the session's host last stopped on a failure, or null if it has not since it last started. */
export function hostFailure(sessionId: string): string | null {
  return localSessionLinks.failure(sharedSessionRoot(sessionId)) ?? remote.get(sessionId) ?? null;
}

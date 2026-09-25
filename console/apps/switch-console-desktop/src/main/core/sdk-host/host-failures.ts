import { sharedSessionRoot } from '@switch-console/agent-providers';
import { sessionRuntimeManager } from '@main/core/sessions/session-runtime-manager';
import { events } from '@main/lib/events';
import { sessionIssueChangedChannel } from '@shared/core/sessions/sessionEvents';
import { localSessionLinks } from './local-host';

/**
 * Why each remote session's host last stopped on a failure, as the agent's
 * sidecar pushed it to Console while the session was open here. A local
 * session's is held by Console's own end of the host's pipe.
 */
const remote = new Map<string, string>();

/** Session ids by state root, for telling the renderer about a local host's failure. */
const sessionsByRoot = new Map<string, string>();

/** Tell every window that this session's health may have changed. */
export function announceSessionIssue(sessionId: string): void {
  events.emit(sessionIssueChangedChannel, { sessionId }, sessionId);
}

let listening = false;

/** Start announcing local host failures and recoveries, once the sidebar asks. */
function listenForLocalHosts(): void {
  if (listening) return;
  listening = true;
  const announceRoot = (root: string) => {
    const sessionId = sessionsByRoot.get(root);
    if (sessionId) announceSessionIssue(sessionId);
  };
  localSessionLinks.onFailure(announceRoot);
  localSessionLinks.onReady(announceRoot);
}

/** The sidecar said the session's host failed (a message) or came up again (null). */
export function recordRemoteHostFailure(sessionId: string, failure: string | null): void {
  if (remote.get(sessionId) === (failure ?? undefined)) return;
  if (failure === null) remote.delete(sessionId);
  else remote.set(sessionId, failure);
  announceSessionIssue(sessionId);
}

/** Why the session's host last stopped on a failure, or null if it has not since it last started. */
export function hostFailure(sessionId: string): string | null {
  return localSessionLinks.failure(sharedSessionRoot(sessionId)) ?? remote.get(sessionId) ?? null;
}

/**
 * Where the session's startup is, as the open session view shows it: Console's
 * own start while it runs or once it failed, and otherwise a failure the
 * session's host recorded — which is also how a session the room watcher
 * started, and Console did not, shows that it could not start.
 */
export function sessionStartupStatus(
  sessionId: string
): { status: 'starting' | 'ready' | 'error'; message: string | null } | null {
  const started = sessionRuntimeManager.getAgent(sessionId)?.startupStatus?.() ?? null;
  if (started && started.status !== 'ready') return started;
  const failure = hostFailure(sessionId);
  if (failure !== null) return { status: 'error', message: `Shared SDK host failed: ${failure}` };
  return started;
}

/**
 * What is wrong with a session right now, in a sentence, or null: its start
 * failed or its host stopped on a failure. The sidebar marks such a session.
 */
export function sessionIssue(sessionId: string): string | null {
  listenForLocalHosts();
  sessionsByRoot.set(sharedSessionRoot(sessionId), sessionId);
  const status = sessionStartupStatus(sessionId);
  return status?.status === 'error' ? (status.message ?? 'The session failed.') : null;
}

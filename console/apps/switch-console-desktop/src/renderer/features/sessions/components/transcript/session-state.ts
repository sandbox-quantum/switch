import type { Session } from '@switch-console/shared/session-v1';

export type SessionStateTone = 'ready' | 'busy' | 'bad' | 'idle';

/**
 * Whether a cloud session is down only in a way the next message repairs:
 * sending restarts it and delivers the message, so its being offline is not
 * the user's concern and is not shown.
 */
export function restartsOnSend(
  session: Pick<Session, 'connectivity' | 'retired' | 'status'>
): boolean {
  return (
    session.connectivity === 'offline' &&
    !session.retired &&
    session.status !== 'stopped' &&
    session.status !== 'error'
  );
}

/**
 * The one reading of a session's state, for the pill beside its name.
 *
 * Status and reachability used to sit at opposite ends of the header — the
 * provider and its status on the left, "Connected" or "Offline" on the right —
 * which asked the reader to combine them. They are folded here because only one
 * of them is ever the answer: a session cannot be meaningfully "ready" on a host
 * Console cannot reach, so when reachability is the problem it is the state.
 */
export function sessionStatePill(input: {
  /** An action Console is running now: stop, resume, restart or start. */
  action: 'stop' | 'resume' | 'restart' | 'start' | null;
  elapsedSeconds: number;
  /**
   * The host's own state when it cannot be asked, such as a sleeping cloud
   * worker. The session's last reported status is stale then, so this is shown
   * instead.
   */
  host: { label: string; tone: SessionStateTone } | null;
  failed: boolean;
  retired: boolean;
  /** The session's own status, as the server last reported it. */
  status: string | null;
  connectivity: 'online' | 'offline' | null;
  /** Whether Console currently holds a live view of the session. */
  reachable: boolean;
  /** Whether the next message restarts the session, so its being unreachable goes unsaid. */
  startable: boolean;
}): { label: string; tone: SessionStateTone } | null {
  if (input.action)
    return {
      label: `${{ stop: 'stopping', resume: 'resuming', restart: 'restarting', start: 'starting' }[input.action]} ${input.elapsedSeconds}s`,
      tone: 'busy',
    };
  if (input.host) return input.host;
  if (input.failed) return { label: 'connection failed', tone: 'bad' };
  if (input.retired) return { label: 'retired', tone: 'idle' };
  if (input.status === 'stopped') return { label: 'stopped', tone: 'idle' };
  if (input.status === 'starting' && input.connectivity === 'online')
    return { label: 'connecting…', tone: 'busy' };
  if (!input.reachable) return input.startable ? null : { label: 'offline', tone: 'bad' };
  if (input.status === null) return { label: 'loading', tone: 'idle' };
  return { label: input.status, tone: input.status === 'error' ? 'bad' : 'ready' };
}

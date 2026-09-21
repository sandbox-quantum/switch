export type SessionStateTone = 'ready' | 'busy' | 'bad' | 'idle';

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
  failed: boolean;
  retired: boolean;
  /** The session's own status, as the server last reported it. */
  status: string | null;
  connectivity: 'online' | 'offline' | null;
  /** Whether Console currently holds a live view of the session. */
  reachable: boolean;
}): { label: string; tone: SessionStateTone } {
  if (input.action)
    return {
      label: `${{ stop: 'stopping', resume: 'resuming', restart: 'restarting', start: 'starting' }[input.action]} ${input.elapsedSeconds}s`,
      tone: 'busy',
    };
  if (input.failed) return { label: 'connection failed', tone: 'bad' };
  if (input.retired) return { label: 'retired', tone: 'idle' };
  if (input.status === 'stopped') return { label: 'stopped', tone: 'idle' };
  if (input.status === 'starting' && input.connectivity === 'online')
    return { label: 'connecting…', tone: 'busy' };
  if (!input.reachable) return { label: 'offline', tone: 'bad' };
  if (input.status === null) return { label: 'loading', tone: 'idle' };
  return { label: input.status, tone: input.status === 'error' ? 'bad' : 'ready' };
}

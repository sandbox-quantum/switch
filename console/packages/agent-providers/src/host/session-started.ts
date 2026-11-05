import { hostStartSources, type OwedSessionStart } from './session-start';

/**
 * The agent controller telling the process that runs it, over its IPC
 * channel, that a session of one of its agents has started and Switch has
 * taken the report (`host/session-start.ts`).
 *
 * Switch Console listens on the controller it runs on its own computer, and
 * counts the session in its usage data under its own consent gate. Nothing
 * else hears it: a controller on an SSH host or run headless has no parent
 * listening, so its sessions reach only the Switch server they work for.
 */
export const SESSION_STARTED_KIND = 'switch-session-started';

export type SessionStartedNotice = {
  kind: typeof SESSION_STARTED_KIND;
  /** Lets the listener count a start the host reported twice once. Never sent on. */
  sessionId: string;
  /** The agent's provider, as its definition names it. */
  provider: string;
  startSource: OwedSessionStart;
};

const START_SOURCES: readonly string[] = [...hostStartSources, 'unknown'];

export function isSessionStartedNotice(raw: unknown): raw is SessionStartedNotice {
  if (typeof raw !== 'object' || raw === null) return false;
  const notice = raw as Partial<Record<keyof SessionStartedNotice, unknown>>;
  return (
    notice.kind === SESSION_STARTED_KIND &&
    typeof notice.sessionId === 'string' &&
    typeof notice.provider === 'string' &&
    reportedStartSource(notice.startSource) !== null
  );
}

/** The start source a session host reported, or null when it is not one. */
export function reportedStartSource(raw: unknown): OwedSessionStart | null {
  return typeof raw === 'string' && START_SOURCES.includes(raw) ? (raw as OwedSessionStart) : null;
}
